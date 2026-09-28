import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { RealtimeInfo } from '../chat/api';
import type { EventConnect, LeagueEvent } from '../realtime/leagueEvents';
import type { PlayerRef, TradePreview, TradesApi, TradeView } from './api';
import { COUNTDOWN_TICK_MS, countdown, TradesPage } from './TradesPage';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const p = (id: string, name: string, position = 'RB'): PlayerRef => ({ id, name, team: 'SF', position });
const CMC = p('cmc', 'Christian McCaffrey');
const BIJAN = p('bijan', 'Bijan Robinson');
const CHASE = p('chase', "Ja'Marr Chase", 'WR');
const MINE = { id: 'team-1', name: 'Allen FC' };
const ROBO = { id: 'team-2', name: 'Robo Ballers' };

function trade(overrides: Partial<TradeView> = {}): TradeView {
  return {
    id: 't1',
    status: 'proposed',
    fromTeam: ROBO,
    toTeam: MINE,
    fromSends: [BIJAN],
    toSends: [CMC],
    fromDrops: [],
    toDrops: [],
    message: 'Swap?',
    reply: null,
    proposedAt: '2026-10-01T10:00:00Z',
    expiresAt: '2026-10-02T14:30:00Z',
    reviewEndsAt: null,
    counterOf: null,
    counterChain: [],
    round: 0,
    vetoVotes: 0,
    vetoVotesRequired: 3,
    youVotedToVeto: false,
    voidReason: null,
    direction: 'incoming',
    yourActions: ['accept', 'reject', 'counter'],
    ...overrides
  };
}

function preview(valid = true): TradePreview {
  const side = (team: typeof MINE, lineupDelta: number) => ({
    team,
    sends: [],
    receives: [],
    drops: [],
    activeBefore: 14,
    activeAfter: 14,
    activeLimit: 15,
    dropsNeeded: 0,
    dropCandidates: [],
    lineupDelta,
    valueDelta: lineupDelta
  });
  return {
    valid,
    issues: valid ? [] : [{ code: 'PLAYER_LOCKED', message: 'Chase is locked.', fix: 'Wait for next week.' }],
    warnings: [],
    sides: [side(MINE, 12.5), side(ROBO, -4)],
    fairness: { favors: 'team-1', lineupGap: 16.5, valueGap: 16.5, lopsided: false }
  };
}

