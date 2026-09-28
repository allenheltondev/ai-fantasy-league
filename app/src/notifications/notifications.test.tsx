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
  it('shows every unread item across leagues, on the header and beside the phone menu', async () => {
    signInAs(ALICE);
    renderApp('/', undefined, api());
    await waitFor(() => expect(bell()).toHaveAccessibleName('Notifications, 3 unread'));
    const bells = screen.getAllByTestId('notification-bell');
    expect(bells).toHaveLength(2);
    for (const b of bells) expect(within(b).getByTestId('notification-count')).toHaveTextContent('3');
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
      '/leagues/L1/trades?trade=tr1',
      '/leagues/L1/roster'
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

  it('badges the league’s Trades tab with the offers waiting on you', async () => {
    signInAs(ALICE);
    renderApp('/leagues/L1/matchup', undefined, api());
    const nav = await screen.findByRole('navigation', { name: 'League sections' });
    const badge = await within(nav).findByTestId('trades-badge');
    expect(badge).toHaveTextContent('1');
    expect(badge).toHaveAccessibleName('1 offer waiting');
    expect(within(nav).getByRole('link', { name: /Trades/ })).toContainElement(badge);
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

describe('helpers', () => {
  it('say when, link where, and cap counts', () => {
    expect(timeAgo('2026-10-04T14:59:30Z', NOW)).toBe('just now');
    expect(timeAgo('2026-10-04T14:55:00Z', NOW)).toBe('5m ago');
    expect(timeAgo('2026-10-04T12:00:00Z', NOW)).toBe('3h ago');
    expect(timeAgo('2026-10-02T15:00:00Z', NOW)).toBe('2d ago');
    expect(timeAgo('2026-09-01T15:00:00Z', NOW)).toMatch(/Sep/);
    expect(timeAgo('2026-10-05T15:00:00Z', NOW)).toBe('just now');
    expect(notificationHref(item({ target: { section: 'trades', tradeId: null } }))).toBe(
      '/leagues/L1/trades'
    );
    expect(countLabel(7)).toBe('7');
    expect(countLabel(100)).toBe('99+');
  });
});
