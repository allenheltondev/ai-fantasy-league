import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiFetch, type ApiRequest } from '../api/client';
import type { DraftBoard } from './board';
import { formatClock, overallPick, secondsUntil } from './board';
import { DraftPage } from './DraftPage';
import type { EventConnect, LeagueEvent } from '../realtime/leagueEvents';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const ref = (id: string, name: string, position: string, team: string | null = 'SF') => ({
  id,
  name,
  team,
  position
});

function board(overrides: Partial<DraftBoard> = {}): DraftBoard {
  return {
    status: 'in_progress',
    rounds: 2,
    pickSeconds: 90,
    startedAt: '2026-09-30T11:59:00.000Z',
    completedAt: null,
    order: [
      { teamId: 'team-1', teamName: "Allen's Team", seatType: 'human' },
      { teamId: 'team-2', teamName: 'The Spreadsheet', seatType: 'agent' }
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
    picks: [
      {
        overall: 1,
        round: 1,
        pick: 1,
        teamId: 'team-1',
        player: ref('fx-cmc', 'Christian McCaffrey', 'RB'),
        auto: true,
        madeAt: null
      }
    ],
    rosters: [
      { teamId: 'team-1', teamName: "Allen's Team", players: [ref('fx-cmc', 'Christian McCaffrey', 'RB')] },
      { teamId: 'team-2', teamName: 'The Spreadsheet', players: [] }
    ],
    bestAvailable: [
      { player: ref('fx-chase', "Ja'Marr Chase", 'WR', 'CIN'), rank: 1 },
      { player: ref('fx-def-nyj', 'NYJ Defense', 'DEF', null), rank: null }
    ],
    ...overrides
  };
}

type Handler = (path: string, request: ApiRequest) => unknown;

function fakeApi(handler: Handler) {
  const calls: { path: string; request: ApiRequest }[] = [];
  const api = (async (path: string, request: ApiRequest = {}) => {
    calls.push({ path, request });
    const data = handler(path, request);
    if (data instanceof Error) throw data;
    return { data, league: null, warnings: [] };
  }) as ApiFetch;
  return { api, calls };
}

function renderDraft(api: ApiFetch, pollMs = 60_000, connect?: EventConnect) {
  let now = NOW;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  render(
    <MemoryRouter initialEntries={['/leagues/L1/draft']}>
      <Routes>
        <Route
          path="/leagues/:leagueId/draft"
          element={<DraftPage api={api} pollMs={pollMs} now={clock.now} connect={connect} />}
        />
      </Routes>
    </MemoryRouter>
  );
  return clock;
}

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

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
  it('shows the grid, the clock, your next pick, and your roster while another team picks', async () => {
    const { api, calls } = fakeApi(() => board());
    renderDraft(api);
    expect(await screen.findByText(/is on the clock: round 1, pick 2/)).toBeInTheDocument();
    expect(screen.getByTestId('pick-clock')).toHaveTextContent('1:05');
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByTestId('cell-1')).toHaveTextContent('Christian McCaffrey (RB) · auto');
    expect(screen.getByTestId('cell-2')).toHaveTextContent('On the clock');
    expect(screen.getByTestId('cell-4')).toHaveTextContent('');
    expect(screen.getByText(/Your next pick is #3, 1 pick\(s\) away/)).toBeInTheDocument();
    expect(screen.getByText('Still to fill: QB, K')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Your roster' })).getByText(/McCaffrey/)
    ).toBeInTheDocument();
    expect(screen.getByText(/DEF · FA · rank —/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Draft Ja'Marr Chase" })).toBeDisabled();
    expect(calls.find((c) => c.path === '/leagues/L1/draft')).toEqual({
      path: '/leagues/L1/draft',
      request: { query: { q: undefined, position: undefined, limit: 25 } }
    });
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
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('lets you pick when you are on the clock, then refreshes', async () => {
    const user = userEvent.setup();
    let picked = false;
    const mine = board({
      onTheClock: {
        overall: 3,
        round: 2,
        pick: 1,
        teamId: 'team-1',
        teamName: "Allen's Team",
        deadline: null,
        secondsLeft: 30
      },
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
    expect(await screen.findByText(/You are on the clock!/)).toBeInTheDocument();
    expect(screen.getByTestId('pick-clock')).toHaveTextContent('0:30');
    await user.click(screen.getByRole('button', { name: "Draft Ja'Marr Chase" }));
    expect(calls.find((c) => c.path.endsWith('/picks'))?.request).toEqual({
      method: 'POST',
      body: { playerId: 'fx-chase', pick: 3 }
    });
    expect(await screen.findByText(/The draft is complete/)).toBeInTheDocument();
    expect(screen.getByText('Complete')).toBeInTheDocument();
  });

  it('shows why a pick was refused', async () => {
    const user = userEvent.setup();
    const mine = board({
      onTheClock: {
        overall: 3,
        round: 2,
        pick: 1,
        teamId: 'team-1',
        teamName: "Allen's Team",
        deadline: '2026-09-30T12:01:00.000Z',
        secondsLeft: 60
      }
    });
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
    expect(screen.getByTestId('pick-clock')).toHaveTextContent('0:40');
    await user.type(screen.getByLabelText('Search players'), 'chase');
    await user.click(
      within(screen.getByRole('group', { name: 'Position' })).getByRole('button', { name: 'WR' })
    );
    expect(calls.at(-1)?.request.query).toEqual({ q: 'chase', position: 'WR', limit: 25 });
    await user.click(screen.getByRole('button', { name: 'Sort by last season points per game' }));
    expect(calls.at(-1)?.request.query).toEqual({ q: 'chase', position: 'WR', limit: 25, sort: 'ppg' });
  });

  it('opens a player card from the board grid, your roster, and the queue', async () => {
    const user = userEvent.setup();
    const { api, calls } = fakeApi((path) =>
      path === '/players/card'
        ? {
            player: ref('fx-cmc', 'Christian McCaffrey', 'RB'),
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
      within(await screen.findByTestId('cell-1')).getByRole('button', { name: 'Christian McCaffrey' })
    );
    expect(await screen.findByTestId('player-card')).toHaveTextContent('bye 14');
    expect(calls.find((c) => c.path === '/players/card')?.request.query).toEqual({
      playerId: 'fx-cmc',
      leagueId: 'L1'
    });
    // Drafted already, and not your turn: no Draft button.
    expect(within(screen.getByTestId('player-card')).queryByRole('button', { name: 'Draft' })).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(within(screen.getByRole('list', { name: 'Your roster' })).getByRole('button'));
    expect(await screen.findByTestId('player-card')).toBeInTheDocument();
  });

  it('switches the board to the depth chart', async () => {
    const user = userEvent.setup();
    const { api, calls } = fakeApi((path) =>
      path.endsWith('/draft/depth') ? { yourTeamId: 'team-1', teams: [] } : board()
    );
    renderDraft(api);
    await user.click(await screen.findByRole('button', { name: 'Depth' }));
    expect(await screen.findByRole('table', { name: 'Depth chart' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/leagues/L1/draft/depth')).toBe(true);
    expect(screen.queryByRole('table', { name: 'Draft board' })).toBeNull();
  });

  it('shows a frozen clock with no time recorded as 0:00', async () => {
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
    expect(screen.getByTestId('cell-1')).toHaveTextContent(/^Christian McCaffrey \(RB\)$/);
  });

  it('explains a draft that has not started', async () => {
    const notStarted = fakeApi(
      () =>
        new ApiError(409, {
          code: 'DRAFT_NOT_STARTED',
          message: 'Not yet.',
          fix: 'Wait for the commissioner.'
        })
    );
    renderDraft(notStarted.api);
    expect(await screen.findByText('The draft has not started')).toBeInTheDocument();
    expect(screen.getByText('Wait for the commissioner.')).toBeInTheDocument();
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
    expect(await screen.findByText(/is on the clock/)).toBeInTheDocument();
    expect(screen.queryByText(/Your next pick/)).not.toBeInTheDocument();
  });

  it('refreshes the board on live draft events instead of polling fast', async () => {
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
    picks = [
      ...picks,
      {
        overall: 2,
        round: 1,
        pick: 2,
        teamId: 'team-2',
        player: ref('fx-chase', "Ja'Marr Chase", 'WR', 'CIN'),
        auto: false,
        madeAt: null
      }
    ];
    const before = calls.filter((c) => c.path.endsWith('/draft')).length;
    act(() => onEvent({ detailType: 'Draft Pick Made', leagueId: 'L1' }));
    expect(await screen.findByTestId('cell-2')).toHaveTextContent("Ja'Marr Chase (WR)");
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

  it('shows the recap with each AI first pick and its reasoning once the draft is complete', async () => {
    const entry = {
      overall: 2,
      round: 1,
      teamId: 'team-2',
      teamName: 'The Spreadsheet',
      player: ref('fx-chase', "Ja'Marr Chase", 'WR', 'CIN'),
      adp: 1,
      value: 1,
      reason: 'Best receiver on the board.'
    };
    const { api } = fakeApi(() =>
      board({
        status: 'complete',
        onTheClock: null,
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
    expect(recap).toHaveTextContent("Steals: The Spreadsheet: Ja'Marr Chase at pick 14 (ADP 2)");
    expect(recap).toHaveTextContent("Reaches: The Spreadsheet: Ja'Marr Chase at pick 2");
    const firsts = within(screen.getByRole('list', { name: 'AI first picks' })).getAllByRole('listitem');
    expect(firsts[0]).toHaveTextContent(
      "The Spreadsheet took Ja'Marr Chase at pick 2: “Best receiver on the board.”"
    );
    expect(firsts[1]).toHaveTextContent(/^Robo took Ja'Marr Chase at pick 2$/);
    expect(screen.getByTestId('cell-1')).toHaveAttribute('title', 'Workhorse back.');
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

  it('keeps a player queue you can reorder, prune, and draft from', async () => {
    const user = userEvent.setup();
    let picked = false;
    const mine = board({
      onTheClock: {
        overall: 2,
        round: 1,
        pick: 2,
        teamId: 'team-1',
        teamName: "Allen's Team",
        deadline: null,
        secondsLeft: 30
      }
    });
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
          {
            overall: 2,
            round: 1,
            pick: 2,
            teamId: 'team-1',
            player: ref('fx-def-nyj', 'NYJ Defense', 'DEF', null),
            auto: false,
            madeAt: null
          }
        ]
      });
    });
    renderDraft(api);
    expect(await screen.findByText(/Queue players from Best available/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Queue Ja'Marr Chase" }));
    await user.click(screen.getByRole('button', { name: 'Queue NYJ Defense' }));
    expect(screen.getByRole('button', { name: "Queue Ja'Marr Chase" })).toBeDisabled();
    const list = () => within(screen.getByRole('list', { name: 'Your queue' }));
    expect(
      list()
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual([expect.stringContaining("1. Ja'Marr Chase"), expect.stringContaining('2. NYJ Defense')]);
    expect(list().getByRole('button', { name: "Move Ja'Marr Chase up" })).toBeDisabled();
    await user.click(list().getByRole('button', { name: 'Move NYJ Defense up' }));
    expect(list().getAllByRole('listitem')[0]).toHaveTextContent('1. NYJ Defense');
    await user.click(list().getByRole('button', { name: 'Draft NYJ Defense from the queue' }));
    expect(calls.find((c) => c.path.endsWith('/picks'))?.request.body).toEqual({
      playerId: 'fx-def-nyj',
      pick: 2
    });
    // Drafted players drop out of the queue.
    expect(await screen.findByText(/The draft is complete/)).toBeInTheDocument();
    expect(list().queryByText(/NYJ Defense/)).not.toBeInTheDocument();
    await user.click(list().getByRole('button', { name: "Remove Ja'Marr Chase from the queue" }));
    expect(screen.getByText(/Queue players from Best available/)).toBeInTheDocument();
  });

  it('shows a loading state first', () => {
    const api = (() => new Promise(() => undefined)) as unknown as ApiFetch;
    renderDraft(api);
    expect(screen.getByText('Loading the draft board…')).toBeInTheDocument();
  });
});

describe('draft room motion', () => {
  const yourTurn = () =>
    board({
      onTheClock: {
        overall: 3,
        round: 2,
        pick: 1,
        teamId: 'team-1',
        teamName: "Allen's Team",
        deadline: '2026-09-30T12:00:30.000Z',
        secondsLeft: 30
      }
    });

  it('pulses and badges the tab on your turn, and celebrates your pick', async () => {
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
    renderDraft(api);
    const alert = await screen.findByText(/You are on the clock!/);
    expect(alert.closest('.motion-attention')).not.toBeNull();
    expect(document.title).toBe('Your pick! · Fantasy');

    await user.click(screen.getByRole('button', { name: "Draft Ja'Marr Chase" }));
    expect(await screen.findByText("You drafted Ja'Marr Chase!")).toBeInTheDocument();
    expect(screen.getByTestId('confetti')).toBeInTheDocument();
    expect(await screen.findByText(/The draft is complete/)).toBeInTheDocument();
    expect(document.title).toBe('Fantasy');
  });

  it('flips new picks onto the board, but not the ones already made', async () => {
    let onEvent: (event: LeagueEvent) => void = () => undefined;
    const connect: EventConnect = async (_target, handlers) => {
      onEvent = handlers.onEvent;
      return () => undefined;
    };
    let picks = board().picks;
    const { api } = fakeApi((path) => (path.endsWith('/realtime') ? LIVE_INFO : board({ picks })));
    renderDraft(api, 3000, connect);
    expect(await screen.findByText('Updating live')).toBeInTheDocument();
    expect(screen.getByTestId('cell-1').querySelector('.motion-flip-in')).toBeNull();
    picks = [
      ...picks,
      {
        overall: 2,
        round: 1,
        pick: 2,
        teamId: 'team-2',
        player: ref('fx-chase', "Ja'Marr Chase", 'WR', 'CIN'),
        auto: false,
        madeAt: null
      }
    ];
    act(() => onEvent({ detailType: 'Draft Pick Made', leagueId: 'L1' }));
    expect(await screen.findByTestId('cell-2')).toHaveTextContent("Ja'Marr Chase (WR)");
    expect(screen.getByTestId('cell-2').querySelector('.motion-flip-in')).not.toBeNull();
    expect(screen.getByTestId('cell-1').querySelector('.motion-flip-in')).toBeNull();
  });
});
