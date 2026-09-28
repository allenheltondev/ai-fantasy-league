import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiFetch, type ApiRequest } from '../api/client';
import type { ChatApi, ChatMessage } from '../chat/api';
import type { Connect } from '../chat/realtime';
import type { DraftBoard } from './board';
import { formatClock, overallPick, secondsUntil } from './board';
import { DraftPage, spaceBelow } from './DraftPage';
import type { EventConnect, LeagueEvent } from '../realtime/leagueEvents';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const ref = (id: string, name: string, position: string, team: string | null = 'SF') => ({
  id,
  name,
  team,
  position
});
const CMC = ref('fx-cmc', 'Christian McCaffrey', 'RB');
const CHASE = ref('fx-chase', "Ja'Marr Chase", 'WR', 'CIN');
const NYJ = ref('fx-def-nyj', 'NYJ Defense', 'DEF', null);

function board(overrides: Partial<DraftBoard> = {}): DraftBoard {
  return {
    status: 'in_progress',
    rounds: 2,
    pickSeconds: 90,
    startedAt: '2026-09-30T11:59:00.000Z',
    completedAt: null,
    order: [
      { teamId: 'team-1', teamName: "Allen's Team", seatType: 'human' },
      {
        teamId: 'team-2',
        teamName: 'The Spreadsheet',
        seatType: 'agent',
        manager: { name: 'Sheets', avatarSeed: 'sheets', personality: 'Numbers first' }
      }
    ],
    onTheClock: {
      overall: 2,
      round: 1,
      pick: 2,
      teamId: 'team-2',
      teamName: 'The Spreadsheet',
      deadline: '2026-09-30T12:01:05.000Z',
      secondsLeft: 65
    },
    yourTeamId: 'team-1',
    yourNextPick: { overall: 3, round: 2, pick: 1, picksAway: 1 },
    yourNeeds: ['QB', 'K'],
    picks: [{ overall: 1, round: 1, pick: 1, teamId: 'team-1', player: CMC, auto: true, madeAt: null }],
    rosters: [
      { teamId: 'team-1', teamName: "Allen's Team", players: [CMC] },
      { teamId: 'team-2', teamName: 'The Spreadsheet', players: [] }
    ],
    bestAvailable: [
      { player: CHASE, rank: 1 },
      { player: NYJ, rank: null }
    ],
    ...overrides
  };
}

const MY_TURN = {
  overall: 3,
  round: 2,
  pick: 1,
  teamId: 'team-1',
  teamName: "Allen's Team",
  deadline: null,
  secondsLeft: 30
};

type Handler = (path: string, request: ApiRequest) => unknown;

/** Players the fake queue endpoint knows by id. */
const KNOWN = [CMC, CHASE, NYJ];

/**
 * The API, with the draft queue kept in memory (get_draft_queue / set_draft_queue) unless `handler`
 * answers it. `allowed` is the envelope's allowedActions (the commissioner's pause and resume).
 */
function fakeApi(handler: Handler, allowed: string[] = []) {
  const calls: { path: string; request: ApiRequest }[] = [];
  let queue: string[] = [];
  const queueView = () => ({
    teamId: 'team-1',
    maxSize: 50,
    updatedAt: null,
    players: queue.map((id) => ({ player: KNOWN.find((p) => p.id === id), rank: null, available: true }))
  });
  const api = (async (path: string, request: ApiRequest = {}) => {
    calls.push({ path, request });
    if (path.endsWith('/draft/queue')) {
      if (request.method === 'PUT') queue = (request.body as { playerIds: string[] }).playerIds;
      return { data: queueView(), league: null, warnings: [] };
    }
    const data = handler(path, request);
    if (data instanceof Error) throw data;
    return {
      data,
      league: { phase: 'drafting', week: 0, allowedActions: allowed },
      warnings: []
    };
  }) as ApiFetch;
  return { api, calls };
}

/** A chat stand-in: one message in the draft room. */
function fakeChat() {
  const message: ChatMessage = {
    id: 'm1',
    leagueId: 'L1',
    roomId: 'draft',
    kind: 'agent',
    author: { teamId: 'team-2', teamName: 'The Spreadsheet', name: 'Sheets', avatarSeed: 'sheets' },
    text: 'Chase is mine next round.',
    mentionedTeamIds: [],
    event: null,
    createdAt: '2026-09-30T11:59:30.000Z'
  };
  const markRead = vi.fn(async () => undefined);
  const list = vi.fn(async () => ({ messages: [message], nextCursor: null }));
  const chat: ChatApi = {
    list,
    post: vi.fn(async () => message),
    rooms: vi.fn(async () => ({ defaultRoomId: 'trash-talk', rooms: [] })),
    markRead,
    realtime: vi.fn(async () => ({
      enabled: false,
      token: null,
      endpoint: null,
      cacheName: null,
      topics: null,
      expiresAt: null,
      pollIntervalSeconds: 5
    })),
    teams: vi.fn(async () => [
      { id: 'team-2', name: 'The Spreadsheet', ownerName: 'Sheets', avatarSeed: 'sheets', ai: true }
    ])
  };
  return { chat, markRead, list };
}

const noLiveChat: Connect = async () => () => undefined;

