import {
  applyLineupMoves,
  isPlayerLocked,
  isStarterSlot,
  RosterSlotSchema,
  validateLineup,
  type LineupEntry,
  type LineupMove,
  type WeekGames
} from '@fantasy/core';
import { z } from 'zod';
import { principalKey } from '../../auth/principal.js';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import { requireMember, requireTeamOwner } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { LeagueIdSchema, TeamIdSchema } from '../../league/views.js';
import { matchPlayers } from '../../players/match.js';
import { playerSelectorShape, PlayerRefSchema, toPlayerRef, type Player } from '../../players/model.js';
import { defineOperation, withWarnings } from '../../registry/operation.js';
import { resolveLineup, rosterPlayers, toRosterPlayer } from '../../season/lineups.js';
import {
  issueWarnings,
  leagueWeek,
  LineupWeekSchema,
  loadWeekData,
  RosterEntrySchema,
  rosterEntries
} from './views.js';

const MoveSchema = z
  .object({
    ...playerSelectorShape,
    slot: RosterSlotSchema.describe('Where to put him: a starting slot the league uses, BN (bench), or IR.')
  })
  .describe('One player and the slot to move him to.');

export const setLineup = defineOperation({
  name: 'set_lineup',
  method: 'PUT',
  path: '/leagues/{leagueId}/teams/{teamId}/lineup',
  summary: "Move players between slots in your team's lineup",
  description: [
    'Moves players to slots for a week (default: the current week). Pass `moves`, each a player (`playerId` preferred, or `player` name) and a `slot`: a starting slot (QB, RB, WR, TE, W/R/T, K, DEF, ...), BN, or IR. Players you do not list stay where they are.',
    'Nobody is displaced for you: to start a bench player in a full slot, also move one of that slot’s players to BN in the same call (a swap is two moves). The result must be a legal lineup, or nothing changes and INVALID_LINEUP lists every problem with its fix (ineligible position, overfilled slot, IR without an IR status, a player not on your roster).',
    "Each player locks at his game's kickoff: moving a locked player, or moving someone into a locked player's slot in a way that moves him, returns PLAYER_LOCKED. get_roster shows `locked` per player.",
    'Starting a player on bye or ruled out is allowed but returns a warning. Only the team owner or the agent that plays the team can set its lineup, during the regular season and playoffs.'
  ].join(' '),
  tags: ['season'],
  mutation: true,
  input: z.object({
    leagueId: LeagueIdSchema,
    teamId: TeamIdSchema,
    week: LineupWeekSchema,
    moves: z.array(MoveSchema).min(1).max(40).describe('The moves to make, applied together.')
  }),
  output: z.object({
    teamId: z.string(),
    week: z.number().int(),
    changed: z
      .array(z.object({ player: PlayerRefSchema, from: RosterSlotSchema, to: RosterSlotSchema }))
      .describe('Players whose slot changed.'),
    players: z.array(RosterEntrySchema).describe('The whole lineup after the change.')
  }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const { league } = access;
    const team = requireTeamOwner(access, input.teamId);
    const now = ctx.clock.now();
    assertAction('set_lineup', league, access.actor, now);
    const week = leagueWeek(league, input.week);
    if (league.week !== null && week < league.week) {
      throw new ApiError(
        'INVALID_INPUT',
        `Week ${week} is over; lineups can only change from week ${league.week} on.`,
        {
          fix: `Leave week out, or pass week ${league.week} or later.`
        }
      );
    }
    const [current, players, data] = await Promise.all([
      resolveLineup(ctx.repos, team, week),
      rosterPlayers(ctx.repos, team),
      loadWeekData(ctx, league, week, team.roster)
    ]);
    const moves: LineupMove[] = [];
    for (const move of input.moves) {
      moves.push({ playerId: await resolveMovePlayer(ctx, [...players.values()], move), slot: move.slot });
    }
    const next = applyLineupMoves(current.entries, moves);
    const check = validateLineup(
      league.settings,
      team.roster.map((id) => toRosterPlayer(id, players.get(id))),
      next,
      { games: data.games, now, previousLineup: current.entries }
    );
    if (!check.valid) {
      const locked = check.errors.filter((e) => e.code === 'PLAYER_LOCKED');
      const shown = locked.length > 0 ? locked : check.errors;
      throw new ApiError(
        locked.length > 0 ? 'PLAYER_LOCKED' : 'INVALID_LINEUP',
        shown.map((e) => e.message).join(' '),
        {
          fix: `${shown.map((e) => e.fix).join(' ')} Nothing was changed; get_roster shows the current lineup and which players are locked.`,
          details: {
            issues: check.errors.map(({ code, path, message, fix }) => ({ code, path, message, fix })),
            // The players whose kickoff blocked the change, so a client can name them (#193).
            lockedPlayerIds: locked.map((e) => e.path.replace(/^lineup\./, ''))
          }
        }
      );
    }
    await ctx.repos.lineups.put([
      {
        leagueId: league.id,
        teamId: team.id,
        week,
        entries: [
          ...check.lineup,
          ...(await frozenDeparted(ctx, current.stored, team.roster, data.games, now))
        ],
        updatedAt: now.toISOString(),
        updatedBy: principalKey(ctx.principal)
      }
    ]);
    const before = new Map(current.entries.map((e) => [e.playerId, e.slot]));
    const changed = check.lineup.flatMap((e) => {
      const from = before.get(e.playerId) ?? 'BN';
      const player = players.get(e.playerId);
      return from === e.slot || player === undefined
        ? []
        : [{ player: toPlayerRef(player), from, to: e.slot }];
    });
    return withWarnings(
      { teamId: team.id, week, changed, players: rosterEntries(check.lineup, players, data, now) },
      issueWarnings(check.warnings)
    );
  }
});

/**
 * Starters from the stored lineup who locked and have since left the roster. They stay in the saved
 * lineup, so the week is still scored with them (a starter freezes at kickoff; season/scoring.ts).
 */
async function frozenDeparted(
  ctx: Ctx,
  stored: readonly LineupEntry[],
  roster: readonly string[],
  games: WeekGames,
  now: Date
): Promise<LineupEntry[]> {
  const departed = stored.filter((e) => isStarterSlot(e.slot) && !roster.includes(e.playerId));
  if (departed.length === 0) return [];
  const teams = new Map(
    (await ctx.repos.players.getMany(departed.map((e) => e.playerId))).map((p) => [p.id, p.team])
  );
  return departed.filter((e) => isPlayerLocked({ nflTeam: teams.get(e.playerId) ?? null }, games, now));
}

/** A move's player id: the id given, else the name matched against the roster first, then everyone. */
async function resolveMovePlayer(
  ctx: Ctx,
  roster: readonly Player[],
  move: { playerId?: string | undefined; player?: string | undefined }
): Promise<string> {
  if (move.playerId !== undefined) return move.playerId;
  const name = move.player ?? '';
  if (name.trim().length === 0) return (await ctx.data.players.resolve({})).id;
  const matches = matchPlayers(roster, { query: name });
  const best = matches[0];
  if (best === undefined) return (await ctx.data.players.resolve({ player: name })).id;
  const top = matches.filter((m) => m.score === best.score);
  if (top.length > 1) {
    throw new ApiError('AMBIGUOUS_PLAYER', `"${name}" matches ${top.length} players on this roster.`, {
      fix: 'Retry with `playerId` set to one of the candidate ids.',
      details: { player: name, candidates: top.map((m) => toPlayerRef(m.player)) }
    });
  }
  return best.player.id;
}