function fakeApi(trades: TradeView[], overrides: Partial<TradesApi> = {}): TradesApi {
  return {
    setup: vi.fn(async () => ({ yourTeam: MINE, teams: [MINE, ROBO], allowedActions: ['propose_trade'] })),
    roster: vi.fn(async (_l: string, teamId: string) => (teamId === 'team-1' ? [CMC, CHASE] : [BIJAN])),
    list: vi.fn(async () => trades),
    preview: vi.fn(async () => preview()),
    propose: vi.fn(async () => trade({ id: 't9', direction: 'outgoing' })),
    counter: vi.fn(async () => trade({ id: 't2', round: 1, direction: 'outgoing' })),
    respond: vi.fn(async (_l: string, _t: string, response: string) =>
      trade({ status: response === 'accept' ? 'in_review' : 'rejected' })
    ),
    withdraw: vi.fn(async () => trade({ status: 'withdrawn' })),
    vote: vi.fn(async () => trade({ status: 'in_review' })),
    realtime: vi.fn(async () => OFF),
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
const LIVE: RealtimeInfo = {
  enabled: true,
  token: 'tok',
  endpoint: 'https://momento',
  cacheName: 'cache',
  topics: { league: 'fantasy.league.L1', global: 'fantasy.global', team: 'fantasy.team.L1.team-1' },
  expiresAt: null,
  pollIntervalSeconds: 60
};
const fixedNow = () => NOW;
const noConnect: EventConnect = async () => () => undefined;

function renderPage(
  api: TradesApi,
  now: () => number = fixedNow,
  connect: EventConnect = noConnect,
  path = '/leagues/L1/trades'
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/leagues/:leagueId/trades"
          element={<TradesPage api={api} now={now} connect={connect} />}
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('TradesPage', () => {
  it('builds an offer with a live preview and proposes it', async () => {
    const user = userEvent.setup();
    const api = fakeApi([]);
    renderPage(api);
    await user.selectOptions(await screen.findByLabelText('Trade with'), 'team-2');
    await user.click(await screen.findByLabelText('You send: Christian McCaffrey'));
    await user.click(await screen.findByLabelText('You receive: Bijan Robinson'));
    const panel = await screen.findByRole('region', { name: 'Trade preview' });
    expect(panel).toHaveTextContent('This trade is legal. It looks fair (favors Allen FC).');
    expect(panel).toHaveTextContent('Allen FC: lineup +12.5 pts, value +12.5, roster 14/15');
    expect(api.preview).toHaveBeenLastCalledWith('L1', {
      withTeamId: 'team-2',
      send: ['cmc'],
      receive: ['bijan'],
      drops: []
    });
    await user.click(screen.getByRole('button', { name: 'Propose trade' }));
    expect(api.propose).toHaveBeenCalledWith(
      'L1',
      expect.objectContaining({ send: ['cmc'], receive: ['bijan'] })
    );
    expect(await screen.findByText('Offer sent: the trade is now proposed.')).toBeInTheDocument();
  });

  it('shows why an offer is not legal and keeps propose disabled', async () => {
    const user = userEvent.setup();
    renderPage(fakeApi([], { preview: vi.fn(async () => preview(false)) }));
    await user.selectOptions(await screen.findByLabelText('Trade with'), 'team-2');
    await user.click(await screen.findByLabelText('You send: Christian McCaffrey'));
    expect(await screen.findByText('Chase is locked. Wait for next week.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Propose trade' })).toBeDisabled();
  });

  it('lists the inbox with an expiry countdown, and accepts or rejects', async () => {
    const user = userEvent.setup();
    const api = fakeApi([trade(), trade({ id: 't3', direction: 'outgoing', yourActions: ['withdraw'] })]);
    renderPage(api);
    const inbox = await screen.findByRole('region', { name: 'Inbox' });
    expect(await within(inbox).findByText(/Expires in 1d 2h/)).toBeInTheDocument();
    expect(within(inbox).getByText('“Swap?”')).toBeInTheDocument();
    await user.click(within(inbox).getByRole('button', { name: 'Accept' }));
    expect(api.respond).toHaveBeenCalledWith('L1', 't1', 'accept');
    expect(await screen.findByText('Accept: the trade is now in review.')).toBeInTheDocument();
    await user.click(within(inbox).getByRole('button', { name: 'Reject' }));
    expect(api.respond).toHaveBeenCalledWith('L1', 't1', 'reject');

    const sent = screen.getByRole('region', { name: 'Sent offers' });
    await user.click(within(sent).getByRole('button', { name: 'Withdraw' }));
    expect(api.withdraw).toHaveBeenCalledWith('L1', 't3');
  });

  it('counters an offer from the builder, prefilled with the swapped sides', async () => {
    const user = userEvent.setup();
    const api = fakeApi([trade()]);
    renderPage(api);
    await user.click(await screen.findByRole('button', { name: 'Counter' }));
    expect(screen.getByText("Counter Robo Ballers's offer")).toBeInTheDocument();
    expect(await screen.findByLabelText('You send: Christian McCaffrey')).toBeChecked();
    await user.click(screen.getByLabelText("You send: Ja'Marr Chase"));
    await screen.findByRole('region', { name: 'Trade preview' });
    await user.click(screen.getByRole('button', { name: 'Send counter' }));
    expect(api.counter).toHaveBeenCalledWith(
      'L1',
      't1',
      expect.objectContaining({ send: ['cmc', 'chase'], receive: ['bijan'] })
    );
    await user.click(await screen.findByRole('button', { name: 'Counter' }));
    await user.click(screen.getByRole('button', { name: 'Cancel counter' }));
    expect(screen.getByText('Propose a trade')).toBeInTheDocument();
  });

  it('shows league review with veto votes and commissioner approval, and API errors with their fix', async () => {
    const user = userEvent.setup();
    const review = trade({
      id: 't4',
      status: 'in_review',
      direction: 'league',
      reviewEndsAt: '2026-10-03T12:00:00Z',
      vetoVotes: 1,
      yourActions: ['approve', 'vote']
    });
    const api = fakeApi(
      [
        review,
        trade({
          id: 't5',
          status: 'vetoed',
          direction: 'league',
          yourActions: [],
          voidReason: { code: 'PLAYER_NOT_ON_ROSTER', message: 'Bijan left.', fix: '' }
        })
      ],
      {
        vote: vi.fn(async () => {
          throw new ApiError(409, {
            code: 'VOTE_NOT_ALLOWED',
            message: 'Already voted.',
            fix: 'No action needed.'
          });
        })
      }
    );
    renderPage(api);
    const region = await screen.findByRole('region', { name: 'League review' });
    expect(await within(region).findByText(/1\/3 veto votes/)).toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Veto' }));
    expect(api.vote).toHaveBeenCalledWith('L1', 't4', 'veto');
    expect(await screen.findByText('No action needed.')).toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Approve' }));
    expect(api.vote).toHaveBeenCalledWith('L1', 't4', 'approve');
    expect(
      within(screen.getByRole('region', { name: 'History' })).getByText('Cancelled: Bijan left.')
    ).toBeInTheDocument();
  });

  it('asks for drops when the preview says the roster would be too big', async () => {
    const user = userEvent.setup();
    const full = preview();
    full.sides[0] = { ...full.sides[0], dropsNeeded: 1, activeAfter: 16 };
    const api = fakeApi([], { preview: vi.fn(async () => full) });
    renderPage(api);
    await user.selectOptions(await screen.findByLabelText('Trade with'), 'team-2');
    await user.click(await screen.findByLabelText('You receive: Bijan Robinson'));
    await user.click(await screen.findByLabelText("You drop: Ja'Marr Chase"));
    await waitFor(() =>
      expect(api.preview).toHaveBeenLastCalledWith('L1', expect.objectContaining({ drops: ['chase'] }))
    );
    expect(screen.getByText(/must drop 1/)).toBeInTheDocument();
  });

  it('shows closed trading, lopsided previews, notes, finished counters, and preview errors', async () => {
    const user = userEvent.setup();
    const lopsided = {
      ...preview(),
      warnings: [{ code: 'RESPONDER_MUST_DROP', message: 'They must drop one.', fix: 'x' }],
      fairness: { favors: null, lineupGap: 50, valueGap: 50, lopsided: true }
    };
    const api = fakeApi([trade({ id: 't6', status: 'processed', round: 1, toSends: [], yourActions: [] })], {
      setup: vi.fn(async () => ({ yourTeam: MINE, teams: [MINE, ROBO], allowedActions: [] })),
      preview: vi.fn(async () => lopsided)
    });
    const first = renderPage(api);
    expect(await screen.findByText('Trading is closed right now.')).toBeInTheDocument();
    const history = screen.getByRole('region', { name: 'History' });
    expect(await within(history).findByText('Counter #1')).toBeInTheDocument();
    expect(within(history).getByText(/for nothing\./)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Trade with'), 'team-2');
    const send = await screen.findByLabelText('You send: Christian McCaffrey');
    await user.click(send);
    await user.click(send);
    await user.click(send);
    await user.type(screen.getByLabelText('Note (optional)'), 'hi');
    const panel = await screen.findByRole('region', { name: 'Trade preview' });
    expect(panel).toHaveTextContent('It looks lopsided.');
    expect(panel).toHaveTextContent('They must drop one.');
    expect(api.preview).toHaveBeenLastCalledWith('L1', expect.objectContaining({ message: 'hi' }));

    const failing = fakeApi([], {
      preview: vi.fn(async () => {
        throw new ApiError(404, {
          code: 'PLAYER_NOT_FOUND',
          message: 'No such player.',
          fix: 'Search again.'
        });
      })
    });
    first.unmount();
    renderPage(failing);
    await user.selectOptions(await screen.findByLabelText('Trade with'), 'team-2');
    await user.click(await screen.findByLabelText('You send: Christian McCaffrey'));
    expect(await screen.findByText('Search again.')).toBeInTheDocument();
  });

  it('ticks the expiry countdown and reloads when a trade event arrives on the team topic', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let clock = NOW;
      let emit: ((event: LeagueEvent) => void) | null = null;
      const connect = vi.fn<EventConnect>(async (_target, handlers) => {
        emit = handlers.onEvent;
        return () => undefined;
      });
      const api = fakeApi([trade({ reply: 'Counter coming.' })], { realtime: vi.fn(async () => LIVE) });
      const now = () => clock;
      renderPage(api, now, connect);
      const inbox = await screen.findByRole('region', { name: 'Inbox' });
      expect(await within(inbox).findByText(/Expires in 1d 2h/)).toBeInTheDocument();
      expect(within(inbox).getByText('Reply: “Counter coming.”')).toBeInTheDocument();

      clock = NOW + 2 * 3_600_000;
      act(() => {
        vi.advanceTimersByTime(COUNTDOWN_TICK_MS);
      });
      expect(await within(inbox).findByText(/Expires in 1d 0h/)).toBeInTheDocument();

      await waitFor(() => expect(connect).toHaveBeenCalled());
      expect(connect.mock.calls[0]?.[0].topics).toEqual(['fantasy.league.L1', 'fantasy.team.L1.team-1']);
      const loads = vi.mocked(api.list).mock.calls.length;
      act(() => emit?.({ detailType: 'Trade Proposed', leagueId: 'L1' }));
      await waitFor(() => expect(api.list).toHaveBeenCalledTimes(loads + 1));
      act(() => emit?.({ detailType: 'Draft Pick Made', leagueId: 'L1' }));
      expect(api.list).toHaveBeenCalledTimes(loads + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('formats the countdown', () => {
    expect(countdown('2026-10-01T12:35:00Z', NOW)).toBe('35m');
    expect(countdown('2026-10-01T15:05:00Z', NOW)).toBe('3h 5m');
    expect(countdown('2026-10-01T11:00:00Z', NOW)).toBe('expired');
  });

  it('rings the trade a notification opened (?trade=, #165)', async () => {
    const api = fakeApi([trade(), trade({ id: 't3', direction: 'outgoing', yourActions: ['withdraw'] })]);
    renderPage(api, fixedNow, noConnect, '/leagues/L1/trades?trade=t3');
    const card = await screen.findByTestId('trade-t3');
    const focused = card.closest('[aria-current="true"]');
    expect(focused).not.toBeNull();
    expect(focused?.querySelector('.motion-attention')).not.toBeNull();
    expect(screen.getByTestId('trade-t1').closest('[aria-current="true"]')).toBeNull();
  });
});
