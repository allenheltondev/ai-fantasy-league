import {
  activeRosterSize,
  validateLineup,
  type LeagueSettings,
  type LineupEntry,
  type RosterPlayer
} from '@fantasy/core';
import { GAME_DURATION_MS } from '../clock/moments.js';
import type { SimArchive } from '../archive/format.js';
import type { LineupRecord, TeamView, Transaction } from '../engine/types.js';
import type { DataRead } from '../guard/guard.js';

export const INVARIANT_NAMES = [
  'rosters_valid',
  'no_shared_players',
  'faab_conserved',
  'lineup_locks_respected',
  'pre_kickoff_projections',
  'no_future_data'
] as const;
export type InvariantName = (typeof INVARIANT_NAMES)[number];

export interface InvariantResult {
  name: InvariantName;
  ok: boolean;
  violations: string[];
}

const result = (name: InvariantName, violations: string[]): InvariantResult => ({
  name,
  ok: violations.length === 0,
  violations
});

/** Every roster passes lineup validation (known players, legal slots) and fits the active roster limit. */
export function checkRostersValid(
  settings: LeagueSettings,
  teams: readonly TeamView[],
  universe: ReadonlyMap<string, RosterPlayer>
): InvariantResult {
  const violations: string[] = [];
  const limit = activeRosterSize(settings);
  for (const team of teams) {
    const roster = team.roster.map(
      (e) =>
        universe.get(e.playerId) ?? {
          playerId: e.playerId,
          positions: [],
          status: 'active' as const,
          nflTeam: null
        }
    );
    const v = validateLineup(settings, roster, team.roster);
    for (const e of v.errors) violations.push(`${team.id}: ${e.code} ${e.message}`);
    const active = team.roster.filter((e) => e.slot !== 'IR').length;
    if (active > limit) violations.push(`${team.id}: ${active} active players, limit ${limit}`);
  }
  return result('rosters_valid', violations);
}

/** No player is on two rosters. */
export function checkNoSharedPlayers(teams: readonly TeamView[]): InvariantResult {
  const owner = new Map<string, string>();
  const violations: string[] = [];
  for (const team of teams) {
    for (const e of team.roster) {
      const other = owner.get(e.playerId);
      if (other !== undefined && other !== team.id)
        violations.push(`${e.playerId} is on ${other} and ${team.id}`);
      else owner.set(e.playerId, team.id);
    }
  }
  return result('no_shared_players', violations);
}

/** FAAB is conserved: each team's budget minus its winning bids is exactly what it has left, never negative. */
export function checkFaabConserved(
  settings: LeagueSettings,
  teams: readonly TeamView[],
  transactions: readonly Transaction[]
): InvariantResult {
  const violations: string[] = [];
  const budget = settings.waivers.faabBudget;
  let spentTotal = 0;
  let remainingTotal = 0;
  for (const team of teams) {
    const spent = transactions
      .filter((t) => t.type === 'waiver_add' && t.teamId === team.id)
      .reduce((sum, t) => sum + (t.type === 'waiver_add' ? t.cost : 0), 0);
    spentTotal += spent;
    remainingTotal += team.faabRemaining;
    if (team.faabRemaining < 0) violations.push(`${team.id} has negative FAAB (${team.faabRemaining})`);
    if (budget - spent !== team.faabRemaining) {
      violations.push(`${team.id}: budget ${budget} - spent ${spent} != remaining ${team.faabRemaining}`);
    }
  }
  if (spentTotal + remainingTotal !== budget * teams.length) {
    violations.push(
      `league FAAB: spent ${spentTotal} + remaining ${remainingTotal} != ${budget * teams.length}`
    );
  }
  return result('faab_conserved', violations);
}

/** Kickoff (ms) of a player's game in a week, from the archive: null when his team is on bye or he has none. */
export type KickoffLookup = (playerId: string, week: number) => number | null;

