import {
  advanceBracket,
  buildBracket,
  champion as bracketChampion,
  computeStandings,
  createDraft,
  draftRoundsFor,
  generateSchedule,
  isComplete,
  leagueWeeks,
  makePick,
  matchupResult,
  resolveWaivers,
  ruleError,
  scoreTeamWeek,
  seedPlayoffs,
  validateLineup,
  type Bracket,
  type DraftPick,
  type DraftState,
  type FinalizedMatchup,
  type LeagueSettings,
  type LineupEntry,
  type RosterPlayer,
  type RuleIssue,
  type ScheduleWeek,
  type StandingsRow,
  type StatLine as CoreStatLine,
  type WaiverClaim
} from '@fantasy/core';
import { toRosterPlayer, weekGames } from '../players.js';
import type {
  CreateLeagueInput,
  EngineEnv,
  EngineResult,
  LeagueEngine,
  LeaguePhase,
  LeagueView,
  LineupRecord,
  MatchupScore,
  Transaction,
  WaiverClaimInput,
  WaiverRunResult,
  WeekScoreboard
} from './types.js';

/** Thrown when an operation needs a league that has not been created. */
export class EngineStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineStateError';
  }
}

const fail = <T>(issues: RuleIssue[]): EngineResult<T> => ({ ok: false, issues });
const issue = (code: string, path: string, message: string, fix: string): RuleIssue =>
  ruleError(code, path, message, fix);

interface State {
  leagueId: string;
  settings: LeagueSettings;
  seed: string;
  teams: { id: string; name: string }[];
  weeks: number[];
  regularWeeks: Set<number>;
  schedule: ScheduleWeek[];
  phase: LeaguePhase;
  week: number;
  draft: DraftState;
  rosters: Map<string, Set<string>>;
  lineups: Map<number, Map<string, LineupEntry[]>>;
  faab: Map<string, number>;
  waiverOrder: string[];
  claims: WaiverClaim[];
  claimSeq: number;
  acquisitions: Map<number, Map<string, number>>;
  results: Map<number, WeekScoreboard>;
  bracket: Bracket | null;
  transactions: Transaction[];
  history: LineupRecord[];
}

/**
 * A league engine built only on `@fantasy/core`, held in memory: no server, no database. It enforces the
 * same rules the server will (draft order, lineup validity and locks, waiver resolution, scoring,
 * standings, the playoff bracket) and reads data only through the provider it is given, as of its clock.
 */
export class CoreOnlyEngine implements LeagueEngine {
  readonly kind = 'core-only';
  readonly #env: EngineEnv;
  #s: State | undefined;

  constructor(env: EngineEnv) {
    this.#env = env;
  }

  get #state(): State {
    if (!this.#s) throw new EngineStateError('No league yet: call createLeague first.');
    return this.#s;
  }

