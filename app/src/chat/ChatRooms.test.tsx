import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { ChatApi, ChatMessage, ChatRoom, ChatTeam, RealtimeInfo } from './api';
import { ChatPage, resolveRoom } from './ChatPage';
import type { Connect } from './realtime';

const TEAMS: ChatTeam[] = [
  { id: 'team-1', name: 'Allen FC', ownerName: 'Allen' },
  { id: 'team-2', name: 'Robo Ballers', ownerName: null },
  { id: 'team-3', name: 'Rocket Men', ownerName: 'Rae' }
];

const room = (overrides: Partial<ChatRoom> & Pick<ChatRoom, 'roomId' | 'title'>): ChatRoom => ({
  kind: 'fixed',
  archived: false,
  week: null,
  teamIds: [],
  lastMessageAt: null,
  unreadCount: 0,
  ...overrides
});

const ROOMS: ChatRoom[] = [
  room({ roomId: 'league', title: 'League' }),
  room({ roomId: 'trash-talk', title: 'Trash Talk' }),
  room({ roomId: 'draft', title: 'Draft', unreadCount: 3 }),
  room({ roomId: 'trades', title: 'Trades', unreadCount: 120 }),
  room({ roomId: 'waivers-news', title: 'Waivers & News' }),
  room({
    roomId: 'm-2026-W05-W05-1',
    title: 'Wk 5: Allen FC vs Robo Ballers',
    kind: 'matchup',
    week: 5,
    teamIds: ['team-1', 'team-2']
  }),
  room({
    roomId: 'dm-team-1-team-3',
    title: 'Rocket Men',
    kind: 'dm',
    teamIds: ['team-1', 'team-3'],
    unreadCount: 1
  })
];

let seq = 0;
function msg(roomId: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    leagueId: 'L1',
    roomId,
    kind: 'user',
    author: { teamId: 'team-2', teamName: 'Robo Ballers', name: 'Robo Ballers' },
    text: `${roomId} message ${seq}`,
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
  pollIntervalSeconds: 60
};

/** A room-aware stand-in for the chat operations. */
function fakeApi(realtime: RealtimeInfo = OFF) {
  const byRoom = new Map<string, ChatMessage[]>([
    ['trash-talk', [msg('trash-talk', { text: 'welcome to trash talk' })]],
    [
      'draft',
      [
        msg('draft', {
          kind: 'system',
          author: { teamId: null, teamName: null, name: 'League' },
          text: 'The draft is complete. Good luck this season!',
          event: { detailType: 'Draft Completed', eventId: 'e1' }
        })
      ]
    ]
  ]);
  let rooms = ROOMS.map((r) => ({ ...r }));
  const api: ChatApi = {
    list: vi.fn(async (_league: string, options: { roomId?: string } = {}) => ({
      messages: [...(byRoom.get(options.roomId ?? 'trash-talk') ?? [])].reverse(),
      nextCursor: null
    })),
    post: vi.fn(async (_league: string, text: string, roomId = 'trash-talk') => {
      const m = msg(roomId, { author: { teamId: 'team-1', teamName: 'Allen FC', name: 'Allen' }, text });
      byRoom.set(roomId, [...(byRoom.get(roomId) ?? []), m]);
      return m;
    }),
    realtime: vi.fn(async () => realtime),
    teams: vi.fn(async () => TEAMS),
    rooms: vi.fn(async (_league: string, options: { pastWeek?: number } = {}) => ({
      defaultRoomId: 'trash-talk',
      rooms:
        options.pastWeek === undefined
          ? rooms
          : [
              ...rooms,
              room({
                roomId: `m-2026-W0${options.pastWeek}-W0${options.pastWeek}-1`,
                title: `Wk ${options.pastWeek}: Allen FC vs Rocket Men`,
                kind: 'matchup',
                week: options.pastWeek,
                archived: true
              })
            ]
    })),
    markRead: vi.fn(async (_league: string, roomId: string) => {
      rooms = rooms.map((r) => (r.roomId === roomId ? { ...r, unreadCount: 0 } : r));
    })
  };
  return {
    api,
    addRoom: (r: ChatRoom) => {
      rooms = [...rooms, r];
    }
  };
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.search}</p>;
}

