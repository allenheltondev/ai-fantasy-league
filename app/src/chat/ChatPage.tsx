import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { apiFetch } from '../api';
import { useYourTeamId } from '../routes/leagueContext';
import {
  createChatApi,
  DEFAULT_ROOM_ID,
  dmRoomId,
  type ChatApi,
  type ChatMessage,
  type ChatRoom,
  type ChatTeam
} from './api';
import { connectMomento, type Connect } from './realtime';
import { RoomChat } from './RoomChat';
import { RoomList } from './RoomList';
import { RoomSwitcher } from './RoomSwitcher';
import { useChatRooms } from './useChatRooms';

export { highlightMentions, MAX_MESSAGE_LENGTH, mentionQuery, suggestTeams } from './RoomChat';

/**
 * League chat (#71, #144): the room list (a sidebar on desktop, a room switcher sheet on phones)
 * and the open room, chosen by `?room=` so a toast or a link can open any room.
 */

const defaultApi = createChatApi(apiFetch);
const ROOMS_REFRESH_MS = 10_000;

export function ChatPage({
  api = defaultApi,
  connect = connectMomento,
  yourTeamId,
  roomsRefreshMs = ROOMS_REFRESH_MS
}: {
  api?: ChatApi;
  connect?: Connect;
  /** Defaults to the league layout's (the viewer's seat). */
  yourTeamId?: string | null;
  roomsRefreshMs?: number | null;
}) {
  const { leagueId = '' } = useParams();
  const layoutTeam = useYourTeamId();
  return (
    <LeagueChat
      key={leagueId}
      leagueId={leagueId}
      api={api}
      connect={connect}
      yourTeamId={yourTeamId === undefined ? layoutTeam : yourTeamId}
      roomsRefreshMs={roomsRefreshMs}
    />
  );
}

function LeagueChat({
  leagueId,
  api,
  connect,
  yourTeamId,
  roomsRefreshMs
}: {
  leagueId: string;
  api: ChatApi;
  connect: Connect;
  yourTeamId: string | null;
  roomsRefreshMs: number | null;
}) {
  const [params, setParams] = useSearchParams();
  const rooms = useChatRooms(leagueId, api, roomsRefreshMs);
  const [teams, setTeams] = useState<ChatTeam[]>([]);
  const [picked, setPicked] = useState<ChatRoom | null>(null);
  useEffect(() => {
    api.teams(leagueId).then(setTeams, () => undefined);
  }, [leagueId, api]);

  const roomId = params.get('room') ?? rooms.defaultRoomId;
  const room = resolveRoom(roomId, rooms.rooms, picked, teams, yourTeamId);
  // A matchup room open when its week ends drops off the live list (as does one opened by a link
  // to a past week): read it from its week's list, so it shows archived, not a stale live copy.
  // One read at a time; a failed one is tried again on the next room list (every poll), and only a
  // week's list that answers without the room (no such room) settles it for good.
  const reading = useRef<string | null>(null);
  const missing = useRef<string | null>(null);
  const listed = rooms.rooms.some((r) => r.roomId === roomId);
  const week = matchupRoomWeek(roomId);
  useEffect(() => {
    if (listed || !rooms.loaded || week === null) return;
    if (reading.current === roomId || missing.current === roomId) return;
    if (picked?.roomId === roomId && picked.archived) return;
    reading.current = roomId;
    const done = () => {
      if (reading.current === roomId) reading.current = null;
    };
    api.rooms(leagueId, { pastWeek: week }).then((data) => {
      done();
      const found = data.rooms.find((r) => r.roomId === roomId);
      if (found === undefined) missing.current = roomId;
      else setPicked(found);
    }, done);
  }, [listed, rooms.loaded, rooms.generation, week, roomId, picked, api, leagueId]);
  const { bump, markRead, closeDm } = rooms;
  const onOther = useCallback((message: ChatMessage) => bump(message.roomId ?? DEFAULT_ROOM_ID), [bump]);
  const onSeen = useCallback(() => markRead(roomId), [markRead, roomId]);
  const select = (next: string, found?: ChatRoom) => {
    if (found !== undefined) setPicked(found);
    setParams({ room: next });
  };
  const unreadElsewhere = rooms.rooms
    .filter((r) => r.roomId !== roomId)
    .reduce((sum, r) => sum + r.unreadCount, 0);
  const list = (then?: () => void) => (
    <RoomList
      rooms={rooms.rooms}
      currentRoomId={roomId}
      teams={teams}
      yourTeamId={yourTeamId}
      onSelect={(next, found) => {
        select(next, found);
        then?.();
      }}
      onCloseDm={(closed) => {
        closeDm(closed);
        // Closing the open DM leaves it for the room people land in.
        if (closed === roomId) setParams({ room: rooms.defaultRoomId });
      }}
      loadPastWeek={async (week) => (await api.rooms(leagueId, { pastWeek: week })).rooms}
      pastWeeks={rooms.pastWeeks}
    />
  );

  return (
    <section
      data-testid="league-section-chat"
      aria-label="League chat"
      className="grid min-w-0 gap-3 md:grid-cols-[15rem_minmax(0,1fr)]"
    >
      <aside className="hidden min-w-0 md:block" data-testid="chat-sidebar">
        {list()}
      </aside>
      <div className="flex min-w-0 flex-col gap-3">
        <RoomSwitcher title={room.title} unread={unreadElsewhere}>
          {(close) => list(close)}
        </RoomSwitcher>
        <RoomChat
          key={room.roomId}
          leagueId={leagueId}
          room={room}
          api={api}
          connect={connect}
          onOther={onOther}
          onSeen={onSeen}
          yourTeamId={yourTeamId}
        />
      </div>
    </section>
  );
}

/** The week of a matchup room id (`m-2026-W05-…`), or null for any other room. */
export function matchupRoomWeek(roomId: string): number | null {
  const match = /^m-\d{4}-W(\d{2})-/.exec(roomId);
  return match === null ? null : Number(match[1]);
}

const FIXED_TITLES: Readonly<Record<string, string>> = {
  league: 'League',
  'trash-talk': 'Trash Talk',
  draft: 'Draft',
  trades: 'Trades',
  'waivers-news': 'Waivers & News'
};

/**
 * The open room: from the list, the past-week room just picked, a DM not started yet (named after
 * the other team), or, for a link to a room the list does not have, a stand-in the server judges.
 */
export function resolveRoom(
  roomId: string,
  rooms: readonly ChatRoom[],
  picked: ChatRoom | null,
  teams: readonly ChatTeam[],
  yourTeamId: string | null
): ChatRoom {
  const listed = rooms.find((r) => r.roomId === roomId) ?? (picked?.roomId === roomId ? picked : undefined);
  if (listed !== undefined) return listed;
  const base = { roomId, archived: false, week: null, lastMessageAt: null, unreadCount: 0 };
  const partner =
    yourTeamId === null
      ? undefined
      : teams.find((t) => t.id !== yourTeamId && dmRoomId(yourTeamId, t.id) === roomId);
  if (partner !== undefined) {
    return { ...base, kind: 'dm', title: partner.name, teamIds: [yourTeamId as string, partner.id].sort() };
  }
  const kind = roomId.startsWith('dm-') ? 'dm' : roomId.startsWith('m-') ? 'matchup' : 'fixed';
  return {
    ...base,
    kind,
    title: FIXED_TITLES[roomId] ?? (kind === 'dm' ? 'Direct message' : roomId),
    teamIds: []
  };
}
