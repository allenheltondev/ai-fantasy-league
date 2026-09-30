import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi } from '../test/fakeApi';
import { renderApp, signInAs } from '../test/render';
import { timeAgo } from './NotificationPanel';
import { countLabel, notificationHref, type AppNotification, type NotificationSummary } from './types';

const ALICE = { sub: 'alice', email: 'alice@example.com', given_name: 'Alice' };
const NOW = Date.parse('2026-10-04T15:00:00Z');

function item(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n1',
    leagueId: 'L1',
    teamId: 'team-1',
    kind: 'trade_offer',
    title: "Trade offer from Bob's Team",
    body: "You'd get Rashee Rice for Tony Pollard.",
    target: { section: 'trades', tradeId: 'tr1' },
    event: { detailType: 'Trade Proposed', eventId: 'e1' },
    createdAt: '2026-10-04T14:55:00Z',
    read: false,
    readAt: null,
    deliveredAt: null,
    ...overrides
  };
}

const SUMMARY: NotificationSummary = {
  unreadCount: 3,
  leagues: [
    { leagueId: 'L1', name: 'Sunday Funday', teamId: 'team-1', unreadCount: 2, tradeOffersWaiting: 1 },
    { leagueId: 'L2', name: 'Work League', teamId: 'team-4', unreadCount: 1, tradeOffersWaiting: 0 }
  ]
};

const INBOX: Record<string, AppNotification[]> = {
  L1: [
    item(),
    item({
      id: 'n2',
      kind: 'waiver_won',
      title: 'Waiver claim won',
      body: 'Added to your roster: Puka Nacua ($7).',
      target: { section: 'roster', tradeId: null },
      createdAt: '2026-10-03T10:00:00Z',
      read: true
    })
  ],
  L2: [
    item({
      id: 'n3',
      leagueId: 'L2',
      kind: 'draft_on_clock',
      title: "You're on the clock",
      body: 'Pick 4 is yours.',
      target: { section: 'draft', tradeId: null },
      createdAt: '2026-10-04T14:59:30Z'
    })
  ]
};

function api(summary: NotificationSummary = SUMMARY) {
  return fakeApi({
    getNotificationSummary: vi.fn(async () => summary),
    listNotifications: vi.fn(async (leagueId: string) => {
      const notifications = INBOX[leagueId] ?? [];
      return { teamId: 'team-1', unreadCount: 0, notifications, nextCursor: null };
    })
  });
}

const bell = () => screen.getAllByTestId('notification-bell')[0] as HTMLElement;

afterEach(() => vi.useRealTimers());

