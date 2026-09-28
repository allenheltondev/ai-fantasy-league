import { performance } from 'node:perf_hooks';
import {
  advanceBracket,
  buildBracket,
  champion as bracketChampion,
  hashString,
  leagueWeeks,
  seedPlayoffs,
  seededRandom,
  seededShuffle,
  type LeagueSettings,
  type StandingsRow
} from '@fantasy/core';
import { HistoricalDataProvider, InMemoryArchiveStore } from '@fantasy/data';
import { ScriptedModelClient, agentSubscribers, inProcessAgentDeps, type ModelClient } from '@fantasy/agents';
import {
  EventLoop,
  InMemoryEventPublisher,
  JOBS,
  createInMemoryReferenceStore,
  createInMemoryRepos,
  createLogger,
  createServices,
  recurringJobs,
  serverSubscribers,
  storedNflState,
  type BusEvent,
  type JobDeps,
  type JobName,
  type League,
  type LoopFailure,
  type Principal,
  type Services
} from '@fantasy/server';
import type { SimArchive } from '../archive/format.js';
import { toSeasonArchive } from '../archive/season-archive.js';
import { MINUTE_MS, draftMoment, weekMoments } from '../clock/moments.js';
import { SimClock } from '../clock/sim-clock.js';
import { AsOfGuardedProvider, type DataRead } from '../guard/guard.js';
import { archiveKickoffs, auditRead } from '../runner/invariants.js';
import { SimulationError } from '../runner/run-season.js';
import { replaySettings } from '../runner/settings.js';
import {
  REPLAY_INVARIANTS,
  checkNoFutureData,
  checkRosters,
  checkStandings,
  checkWeekScored,
  type ReplayCheck,
  type ReplayInvariant,
  type TeamKickoff
} from './checks.js';
import { HumanStandIn, dataOf, operationRunner } from './human.js';
import { buildLeagueReport, type LeagueReplayReport, type WeekTiming } from './report.js';

/**
 * Replays a season through the real league (issues #60, #62): the server's operations, jobs, and
 * event handlers, and the agents' router and task runner, all on the simulated clock.
 *
 * - The data jobs (player sync, NFL state, schedule, live stats, projections, trending) read the
 *   season archive through the as-of guard and fill the league's reference store, exactly as they
 *   fill it from Sleeper and nflverse in production. Handlers and agents read only that store.
 * - An `EventLoop` delivers every event the league publishes to the same handler functions the
 *   Lambdas run, releases deferred events (pick deadlines, lineup-lock warnings) when the clock
 *   reaches them, and runs every job on its production cadence (`JOB_SCHEDULE_EXPRESSIONS`).
 * - A scripted human stand-in holds seat 1 and commissions the league; the other seats are agents on
 *   the given model (the scripted fake model by default).
 *
 * The clock only moves forward. Invariants are checked each time a week goes provisionally final.
 */

export interface LeagueReplayOptions {
  archive: SimArchive;
  /** Seeds the draft order and the league's ids; the same seed and archive give the same league. */
  seed: string | number;
  /** Teams (default 8): seat 1 is the human stand-in, the rest are agents. */
  teamCount?: number;
  /** The league's first week (a mid-season start when later than the archive's first week). */
  startWeek?: number;
  /** League weeks to play from `startWeek`, playoffs included (default: through week 17 or the archive's end). */
  weeks?: number;
  /** Override the derived settings (see `replaySettings`). */
  settings?: LeagueSettings;
  /** The agents' model (default: the scripted fake model, no Bedrock calls). */
  model?: ModelClient;
  /** Serve pseudonymous player names (docs/sim.md). */
  anonymizePlayers?: boolean;
  /** Replace job cadences (e.g. `{ ingestStats: 'rate(10 minutes)' }`) for faster long replays. */
  jobCadences?: Partial<Record<JobName, string>>;
  /** Progress lines (one per week). */
  log?: (line: string) => void;
}

/** The jobs the replay runs. `ingestNews` is left out: the archive has no news. */
export const REPLAY_JOBS: readonly JobName[] = [
  'syncNflState',
  'syncSchedule',
  'syncPlayers',
  'ingestStats',
  'ingestProjections',
  'ingestTrending',
  'advanceSeason',
  'scoreLiveWeek',
  'processWaivers'
];

/** The jobs a fresh deployment runs once before anyone creates a league. */
const BOOTSTRAP_JOBS: readonly JobName[] = [
  'syncNflState',
  'syncSchedule',
  'syncPlayers',
  'ingestProjections',
  'ingestTrending'
];

export const HUMAN: Principal = {
  type: 'user',
  sub: 'sim-human',
  email: 'stand-in@sim.invalid',
  name: 'Stand-in'
};

/** Deterministic record ids: the league id seeds its schedule, so a seed must always give the same one. */
function seededIds(seed: string): { uuid(): string } {
  const prefix = `sim-${hashString(seed).toString(36)}`;
  let n = 0;
  return { uuid: () => `${prefix}-${String(++n).padStart(5, '0')}` };
}

