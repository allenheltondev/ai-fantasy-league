import {
  normalizePlayerStatus,
  type LeagueSettings,
  type LineupEntry,
  type RosterPlayer
} from '@fantasy/core';
import type { League, ReferenceStore, Repos, Team } from '@fantasy/server';
import { GAME_DURATION_MS } from '../clock/moments.js';
import type { TeamView, Transaction } from '../engine/types.js';
import { checkFaabConserved, checkNoSharedPlayers, checkRostersValid } from '../runner/invariants.js';

/**
 * The invariants a replay through the real server asserts, checked when each week goes
 * provisionally final (`Week Provisionally Final`) and once more at the end:
 * - `rosters_valid`: every team's lineup for the week validates and fits the active roster limit;
 * - `no_shared_players`: no player is on two rosters;
 * - `faab_conserved`: budget minus awarded bids equals what each team has left, never negative;
 * - `week_scored_once`: the week went final exactly once, with every matchup final and scored;
 * - `standings_match`: the stored standings equal the records the final matchups give;
 * - `no_future_data`: nothing reached the league before it existed (the as-of guard's audit, stat
 *   lines stored before their game ended, projections captured after kickoff).
 */
export const REPLAY_INVARIANTS = [
  'rosters_valid',
  'no_shared_players',
  'faab_conserved',
  'week_scored_once',
  'standings_match',
  'no_future_data'
] as const;
export type ReplayInvariant = (typeof REPLAY_INVARIANTS)[number];

export interface ReplayCheck {
  name: ReplayInvariant;
  ok: boolean;
  violations: string[];
}

const check = (name: ReplayInvariant, violations: string[]): ReplayCheck => ({
  name,
  ok: violations.length === 0,
  violations
});

/** Kickoff (ms) of a team's game in a week, or null on a bye (the auditor's view of the archive). */
export type TeamKickoff = (team: string, week: number) => number | null;

/** The teams as the sim's invariant helpers see them: each week's lineup (unlisted players on the bench). */
export async function teamViews(repos: Repos, league: League, week: number): Promise<TeamView[]> {
  const teams = await repos.teams.list(league.id);
  const views: TeamView[] = [];
  for (const team of teams) {
    const lineup = await repos.lineups.latest(league.id, team.id, week);
    const slots = new Map((lineup?.entries ?? []).map((e) => [e.playerId, e.slot]));
    const roster: LineupEntry[] = team.roster.map((playerId) => ({
      playerId,
      slot: slots.get(playerId) ?? 'BN'
    }));
    views.push({ id: team.id, name: team.name, faabRemaining: team.faabRemaining, roster });
  }
  return views;
}

async function universe(repos: Repos, teams: readonly Team[]): Promise<Map<string, RosterPlayer>> {
  const players = await repos.players.getMany(teams.flatMap((t) => t.roster));
  const out = new Map<string, RosterPlayer>();
  for (const p of players) {
    out.set(p.id, {
      playerId: p.id,
      name: p.name,
      positions: [p.position],
      // As the server reads it (season/lineups.ts `playerStatus`).
      status: normalizePlayerStatus(
        p.injuryStatus,
        p.status === 'injured_reserve' ? 'Injured Reserve' : p.status === 'inactive' ? 'Inactive' : null
      ),
      nflTeam: p.team
    });
  }
  return out;
}

/** Awarded waiver claims as the FAAB invariant's transactions. */
async function waiverAdds(repos: Repos, leagueId: string): Promise<Transaction[]> {
  const all = await repos.waivers.listTransactionsSince(leagueId, '');
  return all
    .filter((t) => t.type === 'waiver_claim')
    .map((t, seq) => ({
      seq,
      type: 'waiver_add' as const,
      at: t.at,
      week: t.week,
      teamId: t.teamId,
      addPlayerId: t.addPlayerId ?? '',
      dropPlayerId: t.dropPlayerId,
      cost: t.cost ?? 0
    }));
}

