import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiFetch, type ApiRequest } from '../api/client';
import { DraftLobby, formatCountdown, type DraftLobbyView } from './DraftLobby';
import type { DraftQueue } from './queue';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const chase = { id: 'fx-chase', name: "Ja'Marr Chase", team: 'CIN', position: 'WR' };
const lamb = { id: 'fx-lamb', name: 'CeeDee Lamb', team: null, position: 'WR' };

const TEAMS: DraftLobbyView['teams'] = [
  { teamId: 'team-1', teamName: "Allen's Team", seatType: 'human', here: true, lastSeenAt: null },
  { teamId: 'team-2', teamName: "Bob's Team", seatType: 'human', here: false, lastSeenAt: null },
  {
    teamId: 'team-3',
    teamName: 'The Spreadsheet',
    seatType: 'agent',
    manager: { name: 'Priya Okafor', avatarSeed: 'p1', personality: 'The Spreadsheet' },
    here: true,
    lastSeenAt: null
  }
];

function lobby(overrides: Partial<DraftLobbyView> = {}): DraftLobbyView {
  return {
    phase: 'setup',
    scheduledAt: null,
    orderMode: 'slots',
    serverTime: new Date(NOW).toISOString(),
    order: TEAMS,
    teams: TEAMS,
    commissionerHere: true,
    canStart: false,
    ...overrides
  };
}

function fakeQueue(players: DraftQueue['players'] = []): DraftQueue {
  return {
    players,
    ready: true,
    error: null,
    has: (id) => players.some((p) => p.id === id),
    add: vi.fn(),
    remove: vi.fn(),
    move: vi.fn()
  };
}

function fakeApi(handler: (path: string, request: ApiRequest) => unknown) {
  const calls: { path: string; request: ApiRequest }[] = [];
  const api = (async (path: string, request: ApiRequest = {}) => {
    calls.push({ path, request });
    const data = path === '/players' ? { players: [chase, lamb] } : handler(path, request);
    if (data instanceof Error) throw data;
    return { data, league: null, warnings: [] };
  }) as ApiFetch;
  return { api, calls };
}

function renderLobby(
  api: ApiFetch,
  props: { queue?: DraftQueue; onStarted?: () => void; now?: () => number } = {}
) {
  render(
    <DraftLobby
      api={api}
      leagueId="L1"
      queue={props.queue ?? fakeQueue()}
      now={props.now ?? (() => NOW)}
      refresh={0}
      onStarted={props.onStarted ?? (() => undefined)}
    />
  );
}

