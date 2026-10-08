import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    closeDm: vi.fn(),
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

/** A room whose newest page continues at `c1`, with one older page behind it. */
function pagedRoom(older: () => Promise<{ messages: ChatMessage[]; nextCursor: string | null }>) {
  const list = vi.fn<ChatApi['list']>(async (_leagueId, options = {}) =>
    options.after === 'c1'
      ? older()
      : { messages: [message('m4', 'Fourth', 4), message('m3', 'Third', 3)], nextCursor: 'c1' }
  );
  const api: ChatApi = {
    list,
    post: vi.fn(),
    rooms: vi.fn(),
    markRead: vi.fn(),
    realtime: vi.fn(async () => LIVE),
    teams: vi.fn(async () => []),
    closeDm: vi.fn()
  };
  const onUnreadChange = vi.fn();
  render(
    <RoomChat
      leagueId="L1"
      room={resolveRoom('draft', [], null, [], null)}
      api={api}
      connect={async () => () => undefined}
      onOther={() => undefined}
      onSeen={() => undefined}
      onUnreadChange={onUnreadChange}
    />
  );
  return { list, onUnreadChange };
}

const OLDER = { messages: [message('m2', 'Second', 2), message('m1', 'First', 1)], nextCursor: null };
const texts = () =>
  within(screen.getByRole('list', { name: 'Chat messages' }))
    .queryAllByRole('paragraph')
    .map((p) => p.textContent);

it('pages back through older messages until the room runs out (#144)', async () => {
  const { list, onUnreadChange } = pagedRoom(async () => OLDER);
  await screen.findByText('Third');
  await userEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
  expect(list).toHaveBeenCalledWith('L1', { limit: 50, roomId: 'draft', after: 'c1' });
  await waitFor(() => expect(texts()).toEqual(['First', 'Second', 'Third', 'Fourth']));
  // The last page: nothing older to load, and the older messages are not unread.
  expect(screen.queryByRole('button', { name: 'Load earlier messages' })).not.toBeInTheDocument();
  expect(onUnreadChange).toHaveBeenLastCalledWith(0);
});

it('pages back on reaching the top, keeping the messages being read in place (#144)', async () => {
  pagedRoom(async () => OLDER);
  await screen.findByText('Third');
  const list = screen.getByRole('list', { name: 'Chat messages' });
  // jsdom has no layout: each row is 100px tall in a 150px window.
  let top = 0;
  Object.defineProperty(list, 'scrollHeight', { get: () => list.children.length * 100 });
  Object.defineProperty(list, 'clientHeight', { get: () => 150 });
  Object.defineProperty(list, 'scrollTop', { get: () => top, set: (v: number) => (top = v) });
  top = 5;
  fireEvent.scroll(list);
  await waitFor(() => expect(texts()).toEqual(['First', 'Second', 'Third', 'Fourth']));
  // Three rows (the button and two messages) became four: Third stays where it was, 100px lower.
  expect(top).toBe(105);
});

it('offers a retry when an older page fails to load (#144)', async () => {
  const older = vi
    .fn<() => Promise<typeof OLDER>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(OLDER);
  pagedRoom(older);
  await screen.findByText('Third');
  await userEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load earlier messages.');
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(texts()).toEqual(['First', 'Second', 'Third', 'Fourth']));
});