/** `matchMedia` answering the room's width query: wide (desktop) or a phone. */
function mockWidth(wide: boolean) {
  const original = window.matchMedia;
  const listeners = new Set<() => void>();
  let matches = wide;
  window.matchMedia = vi.fn(
    (query: string) =>
      ({
        get matches() {
          return query.includes('min-width') ? matches : false;
        },
        media: query,
        addEventListener: (_: string, l: () => void) => listeners.add(l),
        removeEventListener: (_: string, l: () => void) => listeners.delete(l)
      }) as unknown as MediaQueryList
  );
  return {
    set(next: boolean) {
      matches = next;
      act(() => listeners.forEach((l) => l()));
    },
    restore() {
      window.matchMedia = original;
    }
  };
}

function renderDraft(
  api: ApiFetch,
  pollMs = 60_000,
  connect?: EventConnect,
  extra: { chat?: ChatApi; chime?: () => void } = {}
) {
  let now = NOW;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  render(
    <MemoryRouter initialEntries={['/leagues/L1/draft']}>
      <Routes>
        <Route
          path="/leagues/:leagueId/draft"
          element={
            <DraftPage
              api={api}
              pollMs={pollMs}
              now={clock.now}
              connect={connect}
              chatApi={extra.chat ?? fakeChat().chat}
              chatConnect={noLiveChat}
              chime={extra.chime ?? (() => undefined)}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );
  return clock;
}

const tab = (name: string) => screen.getByRole('tab', { name });

// The desktop room unless a test narrows the window.
let width: ReturnType<typeof mockWidth>;
beforeEach(() => {
  width = mockWidth(true);
});
afterEach(() => {
  width.restore();
  vi.useRealTimers();
  localStorage.clear();
});

const NOT_STARTED = new ApiError(409, {
  code: 'DRAFT_NOT_STARTED',
  message: 'The draft has not started yet.',
  fix: 'Wait for the commissioner.'
});

function lobbyView(overrides: Record<string, unknown> = {}) {
  const teams = [
    { teamId: 'team-1', teamName: "Allen's Team", seatType: 'human', here: true, lastSeenAt: null },
    { teamId: 'team-2', teamName: 'The Spreadsheet', seatType: 'agent', here: true, lastSeenAt: null }
  ];
  return {
    phase: 'setup',
    scheduledAt: null,
    orderMode: 'slots',
    serverTime: new Date(NOW).toISOString(),
    order: teams,
    teams,
    commissionerHere: true,
    canStart: false,
    ...overrides
  };
}

const LIVE_INFO = {
  enabled: true,
  token: 't',
  endpoint: null,
  cacheName: 'c',
  topics: { league: 'fantasy.league.L1', global: 'fantasy.global' },
  expiresAt: null,
  pollIntervalSeconds: 5
};

describe('board helpers', () => {
  it('snakes the grid, counts down, and formats the clock', () => {
    expect([1, 2].map((r) => [0, 1, 2].map((i) => overallPick(r, i, 3)))).toEqual([
      [1, 2, 3],
      [6, 5, 4]
    ]);
    expect(secondsUntil('2026-09-30T12:00:10.500Z', NOW)).toBe(11);
    expect(secondsUntil('2026-09-30T11:00:00.000Z', NOW)).toBe(0);
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(-3)).toBe('0:00');
  });
});

