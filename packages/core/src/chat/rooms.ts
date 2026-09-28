import type { MentionTarget } from './mentions.js';
import { fillTemplate, type RenderOptions } from './system-messages.js';

/**
 * Chat rooms (issue #144). A league's chat is split into rooms, each named by a `roomId`:
 *
 * - Fixed rooms every league has: `league` (announcements people can reply to), `trash-talk`,
 *   `draft`, `trades`, and `waivers-news`.
 * - One matchup room per game: `m-<season>-W<nn>-<matchupId>`, derived from the schedule.
 * - Direct messages between two teams: `dm-<teamA>-<teamB>`, the team ids sorted, so both sides
 *   name the same room.
 *
 * Room ids use only letters, digits, `.`, `_`, and `-`, so they fit in a sort key and a URL.
 */

export const FIXED_ROOMS = [
  { id: 'league', title: 'League', description: 'League announcements. Reply to them here.' },
  { id: 'trash-talk', title: 'Trash Talk', description: 'Anything goes (friendly).' },
  { id: 'draft', title: 'Draft', description: 'Draft picks and draft banter.' },
  { id: 'trades', title: 'Trades', description: 'Completed and vetoed trades, and trade talk.' },
  { id: 'waivers-news', title: 'Waivers & News', description: 'Waiver results and player news.' }
] as const;

export type FixedRoomId = (typeof FIXED_ROOMS)[number]['id'];
export const FIXED_ROOM_IDS: readonly FixedRoomId[] = FIXED_ROOMS.map((r) => r.id);

/** The room people land in, and the room every message from before rooms existed belongs to. */
export const DEFAULT_ROOM_ID: FixedRoomId = 'trash-talk';

export const ROOM_KINDS = ['fixed', 'matchup', 'dm'] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

/** Characters a room id may contain (and at most 200 of them). */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

export type ParsedRoom =
  | { kind: 'fixed'; id: FixedRoomId }
  | { kind: 'matchup'; id: string; season: number; week: number; matchupId: string }
  | { kind: 'dm'; id: string; teamIds: [string, string] };

const pad = (week: number) => String(week).padStart(2, '0');

export function isFixedRoomId(roomId: string): roomId is FixedRoomId {
  return (FIXED_ROOM_IDS as readonly string[]).includes(roomId);
}

/** `m-2026-W05-W05-1`: the room for one game of one week. */
export function matchupRoomId(season: number, week: number, matchupId: string): string {
  return `m-${season}-W${pad(week)}-${matchupId}`;
}

/** The DM room between two teams; the same id whichever team opens it. */
export function dmRoomId(teamA: string, teamB: string): string {
  if (teamA === teamB) throw new Error('A direct message needs two different teams.');
  const [a, b] = [teamA, teamB].sort();
  return `dm-${a}-${b}`;
}

const MATCHUP_ROOM = /^m-(\d{4})-W(\d{2})-([A-Za-z0-9._-]+)$/;

/**
 * What a room id names, or null when it is not a room of this league. Team ids may contain `-`, so
 * a DM id is resolved against the league's team ids.
 */
export function parseRoomId(roomId: string, teamIds: readonly string[]): ParsedRoom | null {
  if (!ROOM_ID_PATTERN.test(roomId)) return null;
  if (isFixedRoomId(roomId)) return { kind: 'fixed', id: roomId };
  const matchup = MATCHUP_ROOM.exec(roomId);
  if (matchup !== null) {
    const week = Number(matchup[2]);
    if (week < 1) return null;
    return { kind: 'matchup', id: roomId, season: Number(matchup[1]), week, matchupId: matchup[3] as string };
  }
  if (roomId.startsWith('dm-')) {
    for (const a of teamIds) {
      for (const b of teamIds) {
        if (a < b && roomId === `dm-${a}-${b}`) return { kind: 'dm', id: roomId, teamIds: [a, b] };
      }
    }
  }
  return null;
}

/** The other team in a DM, from one participant's side. */
export function dmPartner(room: { teamIds: readonly [string, string] }, teamId: string): string {
  return room.teamIds[0] === teamId ? room.teamIds[1] : room.teamIds[0];
}

