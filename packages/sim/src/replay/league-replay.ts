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
  silentLogger,
  createServices,
  recurringJobs,
  serverSubscribers,
  storedNflState,
  type BusEvent,
  type JobDeps,
  type JobName,
  type League,
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
  'officialFinal',
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
  // Postseason games are weeks 19+, so keying by week keeps them apart.
  for (const g of archive.schedule) {
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
  const lastArchived = Math.min(17, Math.max(...archiveWeeks));
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
  // Every archived week has games (the archive builder derives its weeks from the schedule).
  const momentOf = (week: number) => moments.get(week) as NonNullable<ReturnType<typeof moments.get>>;

  // The world: the simulated clock, the guarded archive, and the league's own services.
  const clock = new SimClock([], new Date(momentOf(startWeek).projectionsAt + MINUTE_MS));
  const audit = readAudit(archive);
  const provider = new AsOfGuardedProvider(
    new HistoricalDataProvider(new InMemoryArchiveStore([toSeasonArchive(archive)])),
    clock,
    { anonymizePlayers: options.anonymizePlayers ?? false, anonymizeSeed: seed, onRead: audit.onRead }
  );
  const repos = createInMemoryRepos();
  const reference = createInMemoryReferenceStore(repos.players);
  const events = new InMemoryEventPublisher();
  const log = silentLogger;
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
    // ingestNews is not among REPLAY_JOBS: the archive has no news.
    news: NO_NEWS
  };

  // Who acts: the human stand-in, the agents, and the league's own handlers.
  const run = operationRunner(services);
  const human = new HumanStandIn(HUMAN, 'team-1', run, services);
  const model = options.model ?? new ScriptedModelClient();
  const finals = new Map<number, number>();
  const officials = new Map<number, number>();
  const checks = new Map<number, ReplayCheck[]>();
  let league: League | null = null;
  const weekFinal = async (event: BusEvent): Promise<void> => {
    // Only the replay's own league exists, and advanceLeague always sends its week.
    const { week } = event.detail as { week: number };
    const current = (await repos.leagues.get((league as League).id)) as League;
    finals.set(week, (finals.get(week) ?? 0) + 1);
    checks.set(week, [
      ...(await checkRosters(repos, current, week)),
      await checkWeekScored(repos, current.id, week, finals.get(week) as number),
      await checkStandings(repos, current.id),
      await checkNoFutureData(reference, season, week, teamKickoffs(archive), audit.takeFuture())
    ]);
  };
  // Thursday's official final may correct scores: the standings must still match the games.
  const weekOfficial = async (event: BusEvent): Promise<void> => {
    const { week } = event.detail as { week: number };
    officials.set(week, (officials.get(week) ?? 0) + 1);
    const standings = await checkStandings(repos, (league as League).id);
    if (!standings.ok) checks.get(week)?.push(standings);
  };
  const loop = new EventLoop({
    publisher: events,
    clock,
    subscribers: [
      ...serverSubscribers(services),
      ...agentSubscribers(inProcessAgentDeps(services, model)),
      human.subscriber(),
      { name: 'replay-audit', detailTypes: ['Week Provisionally Final'], handle: weekFinal },
      { name: 'replay-audit-official', detailTypes: ['Week Official Final'], handle: weekOfficial }
    ],
    jobs: recurringJobs(jobDeps, clock, REPLAY_JOBS, options.jobCadences),
    log
  });
  const failures = loop.stats.failures;

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
  /* v8 ignore next 5 -- a stalled draft (a handler failing on its turn) is reported, not waited on */
  if (draft?.status !== 'complete') {
    throw new SimulationError(
      `The draft did not finish: ${draft?.state.picks.length ?? 0} picks made. Loop failures: ${failures.map((f) => `${f.handler}: ${String(f.error)}`).join('; ')}`
    );
  }
  league = (await repos.leagues.get(league.id)) as League;
  human.join(league);
  const timings: WeekTiming[] = [
    {
      week: null,
      label: 'draft',
      wallMs: Math.round(performance.now() - draftStart),
      simTo: clock.now().toISOString()
    }
  ];

  // The season: every week runs past its Thursday official final (15:00 UTC, after stat corrections).
  for (const week of playedWeeks) {
    const t0 = performance.now();
    const delivered = totalDelivered(loop);
    await loop.runUntil(new Date(momentOf(week).correctionsAt + OFFICIAL_MARGIN_MS));
    timings.push({
      week,
      label: weeks.value.playoffs.includes(week) ? 'playoffs' : 'regular',
      wallMs: Math.round(performance.now() - t0),
      simTo: clock.now().toISOString(),
      events: totalDelivered(loop) - delivered
    });
    // A week that never went final fails `week_scored_once` (its other checks never ran).
    const board = checks.get(week) ?? [
      { name: 'week_scored_once' as const, ok: false, violations: [`week ${week} never went final`] }
    ];
    checks.set(week, board);
    const bad = board.filter((c) => !c.ok).map((c) => c.name);
    options.log?.(`week ${week}: invariants ${bad.join(', ') || 'ok'} (${timings.at(-1)?.wallMs} ms)`);
  }

  const final = (await repos.leagues.get(league.id)) as League;
  const standings = (await repos.schedule.latestStandings(final.id))?.rows ?? [];
  // Every week goes official exactly once, and the stored champion is the one the games give.
  for (const week of playedWeeks) {
    const n = officials.get(week) ?? 0;
    if (n !== 1) addViolation(checks, week, 'week_scored_once', `week ${week} went official ${n} times`);
  }
  const champion = (await repos.history.getPlayoffs(final.id))?.championTeamId ?? null;
  const fromGames = await championOf(services, final, standings, weeks.value.playoffs);
  if (champion !== fromGames) {
    addViolation(
      checks,
      playedWeeks.at(-1) as number,
      'standings_match',
      `the stored champion is ${champion}, but the playoff games give ${fromGames}`
    );
  }
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
    champion,
    timings,
    dataAccess: {
      reads: audit.reads,
      byMethod: audit.byMethod,
      futureAccessAttempts: provider.blockedAttempts
    },
    model: model.name,
    wallMs: Math.round(performance.now() - started)
  });
}

