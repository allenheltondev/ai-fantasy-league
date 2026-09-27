import type { LeagueSettings } from '../rules/settings.js';
import { hashString } from '../schedule/random.js';

export type GameResult = 'W' | 'L' | 'T';

export interface MatchupOutcome {
  home: GameResult;
  away: GameResult;
  /** `home` or `away`, or null for a tie. */
  winner: 'home' | 'away' | null;
}

/** Scores are compared in whole cents so float noise (e.g. 0.1 + 0.2) never decides a game. */
function cents(points: number): number {
  return Math.round(points * 100);
}

/** Win, loss, or tie for each side. Equal scores (to the cent) are a tie. */
export function matchupResult(homeScore: number, awayScore: number): MatchupOutcome {
  const h = cents(homeScore);
  const a = cents(awayScore);
  if (h > a) return { home: 'W', away: 'L', winner: 'home' };
  if (h < a) return { home: 'L', away: 'W', winner: 'away' };
  return { home: 'T', away: 'T', winner: null };
}

export interface FinalizedMatchup {
  week: number;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
}

export type StandingsTiebreaker = 'points_for' | 'head_to_head' | 'coin_flip';

export interface StandingsRow {
  teamId: string;
  /** 1-based, unique. */
  rank: number;
  wins: number;
  losses: number;
  ties: number;
  gamesPlayed: number;
  /** (wins + ties / 2) / games played; 0 before any game. */
  winPct: number;
  pointsFor: number;
  pointsAgainst: number;
  /** Current run of identical results, e.g. W3; null before any game. */
  streak: { result: GameResult; length: number } | null;
  /**
   * The tiebreaker that placed this team above the next team, when the two had the same win
   * percentage; null when win percentage decided it (or for the last team).
   */
  tiebreakerOverNext: StandingsTiebreaker | null;
}

export interface StandingsOptions {
  /** Every team in the league, so teams that have not played still appear. */
  teamIds?: readonly string[];
  /** Seed for the final coin-flip tiebreaker (default: `"standings"`). */
  seed?: string | number;
}

/**
 * Tiebreakers applied after win percentage, in order. `playoffs.tiebreaker` picks which of points
 * for and head-to-head comes first; the other follows, and a seeded coin flip is last.
 */
export function standingsTiebreakers(
  settings: Pick<LeagueSettings, 'playoffs'>
): readonly StandingsTiebreaker[] {
  return settings.playoffs.tiebreaker === 'head_to_head'
    ? ['head_to_head', 'points_for', 'coin_flip']
    : ['points_for', 'head_to_head', 'coin_flip'];
}

interface Tally {
  teamId: string;
  wins: number;
  losses: number;
  ties: number;
  pf: number;
  pa: number;
  results: Array<{ week: number; result: GameResult }>;
}