function teamKickoffs(archive: SimArchive): TeamKickoff {
  const kickoffs = new Map<string, number>();
  for (const g of archive.schedule) {
    if (g.seasonType !== 'regular') continue;
    kickoffs.set(`${g.week}:${g.homeTeam}`, Date.parse(g.kickoff));
    kickoffs.set(`${g.week}:${g.awayTeam}`, Date.parse(g.kickoff));
  }
  return (team, week) => kickoffs.get(`${week}:${team}`) ?? null;
}

export async function replayLeague(options: LeagueReplayOptions): Promise<LeagueReplayReport> {
  const started = performance.now();
  const { archive } = options;
  const seed = String(options.seed);
  const season = archive.manifest.season;
  const archiveWeeks = archive.manifest.weeks;
  const startWeek = options.startWeek ?? (archiveWeeks[0] as number);
  const lastArchived = Math.min(17, archiveWeeks[archiveWeeks.length - 1] ?? 0);
  const lastWeek = options.weeks !== undefined ? startWeek + options.weeks - 1 : lastArchived;
  if (!archiveWeeks.includes(startWeek) || lastWeek > lastArchived) {
    throw new SimulationError(
      `The archive covers weeks ${archiveWeeks.join(', ')}; weeks ${startWeek}-${lastWeek} are not all available.`
    );
  }
  const teamCount = options.teamCount ?? 8;
  const settings = options.settings ?? replaySettings(teamCount, startWeek, lastWeek);
  const weeks = leagueWeeks(settings);
  if (!weeks.ok) throw new SimulationError(weeks.issues.map((i) => i.message).join(' '));
  const playedWeeks = [...weeks.value.regularSeason, ...weeks.value.playoffs];
  const moments = weekMoments(archive.schedule);
  const momentOf = (week: number) => {
    const m = moments.get(week);
    if (m === undefined) throw new SimulationError(`The schedule has no games in week ${week}.`);
    return m;
  };

  // The world: the simulated clock, the guarded archive, and the league's own services.
  const clock = new SimClock([], new Date(momentOf(startWeek).projectionsAt + MINUTE_MS));
  const kickoffOf = archiveKickoffs(archive);
  const futureReads: { at: string; message: string }[] = [];
  const byMethod: Record<string, number> = {};
  let reads = 0;
  const onRead = (read: DataRead): void => {
    reads++;
    byMethod[read.method] = (byMethod[read.method] ?? 0) + 1;
    for (const v of auditRead(read, archive, kickoffOf)) futureReads.push({ at: read.asOf, message: v.message });
  };
  const provider = new AsOfGuardedProvider(
    new HistoricalDataProvider(new InMemoryArchiveStore([toSeasonArchive(archive)])),
    clock,
    { anonymizePlayers: options.anonymizePlayers ?? false, anonymizeSeed: seed, onRead }
  );
  const repos = createInMemoryRepos();
  const reference = createInMemoryReferenceStore(repos.players);
  const events = new InMemoryEventPublisher();
  const log = createLogger({ level: 'error', sink: () => undefined });
  const services: Services = createServices({
    clock,
    repos,
    events,
    log,
    reference,
    nflState: storedNflState(reference),
    ids: seededIds(seed),
    limits: { leaguesPerUser: 1000, unlimitedUsers: [] }
  });
  const jobDeps: JobDeps = {
    provider,
    reference,
    repos,
    events,
    directory: services.data.players,
    log,
    news: { feeds: async () => [], fetchText: async () => '' }
  };

  // Who acts: the human stand-in, the agents, and the league's own handlers.
  const run = operationRunner(services);
  const human = new HumanStandIn(HUMAN, 'team-1', run, services);
  const model = options.model ?? new ScriptedModelClient();
  const finals = new Map<number, number>();
  const checks = new Map<number, ReplayCheck[]>();
  let league: League | null = null;
  const weekFinal = async (event: BusEvent): Promise<void> => {
    const detail = event.detail as { leagueId?: string; week?: number };
    if (league === null || detail.leagueId !== league.id || typeof detail.week !== 'number') return;
    const week = detail.week;
    finals.set(week, (finals.get(week) ?? 0) + 1);
    const current = (await repos.leagues.get(league.id)) as League;
    checks.set(week, [
      ...(await checkRosters(repos, current, week)),
      await checkWeekScored(repos, league.id, week, finals.get(week) as number),
      await checkStandings(repos, league.id),
      await checkNoFutureData(
        reference,
        season,
        week,
        teamKickoffs(archive),
        futureReads.map((r) => `${r.at}: ${r.message}`)
      )
    ]);
  };
  const failures: LoopFailure[] = [];
  const loop = new EventLoop({
    publisher: events,
    clock,
    subscribers: [
      ...serverSubscribers(services),
      ...agentSubscribers(inProcessAgentDeps(services, model)),
      human.subscriber(),
      { name: 'replay-audit', detailTypes: ['Week Provisionally Final'], handle: weekFinal }
    ],
    jobs: recurringJobs(jobDeps, clock, REPLAY_JOBS, options.jobCadences),
    log,
    onFailure: (failure) => failures.push(failure)
  });

  // A fresh deployment's first job runs, then the human creates the league.
  for (const name of BOOTSTRAP_JOBS) await JOBS[name](jobDeps, clock);
  await loop.drain();
  const created = dataOf<{ id: string }>(
    await run(
      'create_league',
      {
        name: `${season} replay (${seed})`,
        teamCount,
        startWeek,
        teamName: 'Stand-in',
        settings: { schedule: settings.schedule, playoffs: settings.playoffs, trades: settings.trades }
      },
      HUMAN
    ),
    'create_league'
  );
  league = (await repos.leagues.get(created.id)) as League;
  human.join(league);

  // The draft: the human starts it at the draft moment; agents and the human pick from its events.
  const draftStart = performance.now();
  await loop.runUntil(new Date(draftMoment(momentOf(startWeek))));
  const order = seededShuffle(
    Array.from({ length: teamCount }, (_, i) => `team-${i + 1}`),
    seededRandom(`draft-order:${seed}`)
  );
  dataOf(await run('start_draft', { leagueId: league.id, order }, HUMAN), 'start_draft');
  await loop.drain();
  const draft = await repos.drafts.get(league.id);
  if (draft?.status !== 'complete') {
    throw new SimulationError(
      `The draft did not finish: ${draft?.state.picks.length ?? 0} picks made. Loop failures: ${failures.map((f) => `${f.handler}: ${String(f.error)}`).join('; ')}`
    );
  }
  league = (await repos.leagues.get(league.id)) as League;
  human.join(league);
  const timings: WeekTiming[] = [
    { week: null, label: 'draft', wallMs: Math.round(performance.now() - draftStart), simTo: clock.now().toISOString() }
  ];

  // The season: every week runs until its stat corrections are in (the week is long final by then).
  for (const week of playedWeeks) {
    const t0 = performance.now();
    const delivered = totalDelivered(loop);
    await loop.runUntil(new Date(momentOf(week).correctionsAt));
    timings.push({
      week,
      label: weeks.value.playoffs.includes(week) ? 'playoffs' : 'regular',
      wallMs: Math.round(performance.now() - t0),
      simTo: clock.now().toISOString(),
      events: totalDelivered(loop) - delivered
    });
    const board = checks.get(week);
    options.log?.(
      `week ${week}: ${board === undefined ? 'not final' : board.every((c) => c.ok) ? 'final, invariants ok' : 'final, INVARIANT VIOLATIONS'} (${timings.at(-1)?.wallMs} ms)`
    );
  }

  const final = (await repos.leagues.get(league.id)) as League;
  const unscored = playedWeeks.filter((w) => !finals.has(w));
  for (const week of unscored) {
    checks.set(week, [
      { name: 'week_scored_once', ok: false, violations: [`week ${week} never went final`] }
    ]);
  }
  const standings = (await repos.schedule.latestStandings(final.id))?.rows ?? [];
  return buildLeagueReport({
    seed,
    season,
    league: final,
    settings: final.settings,
    playedWeeks,
    playoffWeeks: weeks.value.playoffs,
    human,
    services,
    events,
    loopStats: loop.stats,
    failures,
    checks,
    standings,
    champion: await championOf(services, final, standings, weeks.value.playoffs),
    timings,
    dataAccess: { reads, byMethod, futureAccessAttempts: provider.blockedAttempts },
    model: model.name,
    wallMs: Math.round(performance.now() - started)
  });
}