/**
 * Who a message in this room may @mention: anyone, except in a DM, where the only team to mention
 * is the other one.
 */
export function roomMentionTargets(
  room: ParsedRoom,
  targets: readonly MentionTarget[],
  authorTeamId: string | null
): MentionTarget[] {
  if (room.kind !== 'dm') return [...targets];
  const other = authorTeamId === null ? null : dmPartner(room, authorTeamId);
  return targets.filter((t) => t.teamId === other);
}

/** "Wk 5: Big Tuna vs Gridiron Gang". */
export function matchupRoomTitle(week: number, homeTeamName: string, awayTeamName: string): string {
  return `Wk ${week}: ${homeTeamName} vs ${awayTeamName}`;
}

/**
 * Where each system message goes (issue #144). An event type not listed here that has a template
 * goes to `league`. `matchupRooms` also posts one line to each of the week's matchup rooms
 * (`MATCHUP_ROOM_TEMPLATES`).
 */
export interface SystemMessageRoute {
  room: FixedRoomId;
  matchupRooms?: true;
}

export const SYSTEM_MESSAGE_ROUTES: Readonly<Record<string, SystemMessageRoute>> = {
  'Draft Pick Made': { room: 'draft' },
  'Draft Completed': { room: 'draft' },
  'Draft Paused': { room: 'draft' },
  'Draft Resumed': { room: 'draft' },
  'Trade Accepted': { room: 'trades' },
  'Trade Processed': { room: 'trades' },
  'Trade Vetoed': { room: 'trades' },
  'Trade Deadline Passed': { room: 'trades' },
  'Waivers Processed': { room: 'waivers-news' },
  'Player News Alert': { room: 'waivers-news' },
  'Week Provisionally Final': { room: 'league', matchupRooms: true },
  'Week Official Final': { room: 'league', matchupRooms: true },
  'Stat Correction Applied': { room: 'league' },
  'Season Completed': { room: 'league' },
  'Achievement Earned': { room: 'league' },
  'Model Power Rankings': { room: 'league' },
  'Member Joined': { room: 'league' },
  'Member Left': { room: 'league' },
  'Agent Seat Changed': { room: 'league' },
  'Agent Budget Exceeded': { room: 'league' },
  'Settings Changed': { room: 'league' }
};

export function systemMessageRoute(detailType: string): SystemMessageRoute {
  return SYSTEM_MESSAGE_ROUTES[detailType] ?? { room: 'league' };
}

/** A matchup decided by less than this is a close one: its room's final line is a chat moment. */
export const CLOSE_MATCHUP_MARGIN = 5;

/**
 * The one line each matchup room gets when its week goes final. Rendered with the matchup's score
 * line (`homeTeamId`, `awayTeamId`, `homeScore`, `awayScore`) plus the event's `week`.
 */
export const MATCHUP_ROOM_TEMPLATES: Readonly<
  Record<string, { text: readonly string[]; moment?: (line: Record<string, unknown>) => boolean }>
> = {
  'Week Provisionally Final': {
    text: [
      'Final (provisional): {team:homeTeamId} {points:homeScore}, {team:awayTeamId} {points:awayScore}.',
      'This matchup is final (provisional).'
    ],
    moment: (line) =>
      typeof line.homeScore === 'number' &&
      typeof line.awayScore === 'number' &&
      Math.abs(line.homeScore - line.awayScore) < CLOSE_MATCHUP_MARGIN
  },
  'Week Official Final': {
    text: [
      'Official: {team:homeTeamId} {points:homeScore}, {team:awayTeamId} {points:awayScore}. This room is now archived.',
      'This matchup is official. This room is now archived.'
    ]
  }
};

/** A matchup room's final line, or null when the event type posts none to matchup rooms. */
export function renderMatchupRoomLine(
  detailType: string,
  line: Record<string, unknown>,
  options: Pick<RenderOptions, 'teamName'>
): { text: string; moment: boolean } | null {
  const template = MATCHUP_ROOM_TEMPLATES[detailType];
  if (template === undefined) return null;
  for (const alternative of template.text) {
    const text = fillTemplate(alternative, line, options);
    if (text !== null) return { text, moment: template.moment?.(line) ?? false };
  }
  return null;
}
