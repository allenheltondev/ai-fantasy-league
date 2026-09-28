import { describe, expect, it, vi } from 'vitest';
import { createChatApi, dmRoomId, mergeMessages, type ChatMessage, type RealtimeInfo } from './api';
import { connectMomento, liveTarget, parseChatItem } from './realtime';

vi.mock('@gomomento/sdk-web', () => {
  class Subscription {
    unsubscribe = vi.fn();
  }
  let mode: 'ok' | 'fail' = 'ok';
  const state: {
    options?: { onItem(item: { valueString(): string }): void; onError(): void };
    last?: Subscription;
  } = {};
  return {
    __state: state,
    __mode: (m: 'ok' | 'fail') => {
      mode = m;
    },
    TopicConfigurations: { Browser: { latest: () => 'browser' } },
    CredentialProvider: { fromDisposableToken: (p: unknown) => ({ disposable: p }) },
    TopicSubscribe: { Subscription },
    TopicClient: class {
      constructor(readonly props: unknown) {}
      async subscribe(_cache: string, _topic: string, options: NonNullable<typeof state.options>) {
        state.options = options;
        if (mode === 'fail') return { error: true };
        state.last = new Subscription();
        return state.last;
      }
    }
  };
});

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

  it('needs a complete token to go live', () => {
    const info: RealtimeInfo = {
      enabled: true,
      token: 't',
      endpoint: null,
      cacheName: 'c',
      topics: { league: 'l', global: 'g' },
      expiresAt: null,
      pollIntervalSeconds: 5
    };
    expect(liveTarget(info)).toEqual({ token: 't', cacheName: 'c', topics: ['l'] });
    expect(liveTarget({ ...info, topics: { league: 'l', global: 'g', team: 'tm' } })).toEqual({
      token: 't',
      cacheName: 'c',
      topics: ['l', 'tm']
    });
    expect(liveTarget({ ...info, enabled: false })).toBeNull();
    expect(liveTarget({ ...info, token: null })).toBeNull();
    expect(liveTarget({ ...info, cacheName: null })).toBeNull();
    expect(liveTarget({ ...info, topics: null })).toBeNull();
  });

  it('subscribes with the Momento web SDK', async () => {
    const sdk = (await import('@gomomento/sdk-web')) as unknown as {
      __state: {
        options: { onItem(item: { valueString(): string }): void; onError(): void };
        last: { unsubscribe: () => void };
      };
      __mode(m: 'ok' | 'fail'): void;
    };
    const onChat = vi.fn();
    const onError = vi.fn();
    const close = await connectMomento({ token: 't', cacheName: 'c', topics: ['l'] }, { onChat, onError });
    sdk.__state.options.onItem({ valueString: () => JSON.stringify({ type: 'chat', message }) });
    sdk.__state.options.onItem({ valueString: () => '{}' });
    sdk.__state.options.onError();
    expect(onChat).toHaveBeenCalledExactlyOnceWith(message);
    expect(onError).toHaveBeenCalledOnce();
    close();
    expect(sdk.__state.last.unsubscribe).toHaveBeenCalled();
    sdk.__mode('fail');
    await expect(
      connectMomento({ token: 't', cacheName: 'c', topics: ['l', 'tm'] }, { onChat, onError })
    ).rejects.toThrow(/Could not subscribe/);
    sdk.__mode('ok');
    // Two topics: one close unsubscribes both.
    const both = await connectMomento(
      { token: 't', cacheName: 'c', topics: ['l', 'tm'] },
      { onChat, onError }
    );
    both();
    expect(sdk.__state.last.unsubscribe).toHaveBeenCalled();
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