function totalDelivered(loop: EventLoop): number {
  return Object.values(loop.stats.delivered).reduce((a, b) => a + b, 0);
}

/**
 * The champion from the stored games: the bracket seeded from the final standings and advanced by
 * each playoff week's final games (core `buildBracket` / `advanceBracket`, as the season cycle pairs
 * them). Null when the league did not finish its playoffs.
 */
async function championOf(
  services: Services,
  league: League,
  standings: readonly StandingsRow[],
  playoffWeeks: readonly number[]
): Promise<string | null> {
  if (league.phase !== 'complete') return null;
  const seeding = seedPlayoffs(league.settings, standings);
  if (!seeding.ok) return null;
  let bracket = buildBracket(league.settings, seeding.value.seeds);
  const matchups = await services.repos.schedule.listMatchups(league.id);
  for (const week of playoffWeeks) {
    if (!bracket.ok) return null;
    const results = matchups
      .filter((m) => m.week === week && m.kind === 'playoff' && m.status === 'final')
      .map((m) => ({
        homeTeamId: m.homeTeamId,
        awayTeamId: m.awayTeamId,
        homeScore: m.homeScore ?? 0,
        awayScore: m.awayScore ?? 0
      }));
    bracket = advanceBracket(bracket.value, { week, results });
  }
  return bracket.ok ? bracketChampion(bracket.value) : null;
}

export { REPLAY_INVARIANTS, type ReplayInvariant };