function renderChat(api: ChatApi, options: { connect?: Connect; path?: string } = {}) {
  return render(
    <MemoryRouter initialEntries={[options.path ?? '/leagues/L1/chat']}>
      <Routes>
        <Route
          path="/leagues/:leagueId/chat"
          element={
            <>
              <ChatPage
                api={api}
                connect={options.connect ?? vi.fn()}
                yourTeamId="team-1"
                roomsRefreshMs={null}
              />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

const sidebar = () => within(screen.getByTestId('chat-sidebar'));
const messages = () => screen.getByRole('list', { name: 'Chat messages' });
const badge = (roomId: string) =>
  within(
    sidebar().getByRole('button', {
      name: new RegExp(ROOMS.find((r) => r.roomId === roomId)?.title ?? roomId)
    })
  ).queryByTestId('unread-badge');

describe('chat rooms', () => {
  it('lists rooms, this week’s matchups, and DMs, with unread badges', async () => {
    const { api } = fakeApi();
    renderChat(api);
    expect(await within(messages()).findByText('welcome to trash talk')).toBeInTheDocument();
    await waitFor(() =>
      expect(sidebar().getByRole('heading', { name: 'Direct messages' })).toBeInTheDocument()
    );
    expect(sidebar().getByRole('heading', { name: 'Rooms' })).toBeInTheDocument();
    expect(sidebar().getByRole('heading', { name: "This week's matchups" })).toBeInTheDocument();
    expect(sidebar().getByRole('button', { name: /Wk 5: Allen FC vs Robo Ballers/ })).toBeInTheDocument();
    expect(badge('draft')).toHaveTextContent('3');
    expect(badge('trades')).toHaveTextContent('99+');
    expect(badge('dm-team-1-team-3')).toHaveTextContent('1');
    // The open room is marked current and read.
    expect(sidebar().getByRole('button', { name: /Trash Talk/ })).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(api.markRead).toHaveBeenCalledWith('L1', 'trash-talk'));
    // The phone's switcher counts the unread messages elsewhere.
    expect(
      screen.getByRole('button', { name: /Chat room: Trash Talk\. Switch rooms \(124 unread\)/ })
    ).toBeInTheDocument();
  });

  it('switches rooms: reads that room, marks it read, and posts there', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    renderChat(api);
    await within(messages()).findByText('welcome to trash talk');
    await user.click(await sidebar().findByRole('button', { name: /Draft/ }));
    expect(
      await within(messages()).findByText('The draft is complete. Good luck this season!')
    ).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('?room=draft');
    expect(screen.getByRole('heading', { name: 'Draft', level: 2 })).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledWith('L1', expect.objectContaining({ roomId: 'draft' }));
    await waitFor(() => expect(api.markRead).toHaveBeenCalledWith('L1', 'draft'));
    expect(badge('draft')).toBeNull();
    expect(within(messages()).queryByText('welcome to trash talk')).not.toBeInTheDocument();
    await user.type(screen.getByRole('combobox'), 'nice picks{Enter}');
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('L1', 'nice picks', 'draft'));
  });

  it('opens a room from a link (a toast) and bumps other rooms on live messages', async () => {
    const { api, addRoom } = fakeApi({
      ...OFF,
      enabled: true,
      token: 't',
      cacheName: 'c',
      topics: { league: 'l', global: 'g', team: 'tm' }
    });
    let push: ((m: ChatMessage) => void) | null = null;
    const connect: Connect = vi.fn(async (target, handlers) => {
      expect(target.topics).toEqual(['l', 'tm']);
      push = handlers.onChat;
      return () => undefined;
    });
    renderChat(api, { connect, path: '/leagues/L1/chat?room=trades' });
    expect(await screen.findByText('Live')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Trades', level: 2 })).toBeInTheDocument();
    await waitFor(() => expect(badge('draft')).toHaveTextContent('3'));
    act(() => push?.(msg('draft')));
    await waitFor(() => expect(badge('draft')).toHaveTextContent('4'));
    act(() => push?.(msg('trades', { text: 'right here' })));
    expect(await within(messages()).findByText('right here')).toBeInTheDocument();
    // A DM nobody had opened yet: the list is read again and shows it.
    addRoom(
      room({
        roomId: 'dm-team-1-team-2',
        title: 'Robo Ballers',
        kind: 'dm',
        teamIds: ['team-1', 'team-2'],
        unreadCount: 1
      })
    );
    act(() => push?.(msg('dm-team-1-team-2', { text: 'psst' })));
    expect(await sidebar().findByRole('button', { name: /Robo Ballers1/ })).toBeInTheDocument();
  });

  it('starts a DM with any team: only that team can be mentioned there', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    renderChat(api);
    await within(messages()).findByText('welcome to trash talk');
    // No AI managers in this league: the hint is about teams.
    await waitFor(() =>
      expect(screen.getByRole('combobox').getAttribute('placeholder')).toMatch(/Type @ to mention a team\.$/)
    );
    await user.click(sidebar().getByRole('button', { name: '+ New message' }));
    const picker = sidebar().getByRole('list', { name: 'Message a team' });
    expect(within(picker).queryByText('Allen FC')).not.toBeInTheDocument();
    await user.click(within(picker).getByRole('button', { name: /Robo Ballers/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('?room=dm-team-1-team-2');
    expect(await screen.findByRole('heading', { name: 'Robo Ballers', level: 2 })).toBeInTheDocument();
    expect(await screen.findByText(/Only your two teams can read this conversation/)).toBeInTheDocument();
    const box = screen.getByRole('combobox');
    expect(box).toHaveAttribute('placeholder', 'Message Robo Ballers privately.');
    // Only the other team is in the room: not your own (#177).
    const members = within(screen.getByTestId('chat-members')).getAllByRole('button');
    expect(members.map((b) => b.getAttribute('aria-label'))).toEqual(['Mention Robo Ballers']);
    await user.type(box, '@');
    expect((await screen.findAllByRole('option')).map((o) => o.getAttribute('aria-label'))).toEqual([
      'Robo Ballers'
    ]);
    await user.type(box, 'R');
    await user.keyboard('{Escape}');
    await user.type(box, 'obo want my kicker?{Enter}');
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('L1', '@Robo want my kicker?', 'dm-team-1-team-2')
    );
  });

  it('keeps past weeks’ matchup rooms read-only behind "Past weeks"', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    renderChat(api);
    await within(messages()).findByText('welcome to trash talk');
    await user.click(await sidebar().findByRole('button', { name: 'Past weeks' }));
    expect(
      sidebar()
        .getAllByRole('button', { name: /^Wk \d$/ })
        .map((b) => b.textContent)
    ).toEqual(['Wk 4', 'Wk 3', 'Wk 2', 'Wk 1']);
    await user.click(sidebar().getByRole('button', { name: 'Wk 3' }));
    await user.click(await sidebar().findByRole('button', { name: /Wk 3: Allen FC vs Rocket Men/ }));
    expect(await screen.findByText(/This room is archived/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(api.rooms).toHaveBeenCalledWith('L1', { pastWeek: 3 });
  });

  it('switches rooms on a phone from the room sheet', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    renderChat(api);
    await within(messages()).findByText('welcome to trash talk');
    await user.click(screen.getByRole('button', { name: /Chat room: Trash Talk/ }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: 'Chat rooms' })).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: /Draft/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Chat room: Draft/ })).toBeInTheDocument();
    expect(await within(messages()).findByText(/The draft is complete/)).toBeInTheDocument();
  });
});

