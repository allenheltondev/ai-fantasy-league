import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ChatApi, ChatMessage, RealtimeInfo } from './api';
import { resolveRoom } from './ChatPage';
import type { Connect } from './realtime';
import { RoomChat } from './RoomChat';

const message = (id: string, text: string, second: number): ChatMessage => ({
  id,
  leagueId: 'L1',
  roomId: 'draft',
  kind: 'user',
  author: { teamId: 'team-2', teamName: 'Rival', name: 'Rae' },
  text,
  mentionedTeamIds: [],
  event: null,
  createdAt: `2026-09-30T12:00:${String(second).padStart(2, '0')}.000Z`
});

const LIVE: RealtimeInfo = {
  enabled: true,
  token: 'tok',
  endpoint: null,
  cacheName: 'cache',
  topics: { league: 'fantasy.league.L1', global: 'fantasy.global' },
  expiresAt: '2999-01-01T00:00:00.000Z',
  pollIntervalSeconds: 5
};

it('counts a live message that beats the first good history read, even when that read returns it', async () => {
  const history = [message('h1', 'Old news', 1), message('h2', 'Older take', 2)];
  const fresh = message('live', 'On the clock and sweating', 3);
  let catchUp!: (page: { messages: ChatMessage[]; nextCursor: null }) => void;
  const list = vi
    .fn<ChatApi['list']>()
    // The first read fails, so the room moves on to the live subscription with no history...
    .mockRejectedValueOnce(new Error('offline'))
    // ...and its catch-up read is still in flight when a new message arrives live.
    .mockImplementationOnce(() => new Promise((resolve) => (catchUp = resolve)));
  const api: ChatApi = {
    list,
    post: vi.fn(),
    rooms: vi.fn(),
    markRead: vi.fn(),
    realtime: vi.fn(async () => LIVE),
    teams: vi.fn(async () => [])
  };
  let handlers: Parameters<Connect>[1] | null = null;
  const connect: Connect = async (_target, h) => {
    handlers = h;
    return () => undefined;
  };
  const onUnreadChange = vi.fn();
  render(
    <RoomChat
      leagueId="L1"
      room={resolveRoom('draft', [], null, [], null)}
      api={api}
      connect={connect}
      onOther={() => undefined}
      onSeen={() => undefined}
      panel
      visible={false}
      onUnreadChange={onUnreadChange}
    />
  );
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  act(() => handlers?.onChat(fresh));
  expect(onUnreadChange).toHaveBeenLastCalledWith(1);

  // The catch-up read brings the history and, by now, the live message too.
  await act(async () => catchUp({ messages: [...history, fresh], nextCursor: null }));
  expect(await screen.findByText('Old news')).toBeInTheDocument();
  expect(onUnreadChange).toHaveBeenLastCalledWith(1);
});

it('keeps the unread count a previous instance carried until the conversation is seen', async () => {
  const history = [1, 2, 3, 4, 5].map((n) => message(`h${n}`, `Message ${n}`, n));
  let load!: (page: { messages: ChatMessage[]; nextCursor: null }) => void;
  const api: ChatApi = {
    list: vi
      .fn<ChatApi['list']>()
      .mockImplementationOnce(() => new Promise((resolve) => (load = resolve)))
      .mockResolvedValue({ messages: history, nextCursor: null }),
    post: vi.fn(),
    rooms: vi.fn(),
    markRead: vi.fn(async () => undefined),
    realtime: vi.fn(async () => ({ ...LIVE, enabled: false })),
    teams: vi.fn(async () => [])
  };
  const onUnreadChange = vi.fn();
  const chat = (visible: boolean) => (
    <RoomChat
      leagueId="L1"
      room={resolveRoom('draft', [], null, [], null)}
      api={api}
      connect={async () => () => undefined}
      onOther={() => undefined}
      onSeen={() => undefined}
      panel
      visible={visible}
      onUnreadChange={onUnreadChange}
      unreadAtMount={2}
    />
  );
  const view = render(chat(false));
  // Before its history arrives, the remounted conversation still reports the carried two.
  expect(onUnreadChange).toHaveBeenLastCalledWith(2);
  await act(async () => load({ messages: history, nextCursor: null }));
  expect(await screen.findByText('Message 5')).toBeInTheDocument();
  expect(onUnreadChange).toHaveBeenLastCalledWith(2);
  view.rerender(chat(true));
  expect(onUnreadChange).toHaveBeenLastCalledWith(0);
});
