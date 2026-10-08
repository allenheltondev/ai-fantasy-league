import { describe, expect, it, vi } from 'vitest';
import { createChatApi, dmRoomId, mergeMessages, type ChatMessage, type RealtimeInfo } from './api';
import { connectLiveChat, liveTarget, parseChatItem, subscribeToken } from './realtime';

const auth = vi.hoisted(() => ({ token: 'id-token' as string | null }));
vi.mock('@readysetcloud/ui/auth', () => ({ getFreshIdToken: async () => auth.token }));

const events = vi.hoisted(() => ({
  calls: [] as { target: unknown; token: string; handlers: { onData(raw: string): void; onError(): void } }[],
  close: vi.fn()
}));
vi.mock('../realtime/appsyncEvents', () => ({
  subscribeChannels: async (
    target: unknown,
    token: string,
    handlers: { onData(raw: string): void; onError(): void }
  ) => {
    events.calls.push({ target, token, handlers });
    return events.close;
  }
}));

const message: ChatMessage = {
  id: 'm1',
  leagueId: 'L1',
  kind: 'user',
  author: { teamId: 'team-1', teamName: 'A', name: 'Allen' },
  text: 'hi',
  mentionedTeamIds: [],
  event: null,
  createdAt: '2026-10-04T15:00:00.000Z'
};

describe('realtime helpers', () => {
  it('reads chat items and ignores everything else', () => {
    expect(parseChatItem(JSON.stringify({ type: 'chat', leagueId: 'L1', message }))).toEqual(message);
    expect(parseChatItem(JSON.stringify({ type: 'event', detailType: 'Draft Pick Made' }))).toBeNull();
    expect(parseChatItem(JSON.stringify({ type: 'chat', message: null }))).toBeNull();
    expect(parseChatItem(JSON.stringify({ type: 'chat', message: { id: 'x' } }))).toBeNull();
    expect(parseChatItem('not json')).toBeNull();
  });

  it('needs a complete config to go live', () => {
    const info: RealtimeInfo = {
      enabled: true,
      httpHost: 'api.example',
      realtimeHost: 'realtime.example',
      channels: { league: 'l', global: 'g' },
      refreshAt: null,
      pollIntervalSeconds: 5
    };
    const endpoint = { httpHost: 'api.example', realtimeHost: 'realtime.example' };
    expect(liveTarget(info)).toEqual({ ...endpoint, channels: ['l'] });
    expect(liveTarget({ ...info, channels: { league: 'l', global: 'g', team: 'tm' } })).toEqual({
      ...endpoint,
      channels: ['l', 'tm']
    });
    expect(liveTarget({ ...info, enabled: false })).toBeNull();
    expect(liveTarget({ ...info, httpHost: null })).toBeNull();
    expect(liveTarget({ ...info, realtimeHost: null })).toBeNull();
    expect(liveTarget({ ...info, channels: null })).toBeNull();
  });

  it('subscribes over AppSync Events with the ID token, passing on chat messages only', async () => {
    const onChat = vi.fn();
    const onError = vi.fn();
    const target = { httpHost: 'api.example', realtimeHost: 'realtime.example', channels: ['l', 'tm'] };
    const close = await connectLiveChat(target, { onChat, onError });
    expect(events.calls[0]).toMatchObject({ target, token: 'id-token' });
    const { handlers } = events.calls[0]!;
    handlers.onData(JSON.stringify({ type: 'chat', message }));
    handlers.onData(JSON.stringify({ type: 'event', detailType: 'Draft Pick Made' }));
    handlers.onError();
    expect(onChat).toHaveBeenCalledExactlyOnceWith(message);
    expect(onError).toHaveBeenCalledOnce();
    close();
    expect(events.close).toHaveBeenCalledOnce();
  });

  it('needs a signed-in person to subscribe', async () => {
    expect(await subscribeToken()).toBe('id-token');
    auth.token = null;
    try {
      await expect(subscribeToken()).rejects.toThrow(/Sign in/);
      await expect(
        connectLiveChat(
          { httpHost: 'h', realtimeHost: 'r', channels: ['l'] },
          { onChat: vi.fn(), onError: vi.fn() }
        )
      ).rejects.toThrow(/Sign in/);
    } finally {
      auth.token = 'id-token';
    }
  });
});

