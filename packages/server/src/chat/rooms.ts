import {
  DEFAULT_ROOM_ID,
  dmPartner,
  dmRoomId,
  FIXED_ROOMS,
  matchupRoomId,
  matchupRoomTitle,
  parseRoomId,
  ROOM_KINDS,
  type ParsedRoom
} from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { ApiError } from '../errors.js';
import type { LeagueAccess } from '../league/access.js';
import { actorTeam } from '../league/phase.js';
import { seatTenureStart, type Matchup } from '../repos/types.js';

/**
 * Chat rooms as a caller sees them (issue #144): which rooms exist in a league, who may read and
 * post in each, and when a matchup room is archived.
 *
 * - Fixed rooms: every member reads and posts.
 * - Matchup rooms: derived from the schedule, nothing stored. Every member reads and posts while
 *   the room is live: the current week, and last week until it is official. Then the room is
 *   archived: still readable, no new messages.
 * - DMs: only the two teams' principals (a team's owner, or the agent playing it) read or post.
 *   The commissioner is not one of them unless it is their own team.
 */

export const RoomIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/)
  .describe(
    'A room from list_chat_rooms: `league`, `trash-talk`, `draft`, `trades`, `waivers-news`, a matchup room `m-<season>-W<nn>-<matchupId>`, or a DM `dm-<teamA>-<teamB>` (the two team ids sorted).'
  );

export const ChatRoomSchema = z.object({
  roomId: z.string(),
  kind: z
    .enum(ROOM_KINDS)
    .describe('`fixed`: a league-wide room. `matchup`: one game of one week. `dm`: two teams only.'),
  title: z.string().describe('"Trash Talk", "Wk 5: Big Tuna vs Gridiron Gang", or the other team in a DM.'),
  archived: z.boolean().describe('Read-only: a matchup room whose week is official.'),
  week: z.number().int().nullable().describe('Matchup rooms: the week.'),
  teamIds: z.array(z.string()).describe('Matchup rooms: home and away. DMs: both teams. Fixed rooms: empty.')
});
export type ChatRoom = z.infer<typeof ChatRoomSchema>;

export interface ResolvedRoom {
  room: ChatRoom;
  parsed: ParsedRoom;
  /** The oldest message time the caller may read here (`roomVisibleFrom`); null for everything. */
  visibleFrom: string | null;
}

/**
 * A DM belongs to the people who wrote it, not to the seat: whoever plays a team now (its owner, or
 * the agent) reads only the team's DM messages created since they took the seat (`occupiedSince`).
 * The other team, which never changed hands, still reads its whole history. Other rooms have no
 * floor.
 */
export function roomVisibleFrom(access: LeagueAccess, room: Pick<ChatRoom, 'kind'>): string | null {
  if (room.kind !== 'dm') return null;
  const team = actorTeam(access.actor);
  return team === null ? null : seatTenureStart(team);
}

function roomNotFound(roomId: string, fix?: string): ApiError {
  return new ApiError('ROOM_NOT_FOUND', `Chat room "${roomId}" does not exist in this league.`, {
    fix:
      fix ??
      `Call list_chat_rooms for the rooms you can use, or leave roomId out for "${DEFAULT_ROOM_ID}". A DM room is "dm-" plus the two team ids sorted and joined with "-".`
  });
}

const fixedRoom = (id: string, title: string): ChatRoom => ({
  roomId: id,
  kind: 'fixed',
  title,
  archived: false,
  week: null,
  teamIds: []
});

/** True when the week's matchup rooms are read-only: two or more weeks back, or official. */
async function weekArchived(ctx: Ctx, access: LeagueAccess, week: number): Promise<boolean> {
  const current = access.league.week ?? 0;
  if (week < current - 1) return true;
  const official = await ctx.repos.history.getOfficialWeek(access.league.id, week);
  return official?.status === 'complete';
}

function matchupRoom(access: LeagueAccess, matchup: Matchup, archived: boolean): ChatRoom {
  const name = (teamId: string) => access.teams.find((t) => t.id === teamId)?.name ?? teamId;
  return {
    roomId: matchupRoomId(access.league.season, matchup.week, matchup.id),
    kind: 'matchup',
    title: matchupRoomTitle(matchup.week, name(matchup.homeTeamId), name(matchup.awayTeamId)),
    archived,
    week: matchup.week,
    teamIds: [matchup.homeTeamId, matchup.awayTeamId]
  };
}