function winPct(t: { wins: number; ties: number; losses: number }): number {
  const games = t.wins + t.losses + t.ties;
  return games === 0 ? 0 : (t.wins + t.ties / 2) / games;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Head-to-head win percentage in games between members of `group`; .500 with no such games. */
function headToHead(teamId: string, group: ReadonlySet<string>, games: readonly FinalizedMatchup[]): number {
  let w = 0;
  let l = 0;
  let t = 0;
  for (const g of games) {
    if (!group.has(g.homeTeamId) || !group.has(g.awayTeamId)) continue;
    const r = matchupResult(g.homeScore, g.awayScore);
    let mine: GameResult;
    if (g.homeTeamId === teamId) mine = r.home;
    else if (g.awayTeamId === teamId) mine = r.away;
    else continue;
    if (mine === 'W') w++;
    else if (mine === 'L') l++;
    else t++;
  }
  return w + l + t === 0 ? 0.5 : winPct({ wins: w, losses: l, ties: t });
}

type Ranked = { tally: Tally; decidedBy: StandingsTiebreaker | null };

/**
 * Orders teams with equal win percentage. Each criterion splits the group into subgroups of equal
 * value; each subgroup of two or more restarts the chain (so head-to-head is recomputed among only
 * the teams still tied). The coin flip always separates teams.
 */
function breakTie(
  group: readonly Tally[],
  chain: readonly StandingsTiebreaker[],
  games: readonly FinalizedMatchup[],
  seed: string
): Ranked[] {
  if (group.length === 1) return [{ tally: group[0] as Tally, decidedBy: null }];
  const members = new Set(group.map((t) => t.teamId));
  for (const criterion of chain) {
    const value = (t: Tally): number => {
      switch (criterion) {
        case 'points_for':
          return cents(t.pf);
        case 'head_to_head':
          return headToHead(t.teamId, members, games);
        case 'coin_flip':
          return hashString(`${seed}:${t.teamId}`);
      }
    };
    const buckets = new Map<number, Tally[]>();
    for (const t of group) {
      const v = value(t);
      buckets.set(v, [...(buckets.get(v) ?? []), t]);
    }
    if (buckets.size === 1) continue;
    const ordered = [...buckets.entries()].sort((a, b) => b[0] - a[0]);
    const out: Ranked[] = [];
    for (const [, sub] of ordered) {
      const ranked = breakTie(sub, chain, games, seed);
      // The last team of a subgroup was placed above the next subgroup by this criterion.
      const last = ranked[ranked.length - 1] as Ranked;
      last.decidedBy = criterion;
      out.push(...ranked);
    }
    return out;
  }
  // Only reachable when every criterion ties (a coin-flip hash collision): fall back to team id.
  return [...group]
    .sort((a, b) => (a.teamId < b.teamId ? -1 : 1))
    .map((tally) => ({ tally, decidedBy: 'coin_flip' as const }));
}

function streakOf(results: Tally['results']): StandingsRow['streak'] {
  const sorted = [...results].sort((a, b) => a.week - b.week);
  const last = sorted[sorted.length - 1];
  if (!last) return null;
  let length = 0;
  for (let i = sorted.length - 1; i >= 0 && sorted[i]?.result === last.result; i--) length++;
  return { result: last.result, length };
}

/**
 * Regular-season standings from finalized matchups. Matchups outside the regular season
 * (`schedule.startWeek` to `schedule.regularSeasonEndWeek`) are ignored, so playoff games never
 * change seeding.
 *
 * Teams are ranked by win percentage (ties count as half a win), then by the settings' tiebreakers:
 * see `standingsTiebreakers`. There are no divisions.
 */
export function computeStandings(
  settings: Pick<LeagueSettings, 'playoffs' | 'schedule'>,
  finalizedMatchups: readonly FinalizedMatchup[],
  options: StandingsOptions = {}
): StandingsRow[] {
  const { startWeek, regularSeasonEndWeek } = settings.schedule;
  const games = finalizedMatchups.filter((m) => m.week >= startWeek && m.week <= regularSeasonEndWeek);
  const tallies = new Map<string, Tally>();
  const tally = (teamId: string): Tally => {
    let t = tallies.get(teamId);
    if (!t) {
      t = { teamId, wins: 0, losses: 0, ties: 0, pf: 0, pa: 0, results: [] };
      tallies.set(teamId, t);
    }
    return t;
  };
  for (const id of options.teamIds ?? []) tally(id);
  for (const g of games) {
    const r = matchupResult(g.homeScore, g.awayScore);
    for (const [id, mine, pf, pa] of [
      [g.homeTeamId, r.home, g.homeScore, g.awayScore],
      [g.awayTeamId, r.away, g.awayScore, g.homeScore]
    ] as const) {
      const t = tally(id);
      if (mine === 'W') t.wins++;
      else if (mine === 'L') t.losses++;
      else t.ties++;
      t.pf += pf;
      t.pa += pa;
      t.results.push({ week: g.week, result: mine });
    }
  }

  const chain = standingsTiebreakers(settings);
  const seed = String(options.seed ?? 'standings');
  const byPct = new Map<number, Tally[]>();
  for (const t of tallies.values()) {
    const key = winPct(t);
    byPct.set(key, [...(byPct.get(key) ?? []), t]);
  }
  const ranked = [...byPct.entries()]
    .sort((a, b) => b[0] - a[0])
    .flatMap(([, group]) => {
      const r = breakTie(group, chain, games, seed);
      (r[r.length - 1] as Ranked).decidedBy = null;
      return r;
    });

  return ranked.map(({ tally: t, decidedBy }, i) => ({
    teamId: t.teamId,
    rank: i + 1,
    wins: t.wins,
    losses: t.losses,
    ties: t.ties,
    gamesPlayed: t.wins + t.losses + t.ties,
    winPct: winPct(t),
    pointsFor: round2(t.pf),
    pointsAgainst: round2(t.pa),
    streak: streakOf(t.results),
    tiebreakerOverNext: decidedBy
  }));
}

/** Formats a record as Yahoo does: 7-3 or 7-2-1 when there are ties. */
export function formatRecord(row: Pick<StandingsRow, 'wins' | 'losses' | 'ties'>): string {
  return row.ties > 0 ? `${row.wins}-${row.losses}-${row.ties}` : `${row.wins}-${row.losses}`;
}