describe('formatCountdown', () => {
  it('shows days, hours, minutes, and seconds as needed', () => {
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(3_723_000)).toBe('01:02:03');
    expect(formatCountdown(2 * 86_400_000 + 5_000)).toBe('2d 00:00:05');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

describe('DraftLobby', () => {
  it('counts down on the server clock and shows the order and who is here', async () => {
    const { api, calls } = fakeApi(() =>
      // The server clock is 10 seconds ahead of this browser.
      lobby({ scheduledAt: '2026-09-30T12:01:15.000Z', serverTime: '2026-09-30T12:00:10.000Z' })
    );
    renderLobby(api);
    expect(await screen.findByTestId('draft-countdown')).toHaveTextContent('1:05');
    expect(screen.getByText(/The draft starts /)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Draft order' })).getAllByRole('listitem')).toHaveLength(
      3
    );
    const here = within(screen.getByRole('list', { name: "Who's here" }));
    expect(screen.getByText("Who's here (2 of 3)")).toBeInTheDocument();
    expect(here.getByText("Bob's Team").closest('li')).toHaveTextContent('Away');
    expect(here.getByText('The Spreadsheet').closest('li')).toHaveTextContent('AI · here');
    // The AI manager's name and avatar (#159).
    expect(here.getByText('The Spreadsheet').closest('li')).toHaveTextContent('Priya Okafor');
    expect(here.getByRole('img', { name: 'Priya Okafor avatar' })).toBeInTheDocument();
    expect(calls[0]).toEqual({ path: '/leagues/L1/draft/lobby', request: { method: 'POST' } });
    expect(screen.queryByRole('button', { name: 'Start now' })).not.toBeInTheDocument();
  });

  it('waits for the commissioner with no time set, and hides a shuffled order', async () => {
    const { api } = fakeApi(() => lobby({ orderMode: 'random', order: null }));
    renderLobby(api);
    expect(await screen.findByTestId('draft-countdown')).toHaveTextContent('Waiting for the commissioner');
    expect(screen.getByText('No draft time is set.')).toBeInTheDocument();
    expect(screen.getByText('The order is shuffled when the draft starts.')).toBeInTheDocument();
  });

  it('lets the commissioner start now, and says why a start failed', async () => {
    const user = userEvent.setup();
    const onStarted = vi.fn();
    let refuse = true;
    const { api, calls } = fakeApi((path) => {
      if (path.endsWith('/draft/start')) {
        if (!refuse) return {};
        refuse = false;
        return new ApiError(409, {
          code: 'SEATS_NOT_FILLED',
          message: '1 human seat(s) are still open.',
          fix: 'Invite someone.'
        });
      }
      return lobby({ canStart: true, orderMode: 'random', order: null });
    });
    renderLobby(api, { onStarted });
    await user.click(await screen.findByRole('button', { name: 'Start now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '1 human seat(s) are still open. Invite someone.'
    );
    await user.click(screen.getByRole('button', { name: 'Start now' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(calls.filter((c) => c.path.endsWith('/draft/start')).at(-1)?.request).toEqual({
      method: 'POST',
      body: { randomizeOrder: true }
    });
  });

  it('keeps your queue: find players, queue them, reorder and remove', async () => {
    const user = userEvent.setup();
    const queue = fakeQueue([chase, lamb]);
    const { api, calls } = fakeApi(() => lobby());
    renderLobby(api, { queue });
    const found = within(await screen.findByRole('list', { name: 'Players to queue' }));
    expect((await found.findByText(/CeeDee Lamb/)).closest('li')).toHaveTextContent('WR · FA');
    expect(found.getByRole('button', { name: "Queue Ja'Marr Chase" })).toBeDisabled();
    const list = within(screen.getByRole('list', { name: 'Your queue' }));
    await user.click(list.getByRole('button', { name: 'Move CeeDee Lamb up' }));
    expect(queue.move).toHaveBeenCalledWith('fx-lamb', -1);
    await user.click(list.getByRole('button', { name: "Remove Ja'Marr Chase from the queue" }));
    expect(queue.remove).toHaveBeenCalledWith('fx-chase');
    await user.type(screen.getByLabelText('Find players'), 'lamb');
    await waitFor(() => expect(calls.at(-1)?.request).toEqual({ query: { q: 'lamb', limit: 10 } }));
  });

  it('adds a found player to an empty queue, and shows queue errors', async () => {
    const user = userEvent.setup();
    const queue = { ...fakeQueue(), error: 'Could not save your queue.' };
    const { api } = fakeApi(() => lobby());
    renderLobby(api, { queue });
    expect(await screen.findByText(/Line up the players you want/)).toBeInTheDocument();
    expect(screen.getByText('Could not save your queue.')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: "Queue Ja'Marr Chase" }));
    expect(queue.add).toHaveBeenCalledWith(chase);
  });

  it('hands over to the board once the draft is on, and shows a failed check-in', async () => {
    const onStarted = vi.fn();
    renderLobby(fakeApi(() => lobby({ phase: 'drafting' })).api, { onStarted });
    await waitFor(() => expect(onStarted).toHaveBeenCalled());

    const failing = fakeApi(() => new TypeError('offline'));
    renderLobby(failing.api);
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
  });
});
