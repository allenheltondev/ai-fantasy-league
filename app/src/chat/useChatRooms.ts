import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_ROOM_ID, type ChatApi, type ChatRoom } from './api';

export interface ChatRoomsState {
  rooms: ChatRoom[];
  defaultRoomId: string;
  /** Weeks with archived matchup rooms, newest first; null when the server does not say. */
  pastWeeks: number[] | null;
  loaded: boolean;
  /** Re-reads the room list (unread counts, new DMs). */
  refresh(): Promise<void>;
  /** A message arrived in another room: count it, or re-read the list when the room is new. */
  bump(roomId: string): void;
  /** Marks a room read, here at once and on the server. */
  markRead(roomId: string): void;
  /** Closes a DM: off the list at once, and on the server (a failure brings it back). */
  closeDm(roomId: string): void;
}

/**
 * The chat rooms a member can see, with unread counts (list_chat_rooms), kept current by live
 * messages (`bump`) and, while polling, by re-reading every `refreshMs`. `api` must be stable.
 */
export function useChatRooms(leagueId: string, api: ChatApi, refreshMs: number | null): ChatRoomsState {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [defaultRoomId, setDefaultRoomId] = useState(DEFAULT_ROOM_ID);
  const [pastWeeks, setPastWeeks] = useState<number[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const known = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    try {
      const data = await api.rooms(leagueId);
      known.current = new Set(data.rooms.map((r) => r.roomId));
      setRooms(data.rooms);
      setDefaultRoomId(data.defaultRoomId);
      setPastWeeks(data.pastWeeks ?? null);
      setLoaded(true);
    } catch {
      // The next refresh (or live message) tries again; the chat itself still works.
      setLoaded(true);
    }
  }, [leagueId, api]);

  useEffect(() => {
    void refresh();
    if (refreshMs === null) return;
    const timer = setInterval(() => void refresh(), Math.max(50, refreshMs));
    return () => clearInterval(timer);
  }, [refresh, refreshMs]);

  const bump = useCallback(
    (roomId: string) => {
      if (!known.current.has(roomId)) {
        void refresh();
        return;
      }
      setRooms((current) =>
        current.map((r) =>
          r.roomId === roomId ? { ...r, unreadCount: Math.min(100, r.unreadCount + 1) } : r
        )
      );
    },
    [refresh]
  );

  const markRead = useCallback(
    (roomId: string) => {
      setRooms((current) => current.map((r) => (r.roomId === roomId ? { ...r, unreadCount: 0 } : r)));
      api.markRead(leagueId, roomId).catch(() => undefined);
    },
    [leagueId, api]
  );

  const closeDm = useCallback(
    (roomId: string) => {
      setRooms((current) => current.filter((r) => r.roomId !== roomId));
      // Unknown again, so its next message re-reads the list and brings it back.
      known.current.delete(roomId);
      api.closeDm(leagueId, roomId).then(
        () => undefined,
        () => void refresh()
      );
    },
    [leagueId, api, refresh]
  );

  return { rooms, defaultRoomId, pastWeeks, loaded, refresh, bump, markRead, closeDm };
}