  #now(): Date {
    return this.#env.clock.now();
  }

  async createLeague(input: CreateLeagueInput): Promise<LeagueView> {
    const { settings } = input;
    const weeks = leagueWeeks(settings);
    if (!weeks.ok) throw new EngineStateError(weeks.issues.map((i) => i.message).join(' '));
    const teamIds = input.teams.map((t) => t.id);
    if (teamIds.length !== settings.teamCount) {
      throw new EngineStateError(
        `Settings say ${settings.teamCount} teams, but ${teamIds.length} were given.`
      );
    }
    const schedule = generateSchedule(teamIds, {
      startWeek: settings.schedule.startWeek,
      regularSeasonEndWeek: settings.schedule.regularSeasonEndWeek,
      seed: input.seed
    });
    if (!schedule.ok) throw new EngineStateError(schedule.issues.map((i) => i.message).join(' '));
    const draft = createDraft({
      teamIds: input.draftOrder,
      rounds: draftRoundsFor(settings),
      pickSeconds: 90
    });
    if (!draft.ok) throw new EngineStateError(draft.issues.map((i) => i.message).join(' '));
    this.#s = {
      leagueId: input.leagueId,
      settings,
      seed: input.seed,
      teams: input.teams.map((t) => ({ ...t })),
      weeks: [...weeks.value.regularSeason, ...weeks.value.playoffs],
      regularWeeks: new Set(weeks.value.regularSeason),
      schedule: schedule.value,
      phase: 'drafting',
      week: weeks.value.startWeek,
      draft: draft.value,
      rosters: new Map(teamIds.map((id) => [id, new Set<string>()])),
      lineups: new Map(),
      faab: new Map(teamIds.map((id) => [id, settings.waivers.faabBudget])),
      waiverOrder: [...input.draftOrder].reverse(),
      claims: [],
      claimSeq: 0,
      acquisitions: new Map(),
      results: new Map(),
      bracket: null,
      transactions: [],
      history: []
    };
    return this.league();
  }

  async league(): Promise<LeagueView> {
    const s = this.#state;
    return {
      leagueId: s.leagueId,
      settings: s.settings,
      phase: s.phase,
      week: s.week,
      teams: s.teams.map((t) => ({
        id: t.id,
        name: t.name,
        faabRemaining: s.faab.get(t.id) ?? 0,
        roster: this.#lineupOf(t.id, s.week)
      })),
      schedule: s.schedule,
      waiverOrder: [...s.waiverOrder]
    };
  }

  async draft(): Promise<DraftState> {
    return this.#state.draft;
  }

  async #universe(): Promise<Map<string, RosterPlayer>> {
    const players = await this.#env.data.getPlayers(this.#now());
    return new Map(players.map((p) => [p.id, toRosterPlayer(p)]));
  }

  async makeDraftPick(teamId: string, playerId: string): Promise<EngineResult<DraftPick>> {
    const s = this.#state;
    if (s.phase !== 'drafting') {
      return fail([
        issue('DRAFT_COMPLETE', 'draft', 'The draft is over.', 'Add players through waivers instead.')
      ]);
    }
    const player = (await this.#universe()).get(playerId);
    if (!player) {
      return fail([
        issue(
          'UNKNOWN_PLAYER',
          'playerId',
          `No player ${playerId} exists.`,
          'Pick a player from the player list.'
        )
      ]);
    }
    const now = this.#now();
    const made = makePick(s.draft, teamId, playerId, { positions: player.positions, now });
    if (!made.ok) return fail(made.issues);
    s.draft = made.value.draft;
    s.rosters.get(teamId)?.add(playerId);
    s.transactions.push({
      seq: s.transactions.length + 1,
      type: 'draft_pick',
      at: now.toISOString(),
      teamId,
      playerId,
      round: made.value.pick.round,
      overall: made.value.pick.overall
    });
    if (isComplete(s.draft)) s.phase = 'in_season';
    return { ok: true, value: made.value.pick, warnings: [] };
  }

  /** A team's lineup for a week: the saved one, else the latest earlier one; always exactly the roster. */
  #lineupOf(teamId: string, week: number): LineupEntry[] {
    const s = this.#state;
    const roster = s.rosters.get(teamId) ?? new Set<string>();
    let saved: LineupEntry[] | undefined;
    for (let w = week; w >= 0 && !saved; w--) saved = s.lineups.get(w)?.get(teamId);
    const out = (saved ?? []).filter((e) => roster.has(e.playerId)).map((e) => ({ ...e }));
    const placed = new Set(out.map((e) => e.playerId));
    for (const id of [...roster].sort()) if (!placed.has(id)) out.push({ playerId: id, slot: 'BN' });
    return out;
  }

  #save(teamId: string, week: number, lineup: LineupEntry[]): void {
    const s = this.#state;
    const byTeam = s.lineups.get(week) ?? new Map<string, LineupEntry[]>();
    byTeam.set(
      teamId,
      lineup.map((e) => ({ ...e }))
    );
    s.lineups.set(week, byTeam);
    s.history.push({ at: this.#now().toISOString(), week, teamId, lineup: lineup.map((e) => ({ ...e })) });
  }

  async lineup(teamId: string, week: number): Promise<LineupEntry[]> {
    return this.#lineupOf(teamId, week);
  }

  async setLineup(
    teamId: string,
    week: number,
    lineup: readonly LineupEntry[]
  ): Promise<EngineResult<LineupEntry[]>> {
    const s = this.#state;
    if (!s.rosters.has(teamId)) {
      return fail([
        issue(
          'UNKNOWN_TEAM',
          'teamId',
          `Team ${teamId} is not in this league.`,
          'Use a team id from the league.'
        )
      ]);
    }
    if (s.phase === 'drafting' || s.phase === 'complete' || !s.weeks.includes(week) || week < s.week) {
      return fail([
        issue(
          'WEEK_NOT_EDITABLE',
          'week',
          `Week ${week} lineups cannot be edited now (league week ${s.week}, phase ${s.phase}).`,
          `Set a lineup for week ${s.week} or later, after the draft and before the season ends.`
        )
      ]);
    }
    const universe = await this.#universe();
    const roster = [...(s.rosters.get(teamId) ?? [])].map(
      (id) => universe.get(id) ?? { playerId: id, positions: [], status: 'active' as const, nflTeam: null }
    );
    const schedule = await this.#env.data.getSchedule(this.#env.season, this.#now());
    const v = validateLineup(s.settings, roster, lineup, {
      games: weekGames(schedule, week),
      now: this.#now(),
      previousLineup: this.#lineupOf(teamId, week)
    });
    if (!v.valid) return fail(v.errors);
    this.#save(teamId, week, v.lineup);
    return { ok: true, value: v.lineup, warnings: v.warnings };
  }

  async submitWaiverClaim(claim: WaiverClaimInput): Promise<EngineResult<{ claimId: string }>> {
    const s = this.#state;
    const budget = s.faab.get(claim.teamId);
    if (budget === undefined) {
      return fail([
        issue(
          'UNKNOWN_TEAM',
          'teamId',
          `Team ${claim.teamId} is not in this league.`,
          'Use a team id from the league.'
        )
      ]);
    }
    if (s.phase === 'drafting' || s.phase === 'complete') {
      return fail([
        issue(
          'WAIVERS_CLOSED',
          'phase',
          `Waivers are closed during ${s.phase}.`,
          'Claim once the season is under way.'
        )
      ]);
    }
    if (!Number.isInteger(claim.bid) || claim.bid < 0 || claim.bid > budget) {
      return fail([
        issue(
          'INVALID_BID',
          'bid',
          `Bid ${claim.bid} is not a whole dollar amount from 0 to $${budget}.`,
          `Bid between $0 and $${budget}.`
        )
      ]);
    }
    const universe = await this.#universe();
    const rostered = [...s.rosters.values()].some((r) => r.has(claim.addPlayerId));
    if (!universe.has(claim.addPlayerId) || rostered) {
      return fail([
        issue(
          'PLAYER_UNAVAILABLE',
          'addPlayerId',
          `Player ${claim.addPlayerId} is not a free agent.`,
          'Claim a player who is not on a roster.'
        )
      ]);
    }
    const drop = claim.dropPlayerId ?? null;
    if (drop !== null && !s.rosters.get(claim.teamId)?.has(drop)) {
      return fail([
        issue(
          'DROP_PLAYER_NOT_ON_ROSTER',
          'dropPlayerId',
          `Player ${drop} is not on your roster.`,
          'Drop one of your own players.'
        )
      ]);
    }
    s.claimSeq++;
    const claimId = `claim-${s.claimSeq}`;
    s.claims.push({
      claimId,
      teamId: claim.teamId,
      addPlayerId: claim.addPlayerId,
      dropPlayerId: drop,
      bid: claim.bid,
      priority: claim.priority,
      createdAt: this.#now().toISOString()
    });
    return { ok: true, value: { claimId }, warnings: [] };
  }

  async processWaivers(week: number): Promise<WaiverRunResult> {
    const s = this.#state;
    const universe = await this.#universe();
    const rostered = new Set([...s.rosters.values()].flatMap((r) => [...r]));
    const acquired = s.acquisitions.get(week) ?? new Map<string, number>();
    const standings = await this.standings();
    const result = resolveWaivers(s.settings, s.claims, {
      teams: Object.fromEntries(
        s.teams.map((t) => [
          t.id,
          {
            roster: this.#lineupOf(t.id, week),
            faabRemaining: s.faab.get(t.id) ?? 0,
            acquisitionsThisWeek: acquired.get(t.id) ?? 0
          }
        ])
      ),
      priorityOrder: s.waiverOrder,
      availablePlayerIds: [...universe.keys()].filter((id) => !rostered.has(id)).sort(),
      reverseStandings: [...standings].reverse().map((r) => r.teamId)
    });
    s.claims = [];
    const at = this.#now().toISOString();
    for (const [teamId, roster] of Object.entries(result.rosters)) {
      const before = s.rosters.get(teamId) ?? new Set<string>();
      const after = new Set(roster.map((e) => e.playerId));
      const changed = before.size !== after.size || [...after].some((id) => !before.has(id));
      s.rosters.set(teamId, after);
      if (changed) this.#save(teamId, week, roster);
    }
    for (const [teamId, budget] of Object.entries(result.budgets)) s.faab.set(teamId, budget);
    s.waiverOrder = result.priorityOrder;
    for (const t of result.transactions) {
      acquired.set(t.teamId, (acquired.get(t.teamId) ?? 0) + 1);
      s.transactions.push({
        seq: s.transactions.length + 1,
        type: 'waiver_add',
        at,
        week,
        teamId: t.teamId,
        addPlayerId: t.addPlayerId,
        dropPlayerId: t.dropPlayerId,
        cost: t.cost
      });
    }
    s.acquisitions.set(week, acquired);
    return {
      week,
      awarded: result.transactions.map((t) => ({
        teamId: t.teamId,
        addPlayerId: t.addPlayerId,
        dropPlayerId: t.dropPlayerId,
        cost: t.cost
      })),
      failed: result.failed.map((f) => ({
        teamId: f.claim.teamId,
        addPlayerId: f.claim.addPlayerId,
        code: f.issue.code
      }))
    };
  }

  /** This week's pairings: the regular-season schedule, or the bracket games whose teams are known. */
  #pairings(week: number): { homeTeamId: string; awayTeamId: string }[] {
    const s = this.#state;
    if (s.regularWeeks.has(week)) return s.schedule.find((w) => w.week === week)?.matchups ?? [];
    return (s.bracket?.games ?? [])
      .filter((g) => g.week === week && g.home.teamId !== null && g.away.teamId !== null)
      .map((g) => ({ homeTeamId: g.home.teamId as string, awayTeamId: g.away.teamId as string }));
  }

  async scoreWeek(week: number, stage: WeekScoreboard['stage'] = 'live'): Promise<WeekScoreboard> {
    const s = this.#state;
    const lines = await this.#env.data.getWeekStats(this.#env.season, week, this.#now());
    const stats: Record<string, CoreStatLine> = {};
    for (const l of lines) stats[l.playerId] = l.stats;
    const teamPoints: Record<string, number> = {};
    for (const t of s.teams)
      teamPoints[t.id] = scoreTeamWeek(s.settings, this.#lineupOf(t.id, week), stats).points;
    const matchups: MatchupScore[] = this.#pairings(week).map((m) => {
      const homeScore = teamPoints[m.homeTeamId] ?? 0;
      const awayScore = teamPoints[m.awayTeamId] ?? 0;
      const winner = matchupResult(homeScore, awayScore).winner;
      return {
        ...m,
        homeScore,
        awayScore,
        winnerTeamId: winner === 'home' ? m.homeTeamId : winner === 'away' ? m.awayTeamId : null
      };
    });
    return { week, kind: s.regularWeeks.has(week) ? 'regular' : 'playoffs', stage, matchups, teamPoints };
  }

  async finalizeWeek(week: number, stage: 'provisional' | 'official'): Promise<WeekScoreboard> {
    const s = this.#state;
    const existing = s.results.get(week);
    if (existing?.stage === 'official') return existing;
    const board = await this.scoreWeek(week, stage);
    s.results.set(week, board);
    const next = s.weeks.find((w) => w > week);
    if (stage === 'provisional' && next !== undefined && s.week <= week) s.week = next;
    if (stage === 'official') {
      if (week === s.settings.schedule.regularSeasonEndWeek) this.#buildBracket();
      if (!s.regularWeeks.has(week) && s.bracket) {
        const advanced = advanceBracket(s.bracket, { week, results: board.matchups });
        if (!advanced.ok) throw new EngineStateError(advanced.issues.map((i) => i.message).join(' '));
        s.bracket = advanced.value;
      }
      if (next === undefined) s.phase = 'complete';
    }
    return board;
  }

  #buildBracket(): void {
    const s = this.#state;
    const seeding = seedPlayoffs(s.settings, this.#standingsNow());
    if (!seeding.ok) throw new EngineStateError(seeding.issues.map((i) => i.message).join(' '));
    const bracket = buildBracket(s.settings, seeding.value.seeds);
    if (!bracket.ok) throw new EngineStateError(bracket.issues.map((i) => i.message).join(' '));
    s.bracket = bracket.value;
    s.phase = 'playoffs';
  }

  #standingsNow(): StandingsRow[] {
    const s = this.#state;
    const finalized: FinalizedMatchup[] = [];
    for (const [week, board] of [...s.results].sort(([a], [b]) => a - b)) {
      if (board.kind !== 'regular') continue;
      for (const m of board.matchups) finalized.push({ week, ...m });
    }
    return computeStandings(s.settings, finalized, { teamIds: s.teams.map((t) => t.id), seed: s.seed });
  }

  async standings(): Promise<StandingsRow[]> {
    return this.#standingsNow();
  }

  async bracket(): Promise<Bracket | null> {
    return this.#state.bracket;
  }

  async champion(): Promise<string | null> {
    const b = this.#state.bracket;
    return b ? bracketChampion(b) : null;
  }

  async transactions(): Promise<Transaction[]> {
    return this.#state.transactions.map((t) => ({ ...t }));
  }

  async lineupHistory(): Promise<LineupRecord[]> {
    return this.#state.history.map((h) => ({ ...h, lineup: h.lineup.map((e) => ({ ...e })) }));
  }
}

/** `LeagueEngineFactory` for `CoreOnlyEngine`. */
export const createCoreOnlyEngine = (env: EngineEnv): CoreOnlyEngine => new CoreOnlyEngine(env);
