import {
  currentPick,
  isComplete,
  leagueWeeks,
  scorePlayer,
  seededRandom,
  seededShuffle,
  type Bracket,
  type DraftablePlayer,
  type LeagueSettings,
  type RosterPlayer,
  type StandingsRow
} from '@fantasy/core';
import { HistoricalDataProvider, InMemoryArchiveStore } from '@fantasy/data';
import type { SimArchive } from '../archive/format.js';
import { toSeasonArchive } from '../archive/season-archive.js';
import { MINUTE_MS } from '../clock/moments.js';
import { SimClock } from '../clock/sim-clock.js';
import { buildTimeline, type SimEvent } from '../clock/timeline.js';
import { createCoreOnlyEngine } from '../engine/core-engine.js';
import type { LeagueEngine, LeagueEngineFactory, MatchupScore, Transaction } from '../engine/types.js';
import { AsOfGuardedProvider, type DataRead } from '../guard/guard.js';
import { toRosterPlayer, weekGames } from '../players.js';
import type { FreeAgent, TeamPolicy } from '../policy/types.js';
import {
  INVARIANT_NAMES,
  archiveKickoffs,
  auditRead,
  checkFaabConserved,
  checkLineupLocks,
  checkNoSharedPlayers,
  checkRostersValid,
  type InvariantName,
  type InvariantResult
} from './invariants.js';
import { replaySettings } from './settings.js';

export interface SimTeam {
  id: string;
  name?: string;
  policy: TeamPolicy;
}

export interface RunSeasonOptions {
  archive: SimArchive;
  teams: readonly SimTeam[];
  /** Seeds the draft order, the schedule, tiebreaks, and the bots' jitter. The same seed gives the same report. */
  seed: string | number;
  /** The engine to run against (default: `CoreOnlyEngine`). */
  engine?: LeagueEngineFactory;
  /** First league week (a mid-season start when > the archive's first week). Default: the archive's first week. */
  startWeek?: number;
  /** Weeks to replay from `startWeek`, including playoffs. Default: through the archive's last week (max 17). */
  weeks?: number;
  /** Override the derived settings (see `replaySettings`). */
  settings?: LeagueSettings;
  /** Serve pseudonymous player names to policies (docs/sim.md). */
  anonymizePlayers?: boolean;
  /** Progress lines (one per week). */
  log?: (line: string) => void;
}

export interface WeekReport {
  week: number;
  kind: 'regular' | 'playoffs';
  matchups: MatchupScore[];
  teamPoints: Record<string, number>;
  /** Invariants checked when the week went provisionally final. */
  invariants: InvariantResult[];
}

export interface SeasonReport {
  season: number;
  seed: string;
  engine: string;
  settings: {
    teamCount: number;
    startWeek: number;
    regularSeasonEndWeek: number;
    playoffWeeks: number[];
    faabBudget: number;
  };
  teams: { id: string; name: string; policy: string }[];
  draftOrder: string[];
  champion: string | null;
  standings: StandingsRow[];
  bracket: Bracket | null;
  weeks: WeekReport[];
  transactions: Transaction[];
  finalFaab: Record<string, number>;
  /**
   * Actions the engine refused (with the rule codes). A refusal is the rules working, not an invariant
   * break: scripted bots should produce none, while agent-driven teams may.
   */
  rejected: { week: number; teamId: string; action: 'set_lineup' | 'claim_waiver'; codes: string[] }[];
  /** Every invariant violation of the season (empty when the replay was clean). */
  violations: { week: number; name: InvariantName; message: string }[];
  dataAccess: { reads: number; byMethod: Record<string, number>; futureAccessAttempts: number };
  events: number;
}

/** Thrown when the replay cannot proceed (a bot made an illegal draft pick, an engine refused a phase step). */
export class SimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulationError';
  }
}

const LINEUP_LEAD_MS = MINUTE_MS;