/** The auditor's omniscient view of kickoffs (never exposed to policies). */
export function archiveKickoffs(archive: SimArchive): KickoffLookup {
  const teamOf = new Map(archive.players.map((p) => [p.id, p.teams]));
  const kickoffs = new Map<string, number>();
  for (const g of archive.schedule) {
    if (g.seasonType !== 'regular') continue;
    kickoffs.set(`${g.week}:${g.homeTeam}`, Date.parse(g.kickoff));
    kickoffs.set(`${g.week}:${g.awayTeam}`, Date.parse(g.kickoff));
  }
  return (playerId, week) => {
    const team = teamOf.get(playerId)?.[week];
    return team ? (kickoffs.get(`${week}:${team}`) ?? null) : null;
  };
}

const slotMap = (lineup: readonly LineupEntry[]): Map<string, string> =>
  new Map(lineup.map((e) => [e.playerId, e.slot]));

/**
 * Lineup locks were respected: across every pair of consecutive saved lineups of a team for a week (the
 * first compared with the lineup carried from earlier weeks), no player whose game had kicked off when the
 * later one was saved changed slot or left the roster.
 */
export function checkLineupLocks(
  history: readonly LineupRecord[],
  kickoffOf: KickoffLookup,
  weeks?: ReadonlySet<number>
): InvariantResult {
  const violations: string[] = [];
  const lastByTeam = new Map<string, { week: number; lineup: LineupEntry[] }>();
  const ordered = [...history].sort((a, b) => a.week - b.week || a.at.localeCompare(b.at));
  for (const rec of ordered) {
    const prev = lastByTeam.get(rec.teamId);
    const before = slotMap(prev?.lineup ?? []);
    const after = slotMap(rec.lineup);
    const at = Date.parse(rec.at);
    if (!weeks || weeks.has(rec.week)) {
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        const kickoff = kickoffOf(id, rec.week);
        if (kickoff === null || kickoff > at) continue;
        const from = before.get(id) ?? 'BN';
        const to = after.get(id) ?? 'dropped';
        if (from !== to) {
          violations.push(
            `${rec.teamId} week ${rec.week}: ${id} moved ${from} -> ${to} at ${rec.at}, after kickoff`
          );
        }
      }
    }
    lastByTeam.set(rec.teamId, { week: rec.week, lineup: rec.lineup });
  }
  return result('lineup_locks_respected', violations);
}

/**
 * Audits one data read against the archive:
 * - projections: the snapshot was captured by `asOf`, and before each served player's kickoff;
 * - stats: each served player's game was final by `asOf`;
 * - schedule: each game served as final had ended by `asOf`.
 * Returns violations tagged with the invariant they break.
 */
export function auditRead(
  read: DataRead,
  archive: SimArchive,
  kickoffOf: KickoffLookup
): { name: InvariantName; message: string }[] {
  const out: { name: InvariantName; message: string }[] = [];
  const asOf = Date.parse(read.asOf);
  if (read.method === 'getWeekProjections' && read.week !== undefined && (read.playerIds?.length ?? 0) > 0) {
    const captured = archive.weeks[read.week]?.projections.capturedAt;
    const c = captured ? Date.parse(captured) : Number.POSITIVE_INFINITY;
    if (c > asOf)
      out.push({
        name: 'no_future_data',
        message: `week ${read.week} projections served at ${read.asOf} before capture`
      });
    for (const id of read.playerIds ?? []) {
      const kickoff = kickoffOf(id, read.week);
      if (kickoff !== null && c >= kickoff) {
        out.push({
          name: 'pre_kickoff_projections',
          message: `${id} week ${read.week}: projection captured at or after kickoff`
        });
      }
    }
  }
  if (read.method === 'getWeekStats' && read.week !== undefined) {
    for (const id of read.playerIds ?? []) {
      const kickoff = kickoffOf(id, read.week);
      if (kickoff === null || kickoff + GAME_DURATION_MS > asOf) {
        out.push({
          name: 'no_future_data',
          message: `${id} week ${read.week} stats served at ${read.asOf} before his game was final`
        });
      }
    }
  }
  if (read.method === 'getSchedule') {
    const kickoffs = new Map(archive.schedule.map((g) => [g.gameId, Date.parse(g.kickoff)]));
    for (const id of read.finalGameIds ?? []) {
      const k = kickoffs.get(id);
      if (k === undefined || k + GAME_DURATION_MS > asOf) {
        out.push({
          name: 'no_future_data',
          message: `${id} served as final at ${read.asOf} before it ended`
        });
      }
    }
  }
  return out;
}