/** The roster invariants (valid rosters, no shared players, FAAB conserved) as the league stands now. */
export async function checkRosters(repos: Repos, league: League, week: number): Promise<ReplayCheck[]> {
  const settings: LeagueSettings = league.settings;
  const teams = await repos.teams.list(league.id);
  const views = await teamViews(repos, league, week);
  const valid = checkRostersValid(settings, views, await universe(repos, teams));
  const shared = checkNoSharedPlayers(views);
  const faab = checkFaabConserved(settings, views, await waiverAdds(repos, league.id));
  return [
    check('rosters_valid', valid.violations),
    check('no_shared_players', shared.violations),
    check('faab_conserved', faab.violations)
  ];
}

/** The week is final exactly once, and every one of its matchups is final with both scores. */
export async function checkWeekScored(
  repos: Repos,
  leagueId: string,
  week: number,
  finals: number
): Promise<ReplayCheck> {
  const violations: string[] = [];
  if (finals !== 1) violations.push(`week ${week} went final ${finals} times`);
  for (const m of await repos.schedule.listMatchups(leagueId, week)) {
    if (m.status !== 'final' || m.homeScore === null || m.awayScore === null) {
      violations.push(`week ${week} ${m.id} is ${m.status} (${m.homeScore}-${m.awayScore})`);
    }
  }
  return check('week_scored_once', violations);
}

/** The latest standings snapshot matches the wins, losses, ties, and points of the final regular-season games. */
export async function checkStandings(repos: Repos, leagueId: string): Promise<ReplayCheck> {
  const snapshot = await repos.schedule.latestStandings(leagueId);
  if (snapshot === null) return check('standings_match', []);
  const expected = new Map<string, { w: number; l: number; t: number; pf: number; pa: number }>();
  const row = (id: string) => {
    let r = expected.get(id);
    if (r === undefined) expected.set(id, (r = { w: 0, l: 0, t: 0, pf: 0, pa: 0 }));
    return r;
  };
  for (const m of await repos.schedule.listMatchups(leagueId)) {
    if (m.kind !== 'regular' || m.status !== 'final' || m.week > snapshot.week) continue;
    const home = m.homeScore ?? 0;
    const away = m.awayScore ?? 0;
    const h = row(m.homeTeamId);
    const a = row(m.awayTeamId);
    h.pf += home;
    h.pa += away;
    a.pf += away;
    a.pa += home;
    if (home > away) {
      h.w++;
      a.l++;
    } else if (away > home) {
      a.w++;
      h.l++;
    } else {
      h.t++;
      a.t++;
    }
  }
  const violations: string[] = [];
  const round = (n: number) => Math.round(n * 100) / 100;
  for (const r of snapshot.rows) {
    const e = expected.get(r.teamId) ?? { w: 0, l: 0, t: 0, pf: 0, pa: 0 };
    if (r.wins !== e.w || r.losses !== e.l || r.ties !== e.t) {
      violations.push(
        `${r.teamId}: standings ${r.wins}-${r.losses}-${r.ties}, matchups ${e.w}-${e.l}-${e.t}`
      );
    }
    if (round(r.pointsFor) !== round(e.pf) || round(r.pointsAgainst) !== round(e.pa)) {
      violations.push(
        `${r.teamId}: standings points ${round(r.pointsFor)}/${round(r.pointsAgainst)}, matchups ${round(e.pf)}/${round(e.pa)}`
      );
    }
  }
  return check('standings_match', violations);
}

/**
 * Nothing the league stored for a week came from its future: every stat line was written after its
 * player's game ended. Together with the as-of guard's read audit (`futureReads`: stats, scores, and
 * projections served before they existed), this is "no agent acts on data from the future", since
 * agents only read what the league stored.
 */
export async function checkNoFutureData(
  reference: ReferenceStore,
  season: number,
  week: number,
  kickoff: TeamKickoff,
  futureReads: readonly string[]
): Promise<ReplayCheck> {
  const violations = [...futureReads];
  for (const line of await reference.stats.getWeek(season, week)) {
    const k = line.team === undefined ? null : kickoff(line.team, week);
    if (k === null || Date.parse(line.updatedAt) < k + GAME_DURATION_MS) {
      violations.push(
        `${line.playerId} week ${week} stats stored at ${line.updatedAt} before his game ended`
      );
    }
  }
  return check('no_future_data', violations);
}