/**
 * Replays a season headlessly: builds the timeline from the archive's schedule, steps the simulated clock
 * through every event, and has each team's policy draft, bid, and set lineups through the engine. Data
 * reaches policies and the engine only through the as-of guard. Invariants are checked every week.
 */
export async function runSeason(options: RunSeasonOptions): Promise<SeasonReport> {
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
  const settings = options.settings ?? replaySettings(options.teams.length, startWeek, lastWeek);
  const weeks = leagueWeeks(settings);
  if (!weeks.ok) throw new SimulationError(weeks.issues.map((i) => i.message).join(' '));
  const playedWeeks = [...weeks.value.regularSeason, ...weeks.value.playoffs];

  const timeline = buildTimeline(archive.schedule, { weeks: playedWeeks });
  const clock = new SimClock(timeline);
  const kickoffOf = archiveKickoffs(archive);

  const violations: SeasonReport['violations'] = [];
  const rejected: SeasonReport['rejected'] = [];
  const byMethod: Record<string, number> = {};
  let reads = 0;
  let currentWeek = startWeek;
  const onRead = (read: DataRead): void => {
    reads++;
    byMethod[read.method] = (byMethod[read.method] ?? 0) + 1;
    for (const v of auditRead(read, archive, kickoffOf)) violations.push({ week: currentWeek, ...v });
  };
  const inner = new HistoricalDataProvider(new InMemoryArchiveStore([toSeasonArchive(archive)]));
  const data = new AsOfGuardedProvider(inner, clock, {
    anonymizePlayers: options.anonymizePlayers ?? false,
    anonymizeSeed: seed,
    onRead
  });
  const engine: LeagueEngine = (options.engine ?? createCoreOnlyEngine)({ clock, data, season });

  const teams = options.teams.map((t) => ({ id: t.id, name: t.name ?? t.id, policy: t.policy }));
  const policyOf = new Map(teams.map((t) => [t.id, t.policy]));
  const draftOrder = seededShuffle(
    teams.map((t) => t.id),
    seededRandom(`draft-order:${seed}`)
  );
  await engine.createLeague({
    leagueId: `replay-${season}-${seed}`,
    settings,
    teams: teams.map(({ id, name }) => ({ id, name })),
    draftOrder,
    seed
  });

  // Views are memoized for the current instant only: policies acting at the same moment share one read.
  const memo = new Map<string, unknown>();
  let memoAt = '';
  const at = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const now = clock.now().toISOString();
    if (now !== memoAt) {
      memo.clear();
      memoAt = now;
    }
    if (!memo.has(key)) memo.set(key, await load());
    return memo.get(key) as T;
  };
  const universe = (): Promise<Map<string, RosterPlayer>> =>
    at('players', async () => new Map((await data.getPlayers()).map((p) => [p.id, toRosterPlayer(p)])));
  const projections = (week: number): Promise<Record<string, number>> =>
    at(`proj:${week}`, async () => {
      const out: Record<string, number> = {};
      for (const line of await data.getWeekProjections(season, week)) {
        out[line.playerId] = scorePlayer(settings, line.stats).points;
      }
      return out;
    });
  const seasonValues = (throughWeek: number): Promise<Record<string, number>> =>
    at(`values:${throughWeek}`, async () => {
      const sums = new Map<string, { total: number; n: number }>();
      for (const w of archiveWeeks.filter((x) => x <= throughWeek)) {
        for (const [id, pts] of Object.entries(await projections(w))) {
          const s = sums.get(id) ?? { total: 0, n: 0 };
          sums.set(id, { total: s.total + pts, n: s.n + 1 });
        }
      }
      return Object.fromEntries([...sums].map(([id, s]) => [id, Math.round((s.total / s.n) * 100) / 100]));
    });
  const schedule = (): ReturnType<typeof data.getSchedule> => at('schedule', () => data.getSchedule(season));

  const rosterOf = async (teamId: string, week: number): Promise<RosterPlayer[]> => {
    const u = await universe();
    return (await engine.lineup(teamId, week)).map(
      (e) =>
        u.get(e.playerId) ?? { playerId: e.playerId, positions: [], status: 'active' as const, nflTeam: null }
    );
  };

  const runDraft = async (): Promise<void> => {
    const u = await universe();
    // Rank by the mean of every projection published so far (one week for a week-1 draft; more mid-season).
    const proj = await seasonValues(startWeek);
    for (let draft = await engine.draft(); !isComplete(draft); draft = await engine.draft()) {
      const slot = currentPick(draft);
      /* c8 ignore next */
      if (!slot) break;
      const drafted = new Set(draft.picks.map((p) => p.playerId));
      const available: DraftablePlayer[] = [...u.values()]
        .filter((p) => !drafted.has(p.playerId) && p.positions.length > 0)
        .map((p) => ({ playerId: p.playerId, positions: p.positions }));
      const policy = policyOf.get(slot.teamId) as TeamPolicy;
      const choice = await policy.draftPick({
        teamId: slot.teamId,
        settings,
        draft,
        available,
        projections: proj,
        seed
      });
      if (choice === null)
        throw new SimulationError(`${slot.teamId} (${policy.name}) made no pick at ${slot.overall}.`);
      const made = await engine.makeDraftPick(slot.teamId, choice);
      if (!made.ok) {
        throw new SimulationError(
          `${slot.teamId} pick ${slot.overall} (${choice}) was refused: ${made.issues[0]?.message}`
        );
      }
    }
  };

  const setLineups = async (week: number): Promise<void> => {
    const games = weekGames(await schedule(), week);
    const proj = await projections(week);
    for (const team of teams) {
      const currentLineup = await engine.lineup(team.id, week);
      const lineup = await team.policy.lineup({
        teamId: team.id,
        week,
        now: clock.now(),
        settings,
        roster: await rosterOf(team.id, week),
        currentLineup,
        games,
        projections: proj
      });
      const saved = await engine.setLineup(team.id, week, lineup);
      if (!saved.ok)
        rejected.push({
          week,
          teamId: team.id,
          action: 'set_lineup',
          codes: saved.issues.map((i) => i.code)
        });
    }
  };

  const runWaivers = async (week: number): Promise<void> => {
    const u = await universe();
    const proj = await projections(week);
    const values = await seasonValues(week);
    const trending = await data.getTrending('add');
    const trendingIds = new Set(trending.map((t) => t.playerId));
    const league = await engine.league();
    const rostered = new Set(league.teams.flatMap((t) => t.roster.map((e) => e.playerId)));
    const freeAgents: FreeAgent[] = [...u.values()]
      .filter((p) => !rostered.has(p.playerId) && p.positions.length > 0)
      .map((player) => ({
        player,
        projection: proj[player.playerId] ?? 0,
        value: values[player.playerId] ?? 0,
        trending: trendingIds.has(player.playerId)
      }));
    // Waiver priority order decides who submits first; claims are blind, so order does not change outcomes.
    for (const team of league.teams) {
      const policy = policyOf.get(team.id) as TeamPolicy;
      const claims = await policy.waiverClaims({
        teamId: team.id,
        week,
        now: clock.now(),
        settings,
        roster: await rosterOf(team.id, week),
        faabRemaining: team.faabRemaining,
        freeAgents,
        trending,
        projections: proj,
        values
      });
      for (const [i, claim] of claims.entries()) {
        const submitted = await engine.submitWaiverClaim({ teamId: team.id, ...claim, priority: i + 1 });
        if (!submitted.ok) {
          rejected.push({
            week,
            teamId: team.id,
            action: 'claim_waiver',
            codes: submitted.issues.map((x) => x.code)
          });
        }
      }
    }
    await engine.processWaivers(week);
  };

  const weekReports = new Map<number, WeekReport>();
  const checkWeek = async (week: number): Promise<InvariantResult[]> => {
    const league = await engine.league();
    const tx = await engine.transactions();
    const history = await engine.lineupHistory();
    const found: InvariantResult[] = [
      checkRostersValid(settings, league.teams, await universe()),
      checkNoSharedPlayers(league.teams),
      checkFaabConserved(settings, league.teams, tx),
      checkLineupLocks(history, kickoffOf, new Set([week]))
    ];
    const fromReads = violations.filter((v) => v.week === week);
    for (const name of ['pre_kickoff_projections', 'no_future_data'] as const) {
      found.push({
        name,
        ok: !fromReads.some((v) => v.name === name),
        violations: fromReads.filter((v) => v.name === name).map((v) => v.message)
      });
    }
    for (const r of found.slice(0, 4))
      for (const message of r.violations) violations.push({ week, name: r.name, message });
    return found.sort((a, b) => INVARIANT_NAMES.indexOf(a.name) - INVARIANT_NAMES.indexOf(b.name));
  };

  let events = 0;
  const handle = async (event: SimEvent): Promise<void> => {
    currentWeek = event.week;
    switch (event.kind) {
      case 'draft':
        await runDraft();
        break;
      case 'waiver_run':
        await runWaivers(event.week);
        await setLineups(event.week);
        break;
      case 'lineup_lock':
        // Locks are enforced by the engine from its clock; lineups were set just before (see the loop).
        break;
      case 'games_final':
        await engine.scoreWeek(event.week);
        break;
      case 'monday_night_final': {
        const board = await engine.finalizeWeek(event.week, 'provisional');
        weekReports.set(event.week, {
          week: event.week,
          kind: board.kind,
          matchups: board.matchups,
          teamPoints: board.teamPoints,
          invariants: await checkWeek(event.week)
        });
        break;
      }
      case 'stat_correction': {
        const board = await engine.finalizeWeek(event.week, 'official');
        const report = weekReports.get(event.week);
        if (report)
          weekReports.set(event.week, { ...report, matchups: board.matchups, teamPoints: board.teamPoints });
        const top = Object.entries(board.teamPoints).sort((a, b) => b[1] - a[1])[0];
        options.log?.(`week ${event.week} (${board.kind}) final; top score ${top?.[0]} ${top?.[1]}`);
        break;
      }
    }
  };

  for (let next = clock.peekEvent(); next; next = clock.peekEvent()) {
    if (next.kind === 'lineup_lock') {
      // Teams get a last look just before each window locks.
      clock.advanceTo(new Date(Math.max(clock.now().getTime(), Date.parse(next.at) - LINEUP_LEAD_MS)));
      await setLineups(next.week);
    }
    const event = clock.nextEvent() as SimEvent;
    events++;
    await handle(event);
  }

  const league = await engine.league();
  return {
    season,
    seed,
    engine: engine.kind,
    settings: {
      teamCount: settings.teamCount,
      startWeek: settings.schedule.startWeek,
      regularSeasonEndWeek: settings.schedule.regularSeasonEndWeek,
      playoffWeeks: weeks.value.playoffs,
      faabBudget: settings.waivers.faabBudget
    },
    teams: teams.map((t) => ({ id: t.id, name: t.name, policy: t.policy.name })),
    draftOrder,
    champion: await engine.champion(),
    standings: await engine.standings(),
    bracket: await engine.bracket(),
    weeks: [...weekReports.values()].sort((a, b) => a.week - b.week),
    transactions: await engine.transactions(),
    finalFaab: Object.fromEntries(league.teams.map((t) => [t.id, t.faabRemaining])),
    rejected,
    violations,
    dataAccess: {
      reads,
      byMethod: Object.fromEntries(Object.entries(byMethod).sort()),
      futureAccessAttempts: data.blockedAttempts
    },
    events
  };
}