/** How far past a week's stat-correction moment (Thursday 12:15 UTC or so) it runs: past the 15:00 official final. */
const OFFICIAL_MARGIN_MS = 12 * 3_600_000;

/** Records a violation found after a week's checks ran. */
export function addViolation(
  checks: Map<number, ReplayCheck[]>,
  week: number,
  name: ReplayInvariant,
  message: string
): void {
  const list = checks.get(week) ?? [];
  const found = list.find((c) => c.name === name);
  if (found === undefined) list.push({ name, ok: false, violations: [message] });
  else {
    found.ok = false;
    found.violations.push(message);
  }
  checks.set(week, list);
}

const NO_NEWS: JobDeps['news'] = {
  /* v8 ignore next 2 -- never called: ingestNews does not run in a replay */
  feeds: () => Promise.resolve([]),
  fetchText: () => Promise.resolve('')
};

/**
 * Counts every archive read and audits it against the archive (`auditRead`): stats, scores, or
 * projections served before they existed. `takeFuture` returns the findings not yet reported.
 */
export function readAudit(archive: SimArchive) {
  const kickoffOf = archiveKickoffs(archive);
  const future: string[] = [];
  let reported = 0;
  const audit = {
    reads: 0,
    byMethod: {} as Record<string, number>,
    onRead(read: DataRead): void {
      audit.reads++;
      audit.byMethod[read.method] = (audit.byMethod[read.method] ?? 0) + 1;
      for (const v of auditRead(read, archive, kickoffOf)) future.push(`${read.asOf}: ${v.message}`);
    },
    takeFuture(): string[] {
      const out = future.slice(reported);
      reported = future.length;
      return out;
    }
  };
  return audit;
}

function totalDelivered(loop: EventLoop): number {
  return Object.values(loop.stats.delivered).reduce((a, b) => a + b, 0);
}

/**
 * The champion from the stored games: the bracket seeded from the final standings and advanced by
 * each playoff week's final games (core `buildBracket` / `advanceBracket`, as the season cycle pairs
 * them). Null when the league did not finish its playoffs.
 */
export async function championOf(
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