function dmRoom(access: LeagueAccess, teamIds: readonly [string, string], viewerTeamId: string): ChatRoom {
  const other = dmPartner({ teamIds }, viewerTeamId);
  return {
    roomId: dmRoomId(teamIds[0], teamIds[1]),
    kind: 'dm',
    title: access.teams.find((t) => t.id === other)?.name ?? other,
    archived: false,
    week: null,
    teamIds: [...teamIds]
  };
}

/**
 * The room, if the caller may read it. Errors: ROOM_NOT_FOUND for a room this league does not have
 * (including a matchup room of a future week); FORBIDDEN for someone else's DM.
 */
export async function resolveRoom(ctx: Ctx, access: LeagueAccess, roomId: string): Promise<ResolvedRoom> {
  const parsed = parseRoomId(
    roomId,
    access.teams.map((t) => t.id)
  );
  if (parsed === null) throw roomNotFound(roomId);
  switch (parsed.kind) {
    case 'fixed': {
      const fixed = FIXED_ROOMS.find((r) => r.id === parsed.id) as (typeof FIXED_ROOMS)[number];
      return { parsed, room: fixedRoom(fixed.id, fixed.title), visibleFrom: null };
    }
    case 'matchup': {
      const { league } = access;
      const matchup =
        parsed.season === league.season && league.week !== null && parsed.week <= league.week
          ? (await ctx.repos.schedule.listMatchups(league.id, parsed.week)).find(
              (m) => m.id === parsed.matchupId
            )
          : undefined;
      if (matchup === undefined) {
        throw roomNotFound(
          roomId,
          'Matchup rooms exist for this season’s weeks up to the current one. Call list_chat_rooms for this week’s matchup rooms.'
        );
      }
      return {
        parsed,
        room: matchupRoom(access, matchup, await weekArchived(ctx, access, parsed.week)),
        visibleFrom: null
      };
    }
    case 'dm': {
      const mine = actorTeam(access.actor)?.id ?? null;
      if (mine === null || !parsed.teamIds.includes(mine)) {
        throw new ApiError('FORBIDDEN', 'Only the two teams in a direct message can read or post in it.', {
          fix:
            mine === null
              ? 'You have no team in this league, so you have no direct messages. Use a league room such as "trash-talk".'
              : `Use your own DM rooms from list_chat_rooms, or start one by posting to "dm-" plus your team id and the other team's id, sorted and joined with "-".`
        });
      }
      const room = dmRoom(access, parsed.teamIds, mine);
      return { parsed, room, visibleFrom: roomVisibleFrom(access, room) };
    }
  }
}

/** Refuses a new message in an archived room. */
export function requireOpenRoom(room: ChatRoom): void {
  if (!room.archived) return;
  throw new ApiError('ROOM_ARCHIVED', `"${room.title}" is archived: its week is official.`, {
    fix: 'Read it with get_chat, but post in this week’s matchup room or in "trash-talk" instead (see list_chat_rooms).'
  });
}

/**
 * Every room the caller can see: the fixed rooms, the live matchup rooms (or, with `pastWeek`, that
 * week's), and the caller's DMs that have messages.
 */
export async function visibleRooms(
  ctx: Ctx,
  access: LeagueAccess,
  options: { pastWeek?: number } = {}
): Promise<ChatRoom[]> {
  const rooms = FIXED_ROOMS.map((r) => fixedRoom(r.id, r.title));
  const current = access.league.week;
  if (current !== null) {
    const weeks =
      options.pastWeek === undefined
        ? [current, current - 1].filter((w) => w >= 1)
        : options.pastWeek <= current
          ? [options.pastWeek]
          : [];
    for (const week of weeks) {
      const archived = await weekArchived(ctx, access, week);
      if (archived && options.pastWeek === undefined) continue;
      const matchups = await ctx.repos.schedule.listMatchups(access.league.id, week);
      rooms.push(...matchups.map((m) => matchupRoom(access, m, archived)));
    }
  }
  const mine = actorTeam(access.actor)?.id ?? null;
  if (mine !== null) {
    const teamIds = access.teams.map((t) => t.id);
    for (const roomId of await ctx.repos.chat.dmRooms(access.league.id, mine)) {
      const parsed = parseRoomId(roomId, teamIds);
      if (parsed?.kind === 'dm' && parsed.teamIds.includes(mine))
        rooms.push(dmRoom(access, parsed.teamIds, mine));
    }
  }
  return rooms;
}