describe('DraftPage', () => {
  it('shows the clock, your next pick, the ticker, the players, and your roster while another team picks', async () => {
    const { api, calls } = fakeApi(() => board());
    renderDraft(api);
    expect(await screen.findByTestId('on-the-clock')).toHaveTextContent('The Spreadsheet is on the clock');
    expect(screen.getByTestId('draft-topbar')).toHaveTextContent('Round 1, pick 2 · #2 overall (1.02)');
    expect(screen.getByTestId('pick-clock')).toHaveTextContent('1:05');
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByTestId('your-next-pick')).toHaveTextContent('Your pick #3 in 1 pick');
    expect(screen.getByTestId('draft-room')).toHaveAttribute('data-layout', 'wide');
    // The ticker: the pick made, then the clock and what comes next.
    expect(screen.getByTestId('ticker-1')).toHaveTextContent('1.01');
    expect(screen.getByTestId('ticker-1')).toHaveTextContent('C. McCaffrey');
    expect(screen.getByTestId('ticker-clock')).toHaveTextContent('1.02The SpreadsheetOn the clock');
    // The players, and your roster on the side (listed plainly without a roster layout).
    expect(within(screen.getByTestId('available-fx-def-nyj')).getByTestId('compact-stats')).toHaveTextContent(
      '#— · FA'
    );
    expect(screen.getByRole('button', { name: "Draft Ja'Marr Chase" })).toBeDisabled();
    expect(screen.getByTestId('roster-needs')).toHaveTextContent('Need: 1 QB, 1 K');
    expect(
      within(screen.getByRole('list', { name: 'Your roster' })).getByText('Christian McCaffrey')
    ).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/leagues/L1/draft')).toEqual({
      path: '/leagues/L1/draft',
      request: { query: { q: undefined, position: undefined, limit: 50 } }
    });
    // Not the commissioner: no clock controls.
    expect(screen.queryByRole('button', { name: 'Pause draft' })).toBeNull();
  });

  it('shows the full board grid, with your column and the pick on the clock', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi(() => board());
    renderDraft(api);
    await user.click(await screen.findByRole('tab', { name: 'Board' }));
    expect(tab('Board')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('cell-1')).toHaveTextContent('C. McCaffreyRB · SF · auto');
    expect(screen.getByTestId('cell-1')).toHaveAttribute('data-position', 'RB');
    expect(screen.getByTestId('cell-2')).toHaveTextContent('1.02On the clock');
    expect(screen.getByTestId('cell-4')).toHaveTextContent('2.02');
    expect(screen.getByRole('columnheader', { name: /The Spreadsheet/ })).toHaveTextContent('Sheets');
  });

  it('lays out your roster by slot with what you still need, and the likely-gone players', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi((path) =>
      path === '/players/card'
        ? {
            player: CMC,
            scoring: { source: 'league' },
            bye: 14,
            injuryStatus: null,
            lastSeason: null,
            projection: null,
            news: []
          }
        : board({
            yourRoster: {
              starters: [
                { slot: 'QB', player: null },
                { slot: 'RB', player: CMC },
                { slot: 'K', player: null },
                { slot: 'DEF', player: null }
              ],
              bench: [ref('fx-bench', 'Bench Guy', 'WR', null)],
              benchSize: 2
            },
            likelyGone: [CHASE],
            scarcity: [
              { position: 'WR', left: 20, likelyGone: 1 },
              { position: 'TE', left: 5, likelyGone: 0 }
            ]
          })
    );
    renderDraft(api);
    expect(await screen.findByTestId('roster-needs')).toHaveTextContent('Need: 1 QB, 1 K, 1 DEF');
    const seats = within(screen.getByRole('list', { name: 'Your roster' })).getAllByRole('listitem');
    expect(seats.map((s) => s.textContent)).toEqual([
      'QBEmpty',
      'RBRBChristian McCaffreySF',
      'KEmpty',
      'DEFEmpty',
      'BNWRBench GuyFA',
      'BNEmpty'
    ]);
    expect(seats[0]).toHaveAttribute('data-empty', 'true');
    expect(screen.getByTestId('likely-gone')).toHaveTextContent('Likely gone before your pick: J. Chase');
    expect(screen.getByTestId('scarcity')).toHaveTextContent('Left in the top 100: 20 WR (1 likely gone)');
    expect(within(screen.getByTestId('available-fx-chase')).getByText('likely gone')).toBeInTheDocument();
    // A roster seat opens the player card.
    await user.click(within(seats[1] as HTMLElement).getByRole('button', { name: 'Christian McCaffrey' }));
    expect(await screen.findByTestId('player-card')).toBeInTheDocument();
  });

  it('says so when your starting lineup is full, and when you have no team', async () => {
    const full = fakeApi(() =>
      board({ yourRoster: { starters: [{ slot: 'RB', player: CMC }], bench: [], benchSize: 0 } })
    );
    renderDraft(full.api);
    expect(await screen.findByTestId('roster-needs')).toHaveTextContent('Starting lineup filled.');
  });

  it('shows no roster without a team', async () => {
    const { api } = fakeApi(() => board({ yourTeamId: null, yourNextPick: null, yourRoster: null }));
    renderDraft(api);
    expect(await screen.findByText('You do not have a team in this draft.')).toBeInTheDocument();
  });

  it('counts the clock down every second and polls the board', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api, calls } = fakeApi(() => board());
    const clock = renderDraft(api, 3000);
    expect(await screen.findByTestId('pick-clock')).toHaveTextContent('1:05');
    clock.advance(5000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(screen.getByTestId('pick-clock')).toHaveTextContent('1:00');
    expect(calls.filter((c) => c.path.endsWith('/draft')).length).toBeGreaterThanOrEqual(2);
  });

  it('lets you pick when you are on the clock, then refreshes', async () => {
    const user = userEvent.setup();
    let picked = false;
    const mine = board({
      onTheClock: MY_TURN,
      yourNextPick: { overall: 3, round: 2, pick: 1, picksAway: 0 }
    });
    const { api, calls } = fakeApi((path) => {
      if (path.endsWith('/picks')) {
        picked = true;
        return { pick: { overall: 3 } };
      }
      return picked
        ? board({ onTheClock: null, status: 'complete', yourNextPick: null, yourNeeds: [] })
        : mine;
    });
    renderDraft(api);
    expect(await screen.findByText('You are on the clock!')).toBeInTheDocument();
    expect(screen.queryByTestId('your-next-pick')).toBeNull();
    expect(screen.getByTestId('pick-clock')).toHaveTextContent('0:30');
    await user.click(screen.getByRole('button', { name: "Draft Ja'Marr Chase" }));
    expect(calls.find((c) => c.path.endsWith('/picks'))?.request).toEqual({
      method: 'POST',
      body: { playerId: 'fx-chase', pick: 3 }
    });
    expect(await screen.findByText(/The draft is complete/)).toBeInTheDocument();
    expect(screen.getByText('Complete')).toBeInTheDocument();
  });

  it('drafts from the player card drawer, then closes it', async () => {
    const user = userEvent.setup();
    const { api, calls } = fakeApi((path) =>
      path === '/players/card'
        ? {
            player: CHASE,
            scoring: { source: 'league' },
            bye: 10,
            injuryStatus: null,
            lastSeason: null,
            projection: null,
            news: []
          }
        : path.endsWith('/picks')
          ? {}
          : board({ onTheClock: MY_TURN })
    );
    renderDraft(api);
    await user.click(await screen.findByRole('button', { name: "Ja'Marr Chase" }));
    const card = await screen.findByTestId('player-card');
    await user.click(within(card).getByRole('button', { name: 'Draft' }));
    expect(calls.find((c) => c.path.endsWith('/picks'))?.request.body).toEqual({
      playerId: 'fx-chase',
      pick: 3
    });
    await waitFor(() => expect(screen.queryByTestId('player-card')).toBeNull());
  });

  it('shows why a pick was refused', async () => {
    const user = userEvent.setup();
    const mine = board({ onTheClock: { ...MY_TURN, deadline: '2026-09-30T12:01:00.000Z', secondsLeft: 60 } });
    let attempts = 0;
    const { api } = fakeApi((path) => {
      if (!path.endsWith('/picks')) return mine;
      attempts++;
      return attempts === 1
        ? new ApiError(409, { code: 'ROSTER_WOULD_BE_INVALID', message: 'Too many QBs.', fix: 'Draft a K.' })
        : new TypeError('offline');
    });
    renderDraft(api);
    await user.click(await screen.findByRole('button', { name: "Draft Ja'Marr Chase" }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many QBs. Draft a K.');
    await user.click(screen.getByRole('button', { name: 'Draft NYJ Defense' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server.');
  });

  it('filters the best available by name and position', async () => {
    const user = userEvent.setup();
    const { api, calls } = fakeApi(() =>
      board({ status: 'paused', onTheClock: { ...board().onTheClock!, deadline: null, secondsLeft: 40 } })
    );
    renderDraft(api);
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    expect(screen.getByText('The commissioner paused the draft. The clock is frozen.')).toBeInTheDocument();
    expect(screen.getByTestId('pick-clock')).toHaveTextContent('0:40');
    await user.type(screen.getByLabelText('Search players'), 'chase');
    await user.click(
      within(screen.getByRole('group', { name: 'Position' })).getByRole('button', { name: 'WR' })
    );
    expect(calls.at(-1)?.request.query).toEqual({ q: 'chase', position: 'WR', limit: 50 });
    await user.click(screen.getByRole('button', { name: 'Sort by last season points per game' }));
    expect(calls.at(-1)?.request.query).toEqual({ q: 'chase', position: 'WR', limit: 50, sort: 'ppg' });
  });

  it('opens a player card from the ticker, the board, your roster, and the queue', async () => {
    const user = userEvent.setup();
    const { api, calls } = fakeApi((path) =>
      path === '/players/card'
        ? {
            player: CMC,
            scoring: { source: 'league' },
            bye: 14,
            injuryStatus: null,
            lastSeason: null,
            projection: null,
            news: []
          }
        : board()
    );
    renderDraft(api);
    await user.click(
      await screen.findByRole('button', { name: /Christian McCaffrey, pick 1\.01 by Allen's Team/ })
    );
    expect(await screen.findByTestId('player-card')).toHaveTextContent('bye 14');
    expect(calls.find((c) => c.path === '/players/card')?.request.query).toEqual({
      playerId: 'fx-cmc',
      leagueId: 'L1'
    });
    // Drafted already, and not your turn: no Draft button.
    expect(within(screen.getByTestId('player-card')).queryByRole('button', { name: 'Draft' })).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(tab('Board'));
    await user.click(
      within(screen.getByTestId('cell-1')).getByRole('button', { name: 'Christian McCaffrey' })
    );
    expect(await screen.findByTestId('player-card')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(within(screen.getByRole('list', { name: 'Your roster' })).getByRole('button'));
    expect(await screen.findByTestId('player-card')).toBeInTheDocument();
  });

  it('switches the main view to the depth chart', async () => {
    const user = userEvent.setup();
    const { api, calls } = fakeApi((path) =>
      path.endsWith('/draft/depth') ? { yourTeamId: 'team-1', teams: [] } : board()
    );
    renderDraft(api);
    await user.click(await screen.findByRole('tab', { name: 'Depth' }));
    expect(await screen.findByRole('table', { name: 'Depth chart' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/leagues/L1/draft/depth')).toBe(true);
    expect(screen.queryByRole('table', { name: 'Draft board' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'Best available' })).toBeNull();
    await user.click(tab('Players'));
    expect(screen.getByRole('table', { name: 'Best available' })).toBeInTheDocument();
  });

  it('shows a frozen clock with no time recorded as 0:00', async () => {
    const user = userEvent.setup();
    const manual = { ...board().picks[0]!, auto: false };
    const { api } = fakeApi(() =>
      board({
        status: 'paused',
        picks: [manual],
        onTheClock: { ...board().onTheClock!, deadline: null, secondsLeft: null }
      })
    );
    renderDraft(api);
    expect(await screen.findByTestId('pick-clock')).toHaveTextContent('0:00');
    await user.click(tab('Board'));
    expect(screen.getByTestId('cell-1')).toHaveTextContent(/^C\. McCaffreyRB · SF$/);
  });

  it('is a lobby before the draft, and flips to the board when the draft starts', async () => {
    let onEvent: (event: LeagueEvent) => void = () => undefined;
    const connect: EventConnect = async (_target, handlers) => {
      onEvent = handlers.onEvent;
      return () => undefined;
    };
    let started = false;
    const { api, calls } = fakeApi((path) => {
      if (path.endsWith('/realtime')) return LIVE_INFO;
      if (path.endsWith('/draft/lobby'))
        return lobbyView({ scheduledAt: new Date(NOW + 65_000).toISOString() });
      if (path === '/players') return { players: [] };
      return started ? board() : NOT_STARTED;
    });
    renderDraft(api, 60_000, connect);
    expect(await screen.findByTestId('draft-countdown')).toHaveTextContent('1:05');
    expect(screen.getByRole('list', { name: "Who's here" })).toHaveTextContent("Allen's Team");
    // A reminder makes the lobby check in again at once.
    const checkIns = () => calls.filter((c) => c.path.endsWith('/draft/lobby')).length;
    const before = checkIns();
    act(() => onEvent({ detailType: 'Draft Starting Soon', leagueId: 'L1' }));
    await waitFor(() => expect(checkIns()).toBeGreaterThan(before));
    // The first turn is announced: the room replaces the lobby without a reload.
    started = true;
    act(() => onEvent({ detailType: 'Draft Turn Started', leagueId: 'L1' }));
    expect(await screen.findByTestId('on-the-clock')).toHaveTextContent('The Spreadsheet is on the clock');
    expect(screen.queryByTestId('draft-lobby')).not.toBeInTheDocument();
  });

  it('looks for the board when the countdown runs out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let started = false;
    const { api } = fakeApi((path) => {
      if (path.endsWith('/draft/lobby'))
        return lobbyView({ scheduledAt: new Date(NOW + 3_000).toISOString() });
      if (path === '/players') return { players: [] };
      return started ? board() : NOT_STARTED;
    });
    const clock = renderDraft(api);
    expect(await screen.findByTestId('draft-countdown')).toHaveTextContent('0:03');
    started = true;
    clock.advance(4_000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(await screen.findByTestId('on-the-clock')).toBeInTheDocument();
  });

  it('offers a retry when the board cannot load', async () => {
    const user = userEvent.setup();
    let fail = true;
    const { api } = fakeApi(() =>
      fail ? new TypeError('offline') : board({ yourTeamId: null, yourNextPick: null, rosters: [] })
    );
    renderDraft(api);
    expect(await screen.findByText('Could not reach the server.')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('on-the-clock')).toBeInTheDocument();
    expect(screen.queryByTestId('your-next-pick')).not.toBeInTheDocument();
  });

  it('refreshes the board on live draft events instead of polling fast', async () => {
    const user = userEvent.setup();
    let onEvent: (event: LeagueEvent) => void = () => undefined;
    const connect: EventConnect = async (target, handlers) => {
      expect(target.topics).toEqual(['fantasy.league.L1']);
      onEvent = handlers.onEvent;
      return () => undefined;
    };
    let picks = board().picks;
    const { api, calls } = fakeApi((path) => (path.endsWith('/realtime') ? LIVE_INFO : board({ picks })));
    renderDraft(api, 3000, connect);
    expect(await screen.findByText('Updating live')).toBeInTheDocument();
    await user.click(tab('Board'));
    picks = [
      ...picks,
      { overall: 2, round: 1, pick: 2, teamId: 'team-2', player: CHASE, auto: false, madeAt: null }
    ];
    const before = calls.filter((c) => c.path.endsWith('/draft')).length;
    act(() => onEvent({ detailType: 'Draft Pick Made', leagueId: 'L1' }));
    expect(await screen.findByTestId('cell-2')).toHaveTextContent('J. ChaseWR · CIN');
    expect(calls.filter((c) => c.path.endsWith('/draft')).length).toBe(before + 1);
  });

  it('stops the countdown as soon as the commissioner pauses the draft', async () => {
    let onEvent: (event: LeagueEvent) => void = () => undefined;
    const connect: EventConnect = async (_target, handlers) => {
      onEvent = handlers.onEvent;
      return () => undefined;
    };
    let paused = false;
    const { api } = fakeApi((path) =>
      path.endsWith('/realtime')
        ? LIVE_INFO
        : paused
          ? board({
              status: 'paused',
              onTheClock: { ...board().onTheClock!, deadline: null, secondsLeft: 50 }
            })
          : board()
    );
    renderDraft(api, 3000, connect);
    expect(await screen.findByText('Updating live')).toBeInTheDocument();
    paused = true;
    act(() => onEvent({ detailType: 'Draft Paused', leagueId: 'L1' }));
    expect(await screen.findByText(/The commissioner paused the draft/)).toBeInTheDocument();
    expect(screen.getByTestId('pick-clock')).toHaveTextContent('0:50');
  });

  it('shows the recap and the board once the draft is complete', async () => {
    const entry = {
      overall: 2,
      round: 1,
      teamId: 'team-2',
      teamName: 'The Spreadsheet',
      player: CHASE,
      adp: 1,
      value: 1,
      reason: 'Best receiver on the board.'
    };
    const { api } = fakeApi(() =>
      board({
        status: 'complete',
        onTheClock: null,
        yourNextPick: null,
        picks: [{ ...board().picks[0]!, reason: 'Workhorse back.' }],
        recap: {
          steals: [{ ...entry, overall: 14, round: 7, adp: 2, value: 12 }],
          reaches: [{ ...entry, reason: null, adp: null }],
          agentPicks: [entry, { ...entry, teamId: 'team-3', teamName: 'Robo', reason: null }]
        }
      })
    );
    renderDraft(api);
    const recap = await screen.findByTestId('draft-recap');
    expect(screen.getByTestId('draft-topbar')).toHaveTextContent(
      'The draft is complete. Good luck this season!'
    );
    expect(recap).toHaveTextContent("Steals: The Spreadsheet: Ja'Marr Chase at pick 14 (ADP 2)");
    expect(recap).toHaveTextContent("Reaches: The Spreadsheet: Ja'Marr Chase at pick 2");
    const firsts = within(screen.getByRole('list', { name: 'AI first picks' })).getAllByRole('listitem');
    expect(firsts[0]).toHaveTextContent(
      "The Spreadsheet took Ja'Marr Chase at pick 2: “Best receiver on the board.”"
    );
    expect(firsts[1]).toHaveTextContent(/^Robo took Ja'Marr Chase at pick 2$/);
    // The board is the view once the draft is over.
    expect(tab('Board')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('cell-1')).toHaveAttribute('title', 'Workhorse back.');
    expect(screen.getByTestId('ticker-1')).toHaveAttribute('title', 'Workhorse back.');
  });

  it('shows no recap sections that are empty', async () => {
    const { api } = fakeApi(() =>
      board({ status: 'complete', onTheClock: null, recap: { steals: [], reaches: [], agentPicks: [] } })
    );
    renderDraft(api);
    expect(await screen.findByTestId('draft-recap')).toHaveTextContent('');
    expect(screen.queryByText('Steals:')).not.toBeInTheDocument();
  });

  it('says it is polling when realtime is off', async () => {
    const { api } = fakeApi(() => board());
    renderDraft(api, 3000);
    expect(await screen.findByText('Refreshing every 3s')).toBeInTheDocument();
  });

  it('keeps a compact queue you can reorder, prune, and draft from', async () => {
    const user = userEvent.setup();
    let picked = false;
    const mine = board({ onTheClock: { ...MY_TURN, overall: 2, round: 1, pick: 2 } });
    const { api, calls } = fakeApi((path) => {
      if (path.endsWith('/picks')) {
        picked = true;
        return { pick: { overall: 2 } };
      }
      if (!picked) return mine;
      return board({
        onTheClock: null,
        status: 'complete',
        picks: [
          ...mine.picks,
          { overall: 2, round: 1, pick: 2, teamId: 'team-1', player: NYJ, auto: false, madeAt: null }
        ]
      });
    });
    renderDraft(api);
    await user.click(await screen.findByRole('tab', { name: 'Queue' }));
    // Empty, the queue is one quiet line.
    expect(screen.getByTestId('queue-hint')).toHaveTextContent('Queue players with ＋');
    await user.click(screen.getByRole('button', { name: "Queue Ja'Marr Chase" }));
    await user.click(screen.getByRole('button', { name: 'Queue NYJ Defense' }));
    expect(screen.getByRole('button', { name: "Queue Ja'Marr Chase" })).toBeDisabled();
    expect(tab('Queue')).toHaveTextContent('Queue (2)');
    const list = () => within(screen.getByRole('list', { name: 'Your queue' }));
    expect(
      list()
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual([expect.stringContaining("1.WRJa'Marr Chase"), expect.stringContaining('2.DEFNYJ Defense')]);
    expect(list().getByRole('button', { name: "Move Ja'Marr Chase up" })).toBeDisabled();
    await user.click(list().getByRole('button', { name: 'Move NYJ Defense up' }));
    expect(list().getAllByRole('listitem')[0]).toHaveTextContent('1.DEFNYJ Defense');
    await user.click(list().getByRole('button', { name: 'Draft NYJ Defense from the queue' }));
    expect(calls.find((c) => c.path.endsWith('/picks'))?.request.body).toEqual({
      playerId: 'fx-def-nyj',
      pick: 2
    });
    // Drafted players drop out of the queue.
    expect(await screen.findByText(/The draft is complete/)).toBeInTheDocument();
    await user.click(tab('Queue'));
    expect(list().queryByText(/NYJ Defense/)).not.toBeInTheDocument();
    await user.click(list().getByRole('button', { name: "Remove Ja'Marr Chase from the queue" }));
    expect(screen.getByTestId('queue-hint')).toBeInTheDocument();
    // Every change replaced the whole queue on the server, in order.
    const saves = calls.filter((c) => c.path === '/leagues/L1/draft/queue' && c.request.method === 'PUT');
    expect(saves.map((c) => (c.request.body as { playerIds: string[] }).playerIds)).toEqual([
      ['fx-chase'],
      ['fx-chase', 'fx-def-nyj'],
      ['fx-def-nyj', 'fx-chase'],
      ['fx-def-nyj']
    ]);
  });

  it('opens the queued player card from the queue', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi((path) =>
      path === '/players/card'
        ? {
            player: CHASE,
            scoring: { source: 'league' },
            bye: 10,
            injuryStatus: null,
            lastSeason: null,
            projection: null,
            news: []
          }
        : board()
    );
    renderDraft(api);
    await user.click(await screen.findByRole('button', { name: "Queue Ja'Marr Chase" }));
    await user.click(tab('Queue'));
    await user.click(
      within(screen.getByRole('list', { name: 'Your queue' })).getByRole('button', { name: "Ja'Marr Chase" })
    );
    expect(await screen.findByTestId('player-card')).toHaveTextContent('bye 10');
  });

  it('says when your queue cannot load', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi(() => board());
    const failing = (async (path: string, request?: ApiRequest) => {
      if (path.endsWith('/draft/queue')) {
        throw new ApiError(403, { code: 'FORBIDDEN', message: 'You do not manage a team in this league.' });
      }
      return api(path, request);
    }) as ApiFetch;
    renderDraft(failing);
    await user.click(await screen.findByRole('tab', { name: 'Queue' }));
    expect(await screen.findByText('You do not manage a team in this league.')).toBeInTheDocument();
  });

  it('shows a loading state first', () => {
    const api = (() => new Promise(() => undefined)) as unknown as ApiFetch;
    renderDraft(api);
    expect(screen.getByText('Loading the draft board…')).toBeInTheDocument();
  });

  it('has the draft chat on its own tab', async () => {
    const user = userEvent.setup();
    const { chat, markRead, list } = fakeChat();
    const { api } = fakeApi(() => board());
    renderDraft(api, 60_000, undefined, { chat });
    await user.click(await screen.findByRole('tab', { name: 'Chat' }));
    expect(await screen.findByText('Chase is mine next round.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Draft', level: 2 })).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith('L1', expect.objectContaining({ roomId: 'draft' }));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith('L1', 'draft'));
    // Who you can talk to (#177): the @ button opens the AI managers.
    await user.click(await screen.findByRole('button', { name: 'Mention someone' }));
    await user.click(await screen.findByRole('option', { name: /Sheets, The Spreadsheet, AI manager/ }));
    expect(screen.getByLabelText('Message')).toHaveValue('@Sheets ');
  });

  it('lets the commissioner pause the draft after a confirm, and resume it', async () => {
    const user = userEvent.setup();
    let status: DraftBoard['status'] = 'in_progress';
    const { api, calls } = fakeApi(
      (path) => {
        if (path.endsWith('/draft/pause')) status = 'paused';
        if (path.endsWith('/draft/resume')) {
          if (calls.filter((c) => c.path.endsWith('/draft/resume')).length > 1) {
            return new ApiError(409, {
              code: 'CONFLICT',
              message: 'The draft is not paused.',
              fix: 'Reload.'
            });
          }
          status = 'in_progress';
        }
        return path.endsWith('/draft')
          ? board({
              status,
              onTheClock: {
                ...board().onTheClock!,
                deadline: status === 'paused' ? null : board().onTheClock!.deadline
              }
            })
          : { status };
      },
      ['pause_draft', 'resume_draft', 'make_draft_pick']
    );
    renderDraft(api);
    await user.click(await screen.findByRole('button', { name: 'Pause draft' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('The pick clock freezes for everyone');
    await user.click(within(dialog).getByRole('button', { name: 'Pause draft' }));
    expect(calls.find((c) => c.path === '/leagues/L1/draft/pause')?.request.method).toBe('POST');
    expect(await screen.findByRole('button', { name: 'Resume draft' })).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume draft' }));
    expect(await screen.findByRole('button', { name: 'Pause draft' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/leagues/L1/draft/resume')).toBe(true);
    // A failed resume says why.
    status = 'paused';
    await user.click(screen.getByRole('button', { name: 'Pause draft' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Pause draft' }));
    await user.click(await screen.findByRole('button', { name: 'Resume draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The draft is not paused. Reload.');
  });
});

describe('draft room on a phone', () => {
  it('stacks a sticky clock over one panel at a time, picked from bottom tabs', async () => {
    width.set(false);
    {
      const user = userEvent.setup();
      const { chat } = fakeChat();
      const { api } = fakeApi((path) =>
        path.endsWith('/draft/depth') ? { yourTeamId: 'team-1', teams: [] } : board()
      );
      renderDraft(api, 60_000, undefined, { chat });
      const room = await screen.findByTestId('draft-room');
      expect(room).toHaveAttribute('data-layout', 'phone');
      const tabs = within(screen.getByRole('tablist', { name: 'Draft room' }));
      expect(tabs.getAllByRole('tab').map((t) => t.textContent)).toEqual([
        'Players',
        'Queue',
        'Roster',
        'Board',
        'Chat'
      ]);
      expect(screen.getByRole('table', { name: 'Best available' })).toBeInTheDocument();
      await user.click(tabs.getByRole('tab', { name: 'Roster' }));
      expect(screen.getByTestId('roster-needs')).toBeInTheDocument();
      expect(screen.queryByRole('table', { name: 'Best available' })).toBeNull();
      await user.click(tabs.getByRole('tab', { name: 'Queue' }));
      expect(screen.getByTestId('queue-hint')).toBeInTheDocument();
      await user.click(tabs.getByRole('tab', { name: 'Board' }));
      expect(screen.getByTestId('pick-ticker')).toBeInTheDocument();
      expect(screen.getByRole('table', { name: 'Draft board' })).toBeInTheDocument();
      await user.click(
        within(screen.getByRole('tablist', { name: 'Board view' })).getByRole('tab', { name: 'Depth' })
      );
      expect(await screen.findByRole('table', { name: 'Depth chart' })).toBeInTheDocument();
      await user.click(tabs.getByRole('tab', { name: 'Chat' }));
      expect(await screen.findByText('Chase is mine next round.')).toBeInTheDocument();
      // Widening the window switches to the desktop room.
      width.set(true);
      expect(screen.getByTestId('draft-room')).toHaveAttribute('data-layout', 'wide');
    }
  });

  it('opens on the board once the draft is complete', async () => {
    width.set(false);
    const { api } = fakeApi(() => board({ status: 'complete', onTheClock: null, yourNextPick: null }));
    renderDraft(api);
    expect(await screen.findByRole('table', { name: 'Draft board' })).toBeInTheDocument();
    expect(screen.queryByTestId('ticker-clock')).toBeNull();
  });

  it('is the desktop room where the browser cannot tell the width', async () => {
    width.restore();
    const original = window.matchMedia;
    // @ts-expect-error: a browser without matchMedia
    delete window.matchMedia;
    try {
      const { api } = fakeApi(() => board());
      renderDraft(api);
      expect(await screen.findByTestId('draft-room')).toHaveAttribute('data-layout', 'wide');
    } finally {
      window.matchMedia = original;
    }
  });
});

describe('draft room motion and sound', () => {
  const yourTurn = () => board({ onTheClock: { ...MY_TURN, deadline: '2026-09-30T12:00:30.000Z' } });

  it("pulses, badges the tab, says you're up, and celebrates your first pick with confetti", async () => {
    const user = userEvent.setup();
    document.title = 'Fantasy';
    let picked = false;
    const { api } = fakeApi((path) => {
      if (path.endsWith('/picks')) {
        picked = true;
        return {};
      }
      return picked ? board({ onTheClock: null, status: 'complete', yourNextPick: null }) : yourTurn();
    });
    const chime = vi.fn();
    // Your first pick: the roster is empty before it.
    renderDraft(
      (async (path: string, request?: ApiRequest) => {
        const res = await api(path, request);
        if (path.endsWith('/draft') && !picked) {
          return { ...res, data: { ...(res.data as DraftBoard), rosters: [] } };
        }
        return res;
      }) as ApiFetch,
      60_000,
      undefined,
      { chime }
    );
    expect(await screen.findByTestId('youre-up')).toHaveTextContent("You're up!");
    expect(screen.getByTestId('draft-topbar')).toHaveClass('motion-attention');
    // Sound is off by default.
    expect(chime).not.toHaveBeenCalled();
    await waitFor(() => expect(document.title).toBe('Your pick! · Fantasy'));

    await user.click(screen.getByRole('button', { name: "Draft Ja'Marr Chase" }));
    expect(await screen.findByText("You drafted Ja'Marr Chase!")).toBeInTheDocument();
    expect(screen.getByTestId('confetti')).toBeInTheDocument();
    expect(await screen.findByText(/The draft is complete/)).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Fantasy'));
  });

  it('does not throw confetti after your first pick', async () => {
    const user = userEvent.setup();
    let picked = false;
    const { api } = fakeApi((path) => {
      if (path.endsWith('/picks')) {
        picked = true;
        return {};
      }
      return picked ? board({ onTheClock: null, status: 'complete' }) : yourTurn();
    });
    renderDraft(api);
    await user.click(await screen.findByRole('button', { name: "Draft Ja'Marr Chase" }));
    expect(await screen.findByText("You drafted Ja'Marr Chase!")).toBeInTheDocument();
    expect(screen.queryByTestId('confetti')).toBeNull();
  });

  it('chimes when you are up once the sound is on, and remembers the choice', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let mine = false;
    let onEvent: (event: LeagueEvent) => void = () => undefined;
    const connect: EventConnect = async (_target, handlers) => {
      onEvent = handlers.onEvent;
      return () => undefined;
    };
    const { api } = fakeApi((path) => (path.endsWith('/realtime') ? LIVE_INFO : mine ? yourTurn() : board()));
    const chime = vi.fn();
    renderDraft(api, 60_000, connect, { chime });
    const toggle = await screen.findByRole('button', { name: 'Sound off' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Sound on' })).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('fantasy:draft-sound')).toBe('on');
    mine = true;
    act(() => onEvent({ detailType: 'Draft Turn Started', leagueId: 'L1' }));
    expect(await screen.findByTestId('youre-up')).toBeInTheDocument();
    expect(chime).toHaveBeenCalledTimes(1);
    // The moment passes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.queryByTestId('youre-up')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sound on' }));
    expect(localStorage.getItem('fantasy:draft-sound')).toBeNull();
  });

  it('pulses your clock in its last seconds', async () => {
    const { api } = fakeApi(() => board({ onTheClock: { ...MY_TURN, secondsLeft: 8 } }));
    renderDraft(api);
    expect(await screen.findByTestId('pick-clock')).toHaveClass('motion-urgent');
  });

  it('slides new picks onto the ticker and flips them onto the board, but not the ones already made', async () => {
    const user = userEvent.setup();
    let onEvent: (event: LeagueEvent) => void = () => undefined;
    const connect: EventConnect = async (_target, handlers) => {
      onEvent = handlers.onEvent;
      return () => undefined;
    };
    let picks = board().picks;
    const { api } = fakeApi((path) => (path.endsWith('/realtime') ? LIVE_INFO : board({ picks })));
    renderDraft(api, 3000, connect);
    expect(await screen.findByText('Updating live')).toBeInTheDocument();
    await user.click(tab('Board'));
    expect(screen.getByTestId('cell-1').querySelector('.motion-flip-in')).toBeNull();
    expect(screen.getByTestId('ticker-1')).not.toHaveClass('motion-slide-in');
    picks = [
      ...picks,
      { overall: 2, round: 1, pick: 2, teamId: 'team-2', player: CHASE, auto: false, madeAt: null }
    ];
    act(() => onEvent({ detailType: 'Draft Pick Made', leagueId: 'L1' }));
    expect(await screen.findByTestId('cell-2')).toHaveTextContent('J. Chase');
    expect(screen.getByTestId('cell-2').querySelector('.motion-flip-in')).not.toBeNull();
    expect(screen.getByTestId('ticker-2')).toHaveClass('motion-slide-in');
    expect(screen.getByTestId('cell-1').querySelector('.motion-flip-in')).toBeNull();
  });
});

describe('spaceBelow', () => {
  it('adds later siblings in the flow and each ancestor’s bottom padding, border, and margin', () => {
    const outer = document.createElement('div');
    outer.style.paddingBottom = '24px';
    outer.style.borderBottom = '2px solid';
    const el = document.createElement('div');
    el.style.marginBottom = '4px';
    const after = document.createElement('div');
    const fixed = document.createElement('div');
    fixed.style.position = 'fixed';
    outer.append(el, after, fixed);
    document.body.append(outer);
    after.getBoundingClientRect = () => ({ height: 10 }) as DOMRect;
    fixed.getBoundingClientRect = () => ({ height: 500 }) as DOMRect;
    try {
      expect(spaceBelow(el)).toBe(24 + 2 + 4 + 10);
    } finally {
      outer.remove();
    }
  });
});
