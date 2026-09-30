import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { ChatApi, ChatMessage, ChatTeam, RealtimeInfo } from './api';
import { ChatPage, highlightMentions, mentionQuery, suggestTeams } from './ChatPage';
import { describeTeam, isAiManaged, mentionName, roomMembers } from './mentions';
import type { Connect } from './realtime';

const TEAMS: ChatTeam[] = [
  { id: 'team-1', name: 'Allen FC', ownerName: 'Allen' },
  {
    id: 'team-2',
    name: 'Robo Ballers',
    ownerName: 'Mei Park',
    avatarSeed: 'mei',
    ai: true,
    personality: 'The Spreadsheet'
  },
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
    teams: vi.fn(async () => TEAMS),
    rooms: vi.fn(async () => ({ defaultRoomId: 'trash-talk', rooms: [] })),
    markRead: vi.fn(async () => undefined)
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

  it('marks an untagged message that continues a talk with an AI manager', async () => {
    const { api } = fakeApi({
      messages: [
        msg({ text: 'any advice?', addressedTeamIds: ['team-2'] }),
        msg({ text: 'hmm', addressedTeamIds: ['team-9'] })
      ]
    });
    renderChat(api);
    expect(await within(list()).findByText('any advice?')).toBeInTheDocument();
    const [continued, unknown] = within(list()).getAllByRole('listitem');
    await waitFor(() =>
      expect(within(continued as HTMLElement).getByText('to Robo Ballers')).toBeInTheDocument()
    );
    // A team the list does not know shows nothing.
    expect(within(unknown as HTMLElement).queryByText(/^to /)).toBeNull();
  });

  it("shows an AI manager's name and avatar, falling back to its team's for older messages (#159)", async () => {
    const { api } = fakeApi({
      messages: [
        msg({
          kind: 'agent',
          author: { teamId: 'team-2', teamName: 'Robo Ballers', name: 'Robo Ballers' },
          text: 'old'
        }),
        msg({
          kind: 'agent',
          author: { teamId: 'team-2', teamName: 'Robo Ballers', name: 'Mei Park', avatarSeed: 'new-seed' },
          text: 'new - Mei'
        })
      ]
    });
    renderChat(api);
    expect(await within(list()).findByText('new - Mei')).toBeInTheDocument();
    const items = within(list()).getAllByRole('listitem');
    expect(
      within(items[0] as HTMLElement).getByRole('img', { name: 'Robo Ballers avatar' })
    ).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('Mei Park')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('Robo Ballers')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByRole('img', { name: 'Mei Park avatar' })).toBeInTheDocument();
  });

  it('shows no avatar for an AI message whose team is gone', async () => {
    const { api } = fakeApi({
      messages: [
        msg({ kind: 'agent', author: { teamId: 'team-9', teamName: 'Gone', name: 'Gone' }, text: 'bye' })
      ]
    });
    renderChat(api);
    expect(await within(list()).findByText('bye')).toBeInTheDocument();
    expect(within(list()).queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows league announcements as cards with the players they name', async () => {
    const { api } = fakeApi({
      messages: [
        msg({
          kind: 'system',
          author: { teamId: null, teamName: null, name: 'League' },
          text: 'Waivers processed for week 5: Allen FC added Puka Nacua ($31).',
          event: { detailType: 'Waivers Processed', eventId: 'e1' },
          players: [
            { id: 'p1', name: 'Puka Nacua', team: 'LAR', position: 'WR' },
            { id: 'p2', name: 'Free Agent', team: null, position: 'TE' }
          ]
        })
      ]
    });
    renderChat(api);
    const card = await screen.findByRole('article', { name: 'League announcement: Waivers Processed' });
    expect(within(card).getByText(/Allen FC added Puka Nacua/)).toBeInTheDocument();
    const players = within(card).getAllByTestId('player-card');
    expect(players.map((p) => p.textContent)).toEqual(['Puka NacuaWR · LAR', 'Free AgentTE']);
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
      expect(target).toEqual({ token: 'tok', cacheName: 'cache', topics: ['fantasy.league.L1'] });
      handlers = h;
      return unsubscribe;
    });
    const view = renderChat(api, connect);
    expect(await screen.findByText('Live')).toBeInTheDocument();
    act(() => handlers?.onChat(msg({ id: 'other-room', roomId: 'draft', text: 'a draft pick' })));
    act(() => handlers?.onChat(msg({ roomId: 'trash-talk', text: 'pushed live' })));
    // Messages from before rooms carry no roomId: they are trash talk.
    act(() => handlers?.onChat(msg({ text: 'from before rooms' })));
    expect(await screen.findByText('pushed live')).toBeInTheDocument();
    expect(screen.queryByText('a draft pick')).not.toBeInTheDocument();
    expect(await screen.findByText('from before rooms')).toBeInTheDocument();
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

  it('posts with Enter, autocompletes @mentions by manager name, and clears the composer', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    renderChat(api);
    const box = await screen.findByRole('combobox');
    await waitFor(() => expect(api.teams).toHaveBeenCalled());
    await user.type(box, 'nice one @Ro');
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-label'))).toEqual([
      'Mei Park, Robo Ballers, AI manager, The Spreadsheet',
      'Rae, Rocket Men'
    ]);
    // Each row: the avatar (or initials), the manager, the team, and an AI badge with the personality.
    expect(within(options[0] as HTMLElement).getByText('Mei Park')).toBeInTheDocument();
    expect(within(options[0] as HTMLElement).getByText('AI')).toBeInTheDocument();
    expect(within(options[0] as HTMLElement).getByText('The Spreadsheet')).toBeInTheDocument();
    expect(within(options[1] as HTMLElement).getByTestId('initials-avatar')).toHaveTextContent('R');
    expect(within(options[1] as HTMLElement).queryByText('AI')).not.toBeInTheDocument();
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    expect(box).toHaveAttribute('aria-activedescendant', 'chat-mention-1');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(box).toHaveValue('nice one @Rae ');
    expect(box).toHaveAttribute('aria-expanded', 'false');
    await user.type(box, 'and @al');
    await user.keyboard('{Tab}');
    expect(box).toHaveValue('nice one @Rae and @Allen ');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(api.post).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('L1', 'nice one @Rae and @Allen', 'trash-talk')
    );
    expect(box).toHaveValue('');
    expect(await within(list()).findByText('@Rae')).toBeInTheDocument();
  });

  it('lists AI managers first, matches personalities, picks by click, and dismisses with Escape', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    renderChat(api);
    const box = await screen.findByRole('combobox');
    await waitFor(() => expect(api.teams).toHaveBeenCalled());
    expect(box).toHaveAttribute('placeholder', 'Message Trash Talk. Type @ to talk to an AI manager.');
    await user.type(box, '@');
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-label'))).toEqual([
      'Mei Park, Robo Ballers, AI manager, The Spreadsheet',
      'Allen, Allen FC',
      'Rae, Rocket Men'
    ]);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.type(box, 'spread');
    const option = await screen.findByRole('option', { name: /Mei Park/ });
    await user.pointer({ keys: '[MouseLeft>]', target: option });
    expect(box).toHaveValue('@Mei Park ');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('L1', '@Mei Park', 'trash-talk'));
  });

  it('opens the mention list from the @ button', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    renderChat(api);
    const box = await screen.findByRole('combobox');
    const at = await screen.findByRole('button', { name: 'Mention someone' });
    await user.click(at);
    expect(box).toHaveValue('@');
    expect(box).toHaveFocus();
    expect(await screen.findByRole('listbox', { name: 'Mention a team' })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(box).toHaveValue('@Mei Park ');
    // Mid-message, the @ starts a new word.
    await user.type(box, 'hi');
    await user.click(at);
    expect(box).toHaveValue('@Mei Park hi @');
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('shows who is in the room, and tapping one mentions them', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    renderChat(api);
    const box = await screen.findByRole('combobox');
    const strip = await screen.findByTestId('chat-members');
    expect(strip).toHaveTextContent('In this room');
    const members = within(strip).getAllByRole('button');
    expect(members.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Mention Mei Park, Robo Ballers, AI manager, The Spreadsheet',
      'Mention Allen, Allen FC',
      'Mention Rae, Rocket Men'
    ]);
    expect(within(members[0] as HTMLElement).getByText('AI')).toBeInTheDocument();
    await user.click(members[0] as HTMLElement);
    expect(box).toHaveValue('@Mei Park ');
    expect(box).toHaveFocus();
    await user.type(box, 'and');
    await user.click(members[2] as HTMLElement);
    expect(box).toHaveValue('@Mei Park and @Rae ');
  });

  it('names the manager behind a mention on hover or focus', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi({ messages: [msg({ text: 'watch out @Mei Park and @Rocket Men' })] });
    renderChat(api);
    await waitFor(() => expect(api.teams).toHaveBeenCalled());
    const mei = await within(list()).findByText('@Mei Park');
    expect(mei.tagName).toBe('STRONG');
    expect(mei).toHaveAttribute('data-team-id', 'team-2');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await user.hover(mei);
    const tip = screen.getByRole('tooltip');
    expect(mei).toHaveAttribute('aria-describedby', tip.id);
    expect(tip).toHaveTextContent('Mei Park');
    expect(tip).toHaveTextContent('Robo Ballers');
    expect(tip).toHaveTextContent('AI');
    expect(tip).toHaveTextContent('The Spreadsheet');
    await user.unhover(mei);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    // A person's team: by keyboard, with the manager's name and initials.
    const rocket = within(list()).getByText('@Rocket Men');
    act(() => rocket.focus());
    expect(screen.getByRole('tooltip')).toHaveTextContent('Rae');
    expect(within(screen.getByRole('tooltip')).getByTestId('initials-avatar')).toHaveTextContent('R');
    act(() => rocket.blur());
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
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

  it('suggests by any word of the manager, team, or personality, AI managers first (#177)', () => {
    expect(suggestTeams(TEAMS, 'park').map((t) => t.id)).toEqual(['team-2']);
    expect(suggestTeams(TEAMS, 'men').map((t) => t.id)).toEqual(['team-3']);
    expect(suggestTeams(TEAMS, 'spread').map((t) => t.id)).toEqual(['team-2']);
    expect(suggestTeams(TEAMS, 'the ').map((t) => t.id)).toEqual(['team-2']);
    expect(suggestTeams(TEAMS, 'Mei Park')).toEqual([]);
    expect(suggestTeams(TEAMS, 'allen ')).toEqual([]);
    expect(suggestTeams(TEAMS, '').map((t) => t.id)).toEqual(['team-2', 'team-1', 'team-3']);
    // Typing narrows without reordering.
    expect(suggestTeams(TEAMS, 'r').map((t) => t.id)).toEqual(['team-2', 'team-3']);
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, name: `Team ${i}`, ownerName: null }));
    expect(suggestTeams(many, '')).toHaveLength(8);
  });

  it('mentions a manager by name, unless another team answers to it', () => {
    const [allen, robo, rocket] = TEAMS as [ChatTeam, ChatTeam, ChatTeam];
    expect(mentionName(robo, TEAMS)).toBe('Mei Park');
    expect(mentionName(allen, TEAMS)).toBe('Allen');
    const twin = { id: 'team-4', name: 'Rae', ownerName: 'Sam' };
    expect(mentionName(rocket, [...TEAMS, twin])).toBe('Rocket Men');
    const sameOwner = { id: 'team-5', name: 'Rae Two', ownerName: ' rae ' };
    expect(mentionName(rocket, [...TEAMS, sameOwner])).toBe('Rocket Men');
    expect(mentionName({ id: 'x', name: 'Open', ownerName: '  ' }, [])).toBe('Open');
  });

  it('knows an AI team by its flag, or by an avatar on older lists', () => {
    expect(isAiManaged({ id: 'a', name: 'A', ownerName: null, ai: true })).toBe(true);
    expect(isAiManaged({ id: 'b', name: 'B', ownerName: null, avatarSeed: 's' })).toBe(true);
    expect(isAiManaged({ id: 'c', name: 'C', ownerName: 'Cy', avatarSeed: 's', ai: false })).toBe(false);
    expect(isAiManaged({ id: 'd', name: 'D', ownerName: 'Di' })).toBe(false);
    expect(describeTeam({ id: 'a', name: 'A', ownerName: null, ai: true })).toBe('A, AI manager');
  });

  it('lists a DM without your own team', () => {
    const dm = { kind: 'dm', teamIds: ['team-1', 'team-3'] };
    expect(roomMembers(TEAMS, dm, 'team-1').map((t) => t.id)).toEqual(['team-3']);
    expect(roomMembers(TEAMS, dm, null).map((t) => t.id)).toEqual(['team-1', 'team-3']);
    expect(roomMembers(TEAMS, { kind: 'fixed', teamIds: [] }, 'team-1').map((t) => t.id)).toEqual([
      'team-2',
      'team-1',
      'team-3'
    ]);
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
