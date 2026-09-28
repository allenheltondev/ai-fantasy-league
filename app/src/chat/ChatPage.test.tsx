import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { ChatApi, ChatMessage, ChatTeam, RealtimeInfo } from './api';
import { ChatPage, highlightMentions, mentionQuery, suggestTeams } from './ChatPage';
import type { Connect } from './realtime';

const TEAMS: ChatTeam[] = [
  { id: 'team-1', name: 'Allen FC', ownerName: 'Allen' },
  { id: 'team-2', name: 'Robo Ballers', ownerName: null },
  { id: 'team-3', name: 'Rocket Men', ownerName: 'Rae' }
];

let seq = 0;
function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    leagueId: 'L1',
    kind: 'user',
    author: { teamId: 'team-1', teamName: 'Allen FC', name: 'Allen' },
    text: `hello ${seq}`,
    mentionedTeamIds: [],
    event: null,
    createdAt: `2026-10-04T15:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    ...overrides
  };
}

const OFF: RealtimeInfo = {
  enabled: false,
  token: null,
  endpoint: null,
  cacheName: null,
  topics: null,
  expiresAt: null,
  pollIntervalSeconds: 0.05
};

const LIVE: RealtimeInfo = {
  enabled: true,
  token: 'tok',
  endpoint: null,
  cacheName: 'cache',
  topics: { league: 'fantasy.league.L1', global: 'fantasy.global' },
  expiresAt: '2999-01-01T00:00:00.000Z',
  pollIntervalSeconds: 0.05
};

function fakeApi(
  options: { messages?: ChatMessage[]; realtime?: RealtimeInfo | Error; post?: ChatApi['post'] } = {}
) {
  const store = [...(options.messages ?? [])];
  const api: ChatApi = {
    list: vi.fn(async () => ({ messages: [...store].reverse(), nextCursor: null })),
    post:
      options.post ??
      vi.fn(async (_leagueId: string, text: string) => {
        const m = msg({ text });
        store.push(m);
        return m;
      }),
    realtime: vi.fn(async () => {
      if (options.realtime instanceof Error) throw options.realtime;
      return options.realtime ?? OFF;
    }),
    teams: vi.fn(async () => TEAMS)
  };
  return { api, store };
}

function renderChat(api: ChatApi, connect: Connect = vi.fn()) {
  return render(
    <MemoryRouter initialEntries={['/leagues/L1/chat']}>
      <Routes>
        <Route path="/leagues/:leagueId/chat" element={<ChatPage api={api} connect={connect} />} />
      </Routes>
    </MemoryRouter>
  );
}

const list = () => screen.getByRole('list', { name: 'Chat messages' });

describe('ChatPage', () => {
  it('shows people, agents, and system messages differently, with mentions highlighted', async () => {
    const { api } = fakeApi({
      messages: [
        msg({
          text: 'Draft is done.',
          kind: 'system',
          author: { teamId: null, teamName: null, name: 'League' }
        }),
        msg({ text: 'hey @robo ballers, nice bench', mentionedTeamIds: ['team-2'] }),
        msg({
          kind: 'agent',
          author: { teamId: 'team-2', teamName: 'Robo Ballers', name: 'Robo Ballers' },
          text: 'beep'
        })
      ]
    });
    renderChat(api);
    expect(await within(list()).findByText('Draft is done.')).toBeInTheDocument();
    const items = within(list()).getAllByRole('listitem');
    expect(items.map((li) => li.dataset.kind)).toEqual(['system', 'user', 'agent']);
    expect(within(items[2] as HTMLElement).getByText('AI')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('Allen FC')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(items[1] as HTMLElement).getByText('@robo ballers').tagName).toBe('STRONG')
    );
    expect(await screen.findByText('Updates every 0.05s')).toBeInTheDocument();
  });

  it('polls for new messages when realtime is off', async () => {
    const { api, store } = fakeApi();
    renderChat(api);
    expect(await screen.findByText(/No messages yet/)).toBeInTheDocument();
    store.push(msg({ text: 'posted elsewhere' }));
    expect(await screen.findByText('posted elsewhere')).toBeInTheDocument();
  });

  it('goes live over the realtime token and falls back to polling on errors', async () => {
    const { api } = fakeApi({ realtime: LIVE });
    let handlers: Parameters<Connect>[1] | null = null;
    const unsubscribe = vi.fn();
    const connect: Connect = vi.fn(async (target, h) => {
      expect(target).toEqual({ token: 'tok', cacheName: 'cache', topic: 'fantasy.league.L1' });
      handlers = h;
      return unsubscribe;
    });
    const view = renderChat(api, connect);
    expect(await screen.findByText('Live')).toBeInTheDocument();
    act(() => handlers?.onChat(msg({ text: 'pushed live' })));
    expect(await screen.findByText('pushed live')).toBeInTheDocument();
    act(() => handlers?.onError());
    expect(await screen.findByText('Updates every 0.05s')).toBeInTheDocument();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('renews the token before it expires and unsubscribes on unmount', async () => {
    const { api } = fakeApi({
      realtime: { ...LIVE, expiresAt: new Date(Date.now() + 60_500).toISOString() }
    });
    const unsubscribe = vi.fn();
    const connect: Connect = vi.fn(async () => unsubscribe);
    const view = renderChat(api, connect);
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('polls when subscribing fails or the token request fails', async () => {
    const failing = fakeApi({ realtime: LIVE });
    const view = renderChat(
      failing.api,
      vi.fn(async () => Promise.reject(new Error('nope')))
    );
    expect(await screen.findByText('Updates every 0.05s')).toBeInTheDocument();
    view.unmount();
    renderChat(fakeApi({ realtime: new Error('500') }).api);
    expect(await screen.findByText('Updates every 5s')).toBeInTheDocument();
  });

  it('closes a subscription that finishes after unmount', async () => {
    const { api } = fakeApi({ realtime: LIVE });
    let resolve: (close: () => void) => void = () => undefined;
    const connect: Connect = () => new Promise((r) => (resolve = r));
    const view = renderChat(api, connect);
    await waitFor(() => expect(api.realtime).toHaveBeenCalled());
    view.unmount();
    const unsubscribe = vi.fn();
    await act(async () => resolve(unsubscribe));
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('keeps polling through failed refreshes and missing teams', async () => {
    const { api, store } = fakeApi();
    let failures = 2;
    const list = api.list;
    api.list = vi.fn(async (...args: Parameters<ChatApi['list']>) => {
      if (failures-- > 0) throw new Error('flaky');
      return list(...args);
    });
    api.teams = vi.fn(async () => Promise.reject(new Error('no teams')));
    store.push(msg({ text: 'eventually' }));
    renderChat(api);
    expect(await screen.findByText('eventually')).toBeInTheDocument();
  });

  it('stays live without renewing when the token has no usable expiry', async () => {
    for (const expiresAt of [null, 'garbage']) {
      const { api } = fakeApi({ realtime: { ...LIVE, expiresAt } });
      const connect: Connect = vi.fn(async () => () => undefined);
      const view = renderChat(api, connect);
      expect(await screen.findByText('Live')).toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 50));
      expect(connect).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  });

  it('does nothing once unmounted, whatever finishes late', async () => {
    // The token request finishes after unmount.
    let answer: (info: RealtimeInfo) => void = () => undefined;
    const slow = fakeApi();
    slow.api.realtime = vi.fn(() => new Promise<RealtimeInfo>((r) => (answer = r)));
    const connect = vi.fn();
    renderChat(slow.api, connect).unmount();
    await act(async () => answer(LIVE));
    expect(connect).not.toHaveBeenCalled();

    // Subscribing fails after unmount.
    let fail: (e: Error) => void = () => undefined;
    const failing = fakeApi({ realtime: LIVE });
    const view = renderChat(failing.api, () => new Promise((_r, reject) => (fail = reject)));
    await waitFor(() => expect(failing.api.realtime).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    view.unmount();
    await act(async () => fail(new Error('late')));

    // A poll finishes after unmount.
    let pending: (page: { messages: ChatMessage[]; nextCursor: null }) => void = () => undefined;
    const polling = fakeApi();
    const firstList = polling.api.list;
    let calls = 0;
    polling.api.list = vi.fn(async (...args: Parameters<ChatApi['list']>) => {
      calls += 1;
      return calls < 2
        ? firstList(...args)
        : new Promise<{ messages: ChatMessage[]; nextCursor: null }>((r) => (pending = r));
    });
    const pollView = renderChat(polling.api);
    await waitFor(() => expect(polling.api.list).toHaveBeenCalledTimes(2));
    pollView.unmount();
    await act(async () => pending({ messages: [], nextCursor: null }));
    await new Promise((r) => setTimeout(r, 100));
    expect(polling.api.list).toHaveBeenCalledTimes(2);

    // The subscription errors after unmount.
    let handlers: Parameters<Connect>[1] | null = null;
    const live = fakeApi({ realtime: LIVE });
    const liveView = renderChat(live.api, async (_t, h) => {
      handlers = h;
      return () => undefined;
    });
    expect(await screen.findByText('Live')).toBeInTheDocument();
    liveView.unmount();
    act(() => handlers?.onError());
    expect(screen.queryByText(/Updates every/)).not.toBeInTheDocument();
  });

  it('posts with Enter, autocompletes @mentions, and clears the composer', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    renderChat(api);
    const box = await screen.findByRole('combobox');
    await waitFor(() => expect(api.teams).toHaveBeenCalled());
    await user.type(box, 'nice one @Ro');
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Robo Ballers', 'Rocket Men · Rae']);
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(box).toHaveValue('nice one @Rocket Men ');
    await user.type(box, 'and @al');
    await user.keyboard('{Tab}');
    expect(box).toHaveValue('nice one @Rocket Men and @Allen FC ');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(api.post).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('L1', 'nice one @Rocket Men and @Allen FC'));
    expect(box).toHaveValue('');
    expect(await within(list()).findByText('@Rocket Men')).toBeInTheDocument();
  });

  it('picks a mention by click and dismisses suggestions with Escape', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    renderChat(api);
    const box = await screen.findByRole('combobox');
    await waitFor(() => expect(api.teams).toHaveBeenCalled());
    await user.type(box, '@');
    expect(await screen.findAllByRole('option')).toHaveLength(3);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.type(box, 'R');
    await user.pointer({ keys: '[MouseLeft>]', target: screen.getByText('Robo Ballers') });
    expect(box).toHaveValue('@Robo Ballers ');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('L1', '@Robo Ballers'));
  });

  it('shows the fix when posting fails', async () => {
    const user = userEvent.setup();
    const post = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(429, { code: 'RATE_LIMITED', message: 'Too fast', fix: 'Wait 10 second(s).' })
      )
      .mockRejectedValueOnce(new ApiError(500, { code: 'INTERNAL', message: 'Broken' }))
      .mockRejectedValueOnce(new Error('offline'));
    const { api } = fakeApi({ post });
    renderChat(api);
    const box = await screen.findByRole('combobox');
    await user.type(box, 'hi{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Wait 10 second(s).');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Broken'));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not send your message.'));
    expect(box).toHaveValue('hi');
    await user.clear(box);
    await user.keyboard('{Enter}');
    expect(post).toHaveBeenCalledTimes(3);
  });
});

describe('composer helpers', () => {
  it('finds the @mention being typed', () => {
    expect(mentionQuery('hi @Ro', 6)).toEqual({ start: 3, query: 'Ro' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('mail a@b', 8)).toBeNull();
    expect(mentionQuery('no mention', 10)).toBeNull();
  });

  it('suggests teams by name or manager', () => {
    expect(suggestTeams(TEAMS, 'ra').map((t) => t.id)).toEqual(['team-3']);
    expect(suggestTeams(TEAMS, '')).toHaveLength(3);
    expect(suggestTeams(TEAMS, 'Allen FC')).toEqual([]);
    expect(suggestTeams(TEAMS, 'robo ').map((t) => t.id)).toEqual(['team-2']);
  });

  it('leaves text alone without known teams', () => {
    expect(highlightMentions('@x', [])).toEqual(['@x']);
    expect(highlightMentions('a @team-1b', TEAMS)).toEqual(['a @team-1b']);
  });

  it('shows no time for a malformed timestamp', async () => {
    const { api } = fakeApi({ messages: [msg({ createdAt: 'bad', text: 'odd' })] });
    renderChat(api);
    const item = (await within(list()).findByText('odd')).closest('li') as HTMLElement;
    expect(item.querySelector('time')?.textContent).toBe('');
  });
});