describe('resolveRoom', () => {
  it('finds the listed room, a picked past room, a new DM, or a stand-in', () => {
    const past = room({ roomId: 'm-2026-W01-W01-1', title: 'Wk 1', kind: 'matchup', archived: true });
    expect(resolveRoom('draft', ROOMS, null, TEAMS, 'team-1').title).toBe('Draft');
    expect(resolveRoom(past.roomId, ROOMS, past, TEAMS, 'team-1')).toBe(past);
    expect(resolveRoom('dm-team-1-team-2', ROOMS, null, TEAMS, 'team-1')).toMatchObject({
      kind: 'dm',
      title: 'Robo Ballers',
      teamIds: ['team-1', 'team-2']
    });
    expect(resolveRoom('dm-team-2-team-3', ROOMS, null, TEAMS, null)).toMatchObject({
      kind: 'dm',
      title: 'Direct message'
    });
    expect(resolveRoom('league', [], null, [], null)).toMatchObject({ kind: 'fixed', title: 'League' });
    expect(resolveRoom('m-2026-W09-W09-2', [], null, [], null)).toMatchObject({
      kind: 'matchup',
      title: 'm-2026-W09-W09-2'
    });
  });
});

describe('chat rooms when things go wrong', () => {
  it('keeps chatting without the room list, re-reads it while polling, and survives a failed past week', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    const rooms = api.rooms as ReturnType<typeof vi.fn>;
    rooms.mockRejectedValueOnce(new Error('offline'));
    render(
      <MemoryRouter initialEntries={['/leagues/L1/chat']}>
        <Routes>
          <Route
            path="/leagues/:leagueId/chat"
            element={<ChatPage api={api} connect={vi.fn()} yourTeamId="team-1" roomsRefreshMs={50} />}
          />
        </Routes>
      </MemoryRouter>
    );
    expect(await within(messages()).findByText('welcome to trash talk')).toBeInTheDocument();
    // The next read (polling) brings the rooms back.
    expect(await sidebar().findByRole('button', { name: /# Draft/ })).toBeInTheDocument();
    await user.click(sidebar().getByRole('button', { name: 'Past weeks' }));
    rooms.mockRejectedValue(new Error('offline'));
    await user.click(sidebar().getByRole('button', { name: 'Wk 2' }));
    expect(sidebar().getByRole('button', { name: 'Wk 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(sidebar().queryByRole('button', { name: /Wk 2: / })).not.toBeInTheDocument();
  });

  it('closes the room sheet without switching rooms', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    renderChat(api);
    await within(messages()).findByText('welcome to trash talk');
    await user.click(screen.getByRole('button', { name: /Chat room: Trash Talk/ }));
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Chat room: Trash Talk/ })).toBeInTheDocument();
  });
});