describe('the notification bell', () => {
  it('shows every unread item across leagues on the header bar, one bell for every screen size', async () => {
    signInAs(ALICE);
    renderApp('/', undefined, api());
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications, 3 unread'));
    const bells = screen.getAllByTestId('notification-bell');
    expect(bells).toHaveLength(1);
    expect(within(bells[0]!).getByTestId('notification-count')).toHaveTextContent('3');
  });

  it('shows no count when nothing is unread', async () => {
    signInAs(ALICE);
    const quiet = api({ unreadCount: 0, leagues: [] });
    renderApp('/', undefined, quiet);
    await waitFor(() => expect(quiet.getNotificationSummary).toHaveBeenCalled());
    expect(bell()).toHaveAccessibleName('Notifications');
    expect(screen.queryByTestId('notification-count')).not.toBeInTheDocument();
  });

  it('opens a panel of every league’s items, newest first; opening one marks it read and goes there', async () => {
    const user = userEvent.setup();
    signInAs(ALICE);
    const fake = api();
    renderApp('/', undefined, fake);
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications, 3 unread'));
    await user.click(bell());
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    const list = await within(panel).findByRole('list', { name: 'Notifications' });
    const links = within(list).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual([
      "Unread: You're on the clock",
      "Unread: Trade offer from Bob's Team",
      'Waiver claim won'
    ]);
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/leagues/L2/draft',
      '/leagues/L1/team/trades?trade=tr1',
      '/leagues/L1/team/lineup'
    ]);
    // More than one league: each item names its league.
    expect(within(links[1] as HTMLElement).getByText(/Sunday Funday/)).toBeInTheDocument();
    expect(within(panel).getByText('2 unread')).toBeInTheDocument();

    await user.click(links[1] as HTMLElement);
    expect(fake.markNotificationsRead).toHaveBeenCalledWith('L1', { notificationIds: ['n1'] });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument()
    );
    expect(await screen.findByTestId('league-section-trades')).toBeInTheDocument();
  });

  it('marks everything read', async () => {
    const user = userEvent.setup();
    signInAs(ALICE);
    const fake = api();
    renderApp('/', undefined, fake);
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications, 3 unread'));
    await user.click(bell());
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    await within(panel).findByRole('list', { name: 'Notifications' });
    await user.click(within(panel).getByRole('button', { name: 'Mark all read' }));
    expect(fake.markNotificationsRead).toHaveBeenCalledWith('L1', { all: true });
    expect(fake.markNotificationsRead).toHaveBeenCalledWith('L2', { all: true });
    expect(await within(panel).findByText('All caught up')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();
  });

  it('says so when there is nothing, and shows errors with their fix', async () => {
    const user = userEvent.setup();
    signInAs(ALICE);
    renderApp('/', undefined, api({ unreadCount: 0, leagues: [] }));
    await user.click(bell());
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
    await user.keyboard('{Escape}');

    const failing = fakeApi({
      getNotificationSummary: vi.fn(async () => SUMMARY),
      listNotifications: vi.fn(async () => {
        throw new Error('The inbox is unavailable.');
      })
    });
    renderApp('/', undefined, failing);
    await waitFor(() =>
      expect(screen.getAllByTestId('notification-bell').at(-1)).toHaveAccessibleName(
        'Notifications, 3 unread'
      )
    );
    await user.click(screen.getAllByTestId('notification-bell').at(-1) as HTMLElement);
    expect(await screen.findByText('The inbox is unavailable.')).toBeInTheDocument();
  });

  it('badges Moves in the league nav with the offers waiting on you', async () => {
    signInAs(ALICE);
    renderApp('/leagues/L1/matchup', undefined, api());
    const nav = await screen.findByRole('navigation', { name: 'Primary navigation' });
    const trades = await within(nav).findByRole('link', { name: 'Moves 1 trade offer waiting' });
    expect(trades.querySelector('.app-nav-link-badge-error')).toHaveTextContent('1');
  });

  it('re-reads the summary when the tab comes back into view', async () => {
    signInAs(ALICE);
    const fake = api();
    renderApp('/', undefined, fake);
    await waitFor(() => expect(fake.getNotificationSummary).toHaveBeenCalledTimes(1));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(fake.getNotificationSummary).toHaveBeenCalledTimes(2));
  });
});

describe('the notification panel, one league', () => {
  const ONE: NotificationSummary = {
    unreadCount: 1,
    leagues: [
      { leagueId: 'L1', name: 'Sunday Funday', teamId: 'team-1', unreadCount: 1, tradeOffersWaiting: 2 }
    ]
  };

  it('leaves league names off, opens a read item without marking it again, and badges plural offers', async () => {
    const user = userEvent.setup();
    signInAs(ALICE);
    const fake = api(ONE);
    renderApp('/leagues/L1/matchup', undefined, fake);
    const nav = await screen.findByRole('navigation', { name: 'Primary navigation' });
    expect(
      await within(nav).findByRole('link', { name: 'Moves 2 trade offers waiting' })
    ).toBeInTheDocument();
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications, 1 unread'));
    await user.click(bell());
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    const read = await within(panel).findByRole('link', { name: 'Waiver claim won' });
    expect(within(panel).queryByText(/Sunday Funday/)).not.toBeInTheDocument();
    await user.click(read);
    expect(fake.markNotificationsRead).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument()
    );
  });

  it('shows why "Mark all read" failed and keeps the items unread', async () => {
    const user = userEvent.setup();
    signInAs(ALICE);
    const fake = api(ONE);
    fake.markNotificationsRead = vi.fn(async () => {
      throw new Error('Try again later.');
    });
    renderApp('/', undefined, fake);
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications, 1 unread'));
    await user.click(bell());
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    await within(panel).findByRole('list', { name: 'Notifications' });
    await user.click(within(panel).getByRole('button', { name: 'Mark all read' }));
    expect(await within(panel).findByText('Try again later.')).toBeInTheDocument();
    expect(within(panel).getByText('1 unread')).toBeInTheDocument();
  });
});