describe('chat api', () => {
  it('calls the chat operations', async () => {
    const calls: [string, unknown][] = [];
    const fetch = vi.fn(async (path: string, request?: unknown) => {
      calls.push([path, request]);
      if (
        path.endsWith('/chat/messages') &&
        (request as { method?: string } | undefined)?.method === 'POST'
      ) {
        return { data: { message }, league: null, warnings: [] };
      }
      if (path.endsWith('/chat/messages'))
        return { data: { messages: [message], nextCursor: null }, league: null, warnings: [] };
      if (path.endsWith('/realtime')) return { data: { enabled: false }, league: null, warnings: [] };
      if (path.endsWith('/chat/rooms'))
        return { data: { defaultRoomId: 'trash-talk', rooms: [] }, league: null, warnings: [] };
      if (path.endsWith('/read')) return { data: {}, league: null, warnings: [] };
      return {
        data: {
          teams: [
            { id: 'team-1', name: 'A', ownerName: null, extra: true },
            {
              id: 'team-2',
              name: 'B',
              ownerName: null,
              seatType: 'agent',
              manager: { name: 'Mei Park', avatarSeed: 'm', personality: 'The Spreadsheet' }
            },
            { id: 'team-3', name: 'C', ownerName: null, seatType: 'agent' }
          ]
        },
        league: null,
        warnings: []
      };
    });
    const api = createChatApi(fetch as never);
    expect((await api.list('L 1', { limit: 5 })).messages).toEqual([message]);
    expect(await api.list('L1')).toEqual({ messages: [message], nextCursor: null });
    expect(await api.post('L1', 'hi')).toEqual(message);
    expect(await api.realtime('L1')).toEqual({ enabled: false });
    // An AI team answers to its manager's name (#159), and says it is one, with its personality (#177).
    expect(await api.teams('L1')).toEqual([
      { id: 'team-1', name: 'A', ownerName: null, ai: false },
      {
        id: 'team-2',
        name: 'B',
        ownerName: 'Mei Park',
        ai: true,
        avatarSeed: 'm',
        personality: 'The Spreadsheet'
      },
      { id: 'team-3', name: 'C', ownerName: null, ai: true }
    ]);
    expect(calls[0]).toEqual([
      '/leagues/L%201/chat/messages',
      { query: { limit: 5, after: undefined, roomId: undefined } }
    ]);
    expect(calls[2]).toEqual(['/leagues/L1/chat/messages', { method: 'POST', body: { text: 'hi' } }]);
    expect(await api.post('L1', 'psst', 'dm-team-1-team-2')).toEqual(message);
    expect(calls.at(-1)).toEqual([
      '/leagues/L1/chat/messages',
      { method: 'POST', body: { text: 'psst', roomId: 'dm-team-1-team-2' } }
    ]);
    expect(await api.rooms('L1', { pastWeek: 3 })).toEqual({ defaultRoomId: 'trash-talk', rooms: [] });
    expect(calls.at(-1)).toEqual(['/leagues/L1/chat/rooms', { query: { pastWeek: 3 } }]);
    await api.rooms('L1');
    await api.markRead('L1', 'm-2026-W05-W05-1');
    expect(calls.at(-1)).toEqual([
      '/leagues/L1/chat/rooms/m-2026-W05-W05-1/read',
      { method: 'POST', body: {} }
    ]);
    expect(dmRoomId('team-2', 'team-10')).toBe('dm-team-10-team-2');
  });

  it('merges messages by id in time order', () => {
    const a = { ...message, id: 'a', createdAt: '2026-10-04T15:00:01.000Z' };
    const b = { ...message, id: 'b', createdAt: '2026-10-04T15:00:00.000Z' };
    const c = { ...message, id: 'c', createdAt: '2026-10-04T15:00:00.000Z' };
    expect(mergeMessages([a], [c, b, { ...a, text: 'edited' }]).map((m) => [m.id, m.text])).toEqual([
      ['b', 'hi'],
      ['c', 'hi'],
      ['a', 'edited']
    ]);
  });
});
