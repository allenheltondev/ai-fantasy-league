import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { ToastProvider } from '@readysetcloud/ui';
import { describe, expect, it, vi } from 'vitest';
import { LeagueApiContext } from '../api/league';
import { NotificationsProvider } from '../notifications/NotificationsContext';
import { fakeApi } from '../test/fakeApi';
import { CHAT_EVENT, parseTopicItem, type EventConnect, type LeagueEvent } from './leagueEvents';
import { LeagueNotifications } from './LeagueNotifications';
import { notificationFor } from './notifications';

const player = (name: string) => ({ id: name.toLowerCase(), name, team: 'KC', position: 'WR' });

function tradeDetail(overrides: Record<string, unknown> = {}) {
  return {
    leagueId: 'L1',
    tradeId: 'tr1',
    fromTeamId: 'team-2',
    toTeamId: 'team-1',
    fromPlayers: [player('Rashee Rice')],
    toPlayers: [player('Tony Pollard'), player('Jake Ferguson')],
    review: 'none',
    ...overrides
  };
}

const ev = (detailType: string, detail: Record<string, unknown>, eventId?: string): LeagueEvent => ({
  detailType,
  leagueId: 'L1',
  ...(eventId === undefined ? {} : { eventId }),
  detail
});

function chat(mentionedTeamIds: string[], authorTeamId: string | null = 'team-2') {
  return {
    message: {
      id: 'm1',
      leagueId: 'L1',
      kind: 'agent',
      author: { teamId: authorTeamId, teamName: 'Bots', name: 'The Spreadsheet' },
      text: `@Alice ${'that trade is robbery '.repeat(5)}`,
      mentionedTeamIds,
      event: null,
      createdAt: '2026-09-30T12:00:00Z'
    }
  };
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function inboxItem(overrides: Record<string, unknown> = {}) {
  return {
    leagueId: 'L1',
    teamId: 'team-1',
    notification: {
      id: 'n1',
      leagueId: 'L1',
      teamId: 'team-1',
      kind: 'trade_offer',
      title: "Trade offer from Bob's Team",
      body: "You'd get Rashee Rice for Tony Pollard.",
      target: { section: 'trades', tradeId: 'tr1' },
      event: { detailType: 'Trade Proposed', eventId: 'e1' },
      createdAt: '2026-09-30T12:00:00Z',
      read: false,
      readAt: null,
      deliveredAt: null,
      ...overrides
    }
  };
}

describe('notificationFor', () => {
  it('toasts your new inbox items, linking where they lead (#165)', () => {
    expect(notificationFor(ev('Notification Created', inboxItem()), 'team-1')).toEqual({
      message: "Trade offer from Bob's Team. You'd get Rashee Rice for Tony Pollard.",
      variant: 'info',
      inbox: { id: 'n1', leagueId: 'L1', href: '/leagues/L1/team/trades?trade=tr1' }
    });
    expect(
      notificationFor(
        ev(
          'Notification Created',
          inboxItem({ kind: 'waiver_won', target: { section: 'roster', tradeId: null } })
        ),
        'team-1'
      )
    ).toMatchObject({ variant: 'success', inbox: { href: '/leagues/L1/team/lineup' } });
    expect(
      notificationFor(ev('Notification Created', inboxItem({ kind: 'waiver_lost' })), 'team-1')?.variant
    ).toBe('warning');
    // Someone else's item, or a malformed one, says nothing.
    expect(notificationFor(ev('Notification Created', inboxItem()), 'team-2')).toBeNull();
    expect(notificationFor(ev('Notification Created', {}), 'team-1')).toBeNull();
  });

  it('pops only an urgent player alert, in red; routine status and news wait in the inbox (#200)', () => {
    const lineup = { section: 'lineup', tradeId: null, playerId: '4034' };
    expect(
      notificationFor(
        ev(
          'Notification Created',
          inboxItem({
            kind: 'player_status',
            urgent: true,
            title: 'Starter out: Christian McCaffrey',
            body: 'Set your lineup.',
            target: lineup
          })
        ),
        'team-1'
      )
    ).toEqual({
      message: 'Starter out: Christian McCaffrey. Set your lineup.',
      variant: 'error',
      inbox: { id: 'n1', leagueId: 'L1', href: '/leagues/L1/team/lineup?player=4034' }
    });
    for (const kind of ['player_status', 'player_news']) {
      expect(
        notificationFor(ev('Notification Created', inboxItem({ kind, target: lineup })), 'team-1')
      ).toBeNull();
    }
  });

  it('leaves trade news about your own team to your inbox', () => {
    for (const type of ['Trade Accepted', 'Trade Vetoed']) {
      expect(notificationFor(ev(type, tradeDetail()), 'team-1')).toBeNull();
      expect(notificationFor(ev(type, tradeDetail()), 'team-2')).toBeNull();
    }
    for (const type of ['Trade Proposed', 'Waivers Processed', 'Trade Processed']) {
      expect(notificationFor(ev(type, tradeDetail()), 'team-1')).toBeNull();
    }
  });

  it('tells the rest of the league about trades up for review and vetoes', () => {
    expect(notificationFor(ev('Trade Accepted', tradeDetail()), 'team-5')).toBeNull();
    expect(notificationFor(ev('Trade Accepted', tradeDetail({ review: 'league_vote' })), 'team-5')).toEqual({
      message: 'A trade was accepted and is up for league review.',
      variant: 'info'
    });
    expect(notificationFor(ev('Trade Vetoed', tradeDetail()), 'team-5')).toEqual({
      message: 'A trade was vetoed.',
      variant: 'info'
    });
  });

  it('shows chat mentions of your team, not your own', () => {
    const note = notificationFor(ev(CHAT_EVENT, chat(['team-1'])), 'team-1');
    expect(note?.message).toMatch(/^The Spreadsheet mentioned you: “@Alice that trade/);
    expect(note?.message.endsWith('…”')).toBe(true);
    expect(notificationFor(ev(CHAT_EVENT, chat(['team-3'])), 'team-1')).toBeNull();
    expect(notificationFor(ev(CHAT_EVENT, chat(['team-1'], 'team-1')), 'team-1')).toBeNull();
    expect(notificationFor(ev(CHAT_EVENT, {}), 'team-1')).toBeNull();
    const short = chat(['team-1']);
    const anonymous = { message: { ...short.message, text: 'hi @Alice', author: undefined } };
    expect(notificationFor(ev(CHAT_EVENT, anonymous), 'team-1')?.message).toBe(
      'Someone mentioned you: “hi @Alice”'
    );
    // Toasts carry the room: the message's, or trash talk for messages from before rooms.
    expect(note?.roomId).toBe('trash-talk');
    const inTrades = { message: { ...short.message, roomId: 'trades' } };
    expect(notificationFor(ev(CHAT_EVENT, inTrades), 'team-1')?.roomId).toBe('trades');
  });

  it('shows every direct message you receive, mention or not', () => {
    const dm = { message: { ...chat([]).message, roomId: 'dm-team-1-team-2', text: 'psst' } };
    expect(notificationFor(ev(CHAT_EVENT, dm), 'team-1')).toEqual({
      message: 'The Spreadsheet sent you a message: “psst”',
      variant: 'info',
      roomId: 'dm-team-1-team-2'
    });
    const mine = { message: { ...dm.message, author: { teamId: 'team-1', teamName: 'A', name: 'Alice' } } };
    expect(notificationFor(ev(CHAT_EVENT, mine), 'team-1')).toBeNull();
  });

  it('says nothing without a team, a detail, or for other events', () => {
    expect(notificationFor(ev('Notification Created', inboxItem()), null)).toBeNull();
    expect(notificationFor({ detailType: 'Notification Created', leagueId: 'L1' }, 'team-1')).toBeNull();
    expect(notificationFor(ev('Draft Pick Made', {}), 'team-1')).toBeNull();
  });
});

describe('parseTopicItem', () => {
  it('reads events with their id and detail, and chat messages as a chat event', () => {
    expect(
      parseTopicItem(
        JSON.stringify({
          type: 'event',
          detailType: 'Trade Vetoed',
          leagueId: 'L1',
          eventId: 'e1',
          detail: { a: 1 }
        })
      )
    ).toEqual({ detailType: 'Trade Vetoed', leagueId: 'L1', eventId: 'e1', detail: { a: 1 } });
    const message = chat(['team-1']).message;
    expect(parseTopicItem(JSON.stringify({ type: 'chat', leagueId: 'L1', message }))).toEqual({
      detailType: CHAT_EVENT,
      leagueId: 'L1',
      eventId: 'm1',
      detail: { message }
    });
    expect(
      parseTopicItem(JSON.stringify({ type: 'chat', message: { ...message, leagueId: undefined } }))?.leagueId
    ).toBeNull();
    expect(parseTopicItem(JSON.stringify({ type: 'other' }))).toBeNull();
  });
});

describe('LeagueNotifications', () => {
  const LIVE = {
    enabled: true,
    httpHost: 'api.example',
    realtimeHost: 'realtime.example',
    channels: { league: '/fantasy/league/L1', global: '/fantasy/global', team: '/fantasy/team/L1/team-1/k1' },
    refreshAt: null,
    pollIntervalSeconds: 30
  };

  function mount(path = '/leagues/L1/matchup') {
    let push: ((event: LeagueEvent) => void) | null = null;
    const connect: EventConnect = async (target, handlers) => {
      expect(target.channels).toEqual(['/fantasy/league/L1', '/fantasy/team/L1/team-1/k1']);
      push = handlers.onEvent;
      return () => undefined;
    };
    const api = fakeApi({ getRealtime: vi.fn(async () => LIVE) });
    render(
      <ToastProvider>
        <LeagueApiContext.Provider value={api}>
          <MemoryRouter initialEntries={[path]}>
            <NotificationsProvider>
              <LeagueNotifications leagueId="L1" yourTeamId="team-1" connect={connect} />
              <Where />
            </NotificationsProvider>
          </MemoryRouter>
        </LeagueApiContext.Provider>
      </ToastProvider>
    );
    return {
      api,
      connected: () => waitFor(() => expect(push).not.toBeNull()),
      push: (event: LeagueEvent) => act(() => push!(event))
    };
  }

  it('toasts inbox items and league news as they arrive, once per event, marking items delivered', async () => {
    const { push, connected, api } = mount();
    await connected();
    // An item can arrive twice (a redelivery): one toast.
    push(ev('Notification Created', inboxItem(), 'e1'));
    push(ev('Notification Created', inboxItem(), 'e1'));
    push(ev('Trade Vetoed', tradeDetail({ fromTeamId: 'team-3', toTeamId: 'team-4' }), 't2'));
    expect(await screen.findAllByText(/Trade offer from Bob's Team/)).toHaveLength(1);
    expect(screen.getByText('A trade was vetoed.')).toBeInTheDocument();
    await waitFor(() => expect(api.markNotificationsDelivered).toHaveBeenCalledWith('L1', ['n1']));
    expect(api.markNotificationsDelivered).toHaveBeenCalledTimes(1);
    // The bell re-reads its count.
    expect(api.getNotificationSummary).toHaveBeenCalled();

    // Open goes to the trade and marks the item read.
    const open = screen.getByRole('link', { name: 'Open' });
    expect(open).toHaveAttribute('href', '/leagues/L1/team/trades?trade=tr1');
    await act(async () => open.click());
    expect(screen.getByTestId('where')).toHaveTextContent('/leagues/L1/team/trades?trade=tr1');
    expect(api.markNotificationsRead).toHaveBeenCalledWith('L1', { notificationIds: ['n1'] });
  });

  it('links a chat toast to its room', async () => {
    const { push, connected } = mount();
    await connected();
    // An event without an id is shown too.
    push(ev(CHAT_EVENT, { message: { ...chat(['team-1']).message, roomId: 'trades' } }));
    expect(await screen.findByText(/mentioned you/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/leagues/L1/chat?room=trades'
    );
  });

  it('skips chat mentions while you are reading the chat', async () => {
    const { push, connected } = mount('/leagues/L1/chat');
    await connected();
    push(ev(CHAT_EVENT, chat(['team-1']), 'm1'));
    push(ev('Notification Created', inboxItem(), 'e1'));
    expect(await screen.findByText(/Trade offer from/)).toBeInTheDocument();
    expect(screen.queryByText(/mentioned you/)).not.toBeInTheDocument();
  });
});