describe('player notifications (#200)', () => {
  const PLAYER_INBOX: AppNotification[] = [
    item({
      id: 'p-news',
      kind: 'player_news',
      title: 'News: Mark Andrews',
      body: 'Andrews limited in practice (ESPN)',
      target: { section: 'lineup', tradeId: null, playerId: '5012' },
      createdAt: '2026-10-04T14:58:00Z'
    }),
    item({
      id: 'p-out',
      kind: 'player_status',
      urgent: true,
      title: 'Starter out: Christian McCaffrey',
      body: "Your starter Christian McCaffrey (RB, SF) is OUT for today's game. Set your lineup.",
      target: { section: 'lineup', tradeId: null, playerId: '4034' },
      createdAt: '2026-10-04T14:30:00Z'
    }),
    item({ id: 'p-old', createdAt: '2026-10-04T14:00:00Z', read: true })
  ];
  const ONE: NotificationSummary = {
    unreadCount: 2,
    leagues: [
      { leagueId: 'L1', name: 'Sunday Funday', teamId: 'team-1', unreadCount: 2, tradeOffersWaiting: 0 }
    ]
  };

  it('puts an urgent starter alert on top in red, one tap from the lineup with him highlighted', async () => {
    const user = userEvent.setup();
    signInAs(ALICE);
    const fake = fakeApi({
      getNotificationSummary: vi.fn(async () => ONE),
      listNotifications: vi.fn(async () => ({
        teamId: 'team-1',
        unreadCount: 2,
        notifications: PLAYER_INBOX,
        nextCursor: null
      }))
    });
    renderApp('/', undefined, fake);
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications, 2 unread'));
    await user.click(bell());
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    const list = await within(panel).findByRole('list', { name: 'Notifications' });
    const links = within(list).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual([
      'Action needed: Starter out: Christian McCaffrey',
      'Unread: News: Mark Andrews',
      "Trade offer from Bob's Team"
    ]);
    expect(links[0]).toHaveAttribute('data-urgent', 'true');
    expect(links[0]).toHaveAttribute('href', '/leagues/L1/team/lineup?player=4034');
    expect(within(links[0] as HTMLElement).getByText('Fix your lineup')).toBeInTheDocument();
    expect(links[1]).not.toHaveAttribute('data-urgent');
    await user.click(links[0] as HTMLElement);
    expect(fake.markNotificationsRead).toHaveBeenCalledWith('L1', { notificationIds: ['p-out'] });
    expect(await screen.findByTestId('league-section-roster')).toBeInTheDocument();
  });

  it('turns player news off and back on from the panel, and undoes a failed change', async () => {
    const user = userEvent.setup();
    signInAs(ALICE);
    const fake = api(ONE);
    renderApp('/', undefined, fake);
    await user.click(bell());
    const panel = await screen.findByRole('dialog', { name: 'Notifications' });
    const setting = await within(panel).findByRole('switch', { name: /Player news/ });
    expect(setting).toBeChecked();
    await user.click(setting);
    expect(fake.updateNotificationPreferences).toHaveBeenCalledWith({ playerNews: false });
    await waitFor(() => expect(setting).not.toBeChecked());
    fake.updateNotificationPreferences = vi.fn(async () => {
      throw new Error('Settings are unavailable.');
    });
    await user.click(setting);
    expect(await within(panel).findByText('Settings are unavailable.')).toBeInTheDocument();
    expect(setting).not.toBeChecked();
  });
});

describe('helpers', () => {
  it('say when, link where, and cap counts', () => {
    expect(timeAgo('2026-10-04T14:59:30Z', NOW)).toBe('just now');
    expect(timeAgo('2026-10-04T14:55:00Z', NOW)).toBe('5m ago');
    expect(timeAgo('2026-10-04T12:00:00Z', NOW)).toBe('3h ago');
    expect(timeAgo('2026-10-02T15:00:00Z', NOW)).toBe('2d ago');
    expect(timeAgo('2026-09-01T15:00:00Z', NOW)).toMatch(/Sep/);
    expect(timeAgo('2026-10-05T15:00:00Z', NOW)).toBe('just now');
    expect(notificationHref(item({ target: { section: 'trades', tradeId: null } }))).toBe(
      '/leagues/L1/team/trades'
    );
    expect(notificationHref(item({ target: { section: 'lineup', tradeId: null } }))).toBe(
      '/leagues/L1/team/lineup'
    );
    expect(countLabel(7)).toBe('7');
    expect(countLabel(100)).toBe('99+');
  });
});
