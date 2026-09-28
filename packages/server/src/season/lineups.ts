import {
  isPlayerLocked,
  normalizePlayerStatus,
  playerKickoff,
  reconcileLineup,
  weekEndsAt,
  type LineupEntry,
  type PlayerStatus,
  type RosterPlayer,
  type WeekGames
} from '@fantasy/core';
import type { ScheduledGame } from '@fantasy/data';
import { ApiError } from '../errors.js';
import type { EventPublisher } from '../events/publisher.js';
import type { Logger } from '../log.js';
import type { Player } from '../players/model.js';
import type { ReferenceStore } from '../repos/reference.js';
import type { League, Repos, Team } from '../repos/types.js';
import { STATS_GAME_DURATION_MS } from './window.js';

/**
 * Shared season-loop plumbing: what a team's lineup is in a week, the NFL games that lock players,
 * and the core view of a rostered player. Operations and the season jobs both use it, so it takes
 * plain dependencies rather than a request context.
 */
export interface SeasonDeps {
  repos: Repos;
  reference: ReferenceStore;
  events: EventPublisher;
  log: Logger;
}

/** A week's regular-season NFL games (the fantasy playoffs run in NFL regular-season weeks too). */
export async function weekGames(
  reference: ReferenceStore,
  season: number,
  week: number
): Promise<ScheduledGame[]> {
  const games = await reference.schedule.getWeek(season, week);
  return games.filter((g) => g.seasonType === 'regular');
}

/** Kickoff by NFL team, the shape core's lock and bye checks take. A team without a game is on bye. */
export function gamesByTeam(games: readonly ScheduledGame[]): WeekGames {
  const byTeam: Record<string, { kickoff: string }> = {};
  for (const g of games) {
    byTeam[g.homeTeam] = { kickoff: g.kickoff };
    byTeam[g.awayTeam] = { kickoff: g.kickoff };
  }
  return byTeam;
}

/** The league's current week as the lock checks see it. */
export interface WeekLocks {
  games: WeekGames;
  /** When the week's last game is over, or null with no games (or before the season). */
  endsAt: string | null;
  /** True once the player's game this week has kicked off (players on bye never lock). */
  isLocked(player: Pick<Player, 'team'>): boolean;
  /** His game's kickoff this week, or null on a bye. */
  kickoff(player: Pick<Player, 'team'>): Date | null;
}

/**
 * The lock state of the league's current week at `now`, from the stored NFL schedule. Drops,
 * waiver awards, and pickups all check it, the same way set_lineup does.
 */
export async function weekLocks(reference: ReferenceStore, league: League, now: Date): Promise<WeekLocks> {
  const scheduled = league.week === null ? [] : await weekGames(reference, league.season, league.week);
  const games = gamesByTeam(scheduled);
  return {
    games,
    endsAt: weekEndsAt(scheduled, STATS_GAME_DURATION_MS),
    isLocked: (player) => isPlayerLocked({ nflTeam: player.team }, games, now),
    kickoff: (player) => playerKickoff({ nflTeam: player.team }, games)
  };
}

/** Refuses to release a player whose game has kicked off: his points this week are already known. */
export function assertNotLocked(locks: WeekLocks, player: Pick<Player, 'id' | 'name' | 'team'>): void {
  if (!locks.isLocked(player)) return;
  const kickoff = locks.kickoff(player)?.toISOString() ?? '';
  throw new ApiError('PLAYER_LOCKED', `${player.name} is locked: his game kicked off at ${kickoff}.`, {
    fix: `A locked player cannot be dropped until the week rolls over. Keep ${player.name}, or drop someone whose game has not started (get_roster shows \`locked\` per player).`,
    details: { playerId: player.id, kickoff }
  });
}

/** The stored player's availability as core's normalized status. */
export function playerStatus(player: Player): PlayerStatus {
  const roster =
    player.status === 'injured_reserve'
      ? 'Injured Reserve'
      : player.status === 'inactive'
        ? 'Inactive'
        : null;
  return normalizePlayerStatus(player.injuryStatus, roster);
}

/** Core's view of a rostered player. A player missing from the universe can only sit on the bench. */
export function toRosterPlayer(playerId: string, player: Player | undefined): RosterPlayer {
  if (player === undefined) return { playerId, name: playerId, positions: [], status: 'na', nflTeam: null };
  return {
    playerId,
    name: player.name,
    positions: [player.position],
    status: playerStatus(player),
    nflTeam: player.team
  };
}

/** The team's players, in roster order, with their stored records (missing ones are left out). */
export async function rosterPlayers(repos: Repos, team: Team): Promise<Map<string, Player>> {
  const players = await repos.players.getMany(team.roster);
  return new Map(players.map((p) => [p.id, p]));
}

export interface TeamLineup {
  /** Every rostered player with a slot. */
  entries: LineupEntry[];
  /**
   * The lineup as stored (saved for the week or carried forward), before reconciling with the
   * roster: it can still list a starter who has since left the roster. Scoring freezes locked
   * starters from it (core `frozenLineup`).
   */
  stored: LineupEntry[];
  /** True when the team saved a lineup for exactly this week. */
  saved: boolean;
  /** The week the lineup came from when it was carried forward, or null. */
  carriedFromWeek: number | null;
}

/**
 * A team's lineup for `week`: the one saved for that week, or else the latest earlier one carried
 * forward. Either way it is reconciled with the current roster (new players on the bench, departed
 * ones removed), so it always lists exactly the rostered players.
 */
export async function resolveLineup(repos: Repos, team: Team, week: number): Promise<TeamLineup> {
  const own = await repos.lineups.get(team.leagueId, team.id, week);
  const base = own ?? (await repos.lineups.latest(team.leagueId, team.id, week));
  return {
    entries: reconcileLineup(base?.entries ?? [], team.roster),
    stored: base?.entries ?? [],
    saved: own !== null,
    carriedFromWeek: own === null && base !== null ? base.week : null
  };
}

/** Every team's lineup for `week` with one query, falling back per team to a carried-forward lineup. */
export async function resolveWeekLineups(
  repos: Repos,
  teams: readonly Team[],
  week: number
): Promise<Map<string, TeamLineup>> {
  const saved = new Map<string, LineupEntry[]>();
  const leagueId = teams[0]?.leagueId;
  if (leagueId !== undefined) {
    for (const l of await repos.lineups.listWeek(leagueId, week)) saved.set(l.teamId, l.entries);
  }
  const out = new Map<string, TeamLineup>();
  for (const team of teams) {
    const own = saved.get(team.id);
    out.set(
      team.id,
      own === undefined
        ? await resolveLineup(repos, team, week)
        : { entries: reconcileLineup(own, team.roster), stored: own, saved: true, carriedFromWeek: null }
    );
  }
  return out;
}

/** Every league in `regular_season` or `playoffs`: two GSI2 `LEAGUEPHASE#<phase>` queries. */
export async function listInSeason(repos: Pick<Repos, 'leagues'>): Promise<League[]> {
  const [regular, playoffs] = await Promise.all([
    repos.leagues.listByPhase('regular_season'),
    repos.leagues.listByPhase('playoffs')
  ]);
  return [...regular, ...playoffs];
}
