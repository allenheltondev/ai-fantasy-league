import { expect, test, type Page, type Route } from '@playwright/test';
import { signInStubbed, stubLiveMatchup } from './liveMatchup';

/**
 * Game-day player alerts (#200), against a stubbed API (get_roster, list_notifications,
 * get_notification_summary, and the preferences in packages/server/openapi.json) with a page script
 * standing in for AppSync Events: the test pushes `Player Status Changed` on the global channel and the
 * `Notification Created` that follows it on your team channel, as the relay would. Sunday, 11:30
 * Eastern: the 1pm games have not kicked off, and Christian McCaffrey has just been ruled out.
 */

test.use({ timezoneId: 'America/New_York' });

const NOW = '2026-10-04T15:30:00.000Z';
const KICKOFF = '2026-10-04T17:00:00.000Z';

const entry = (id: string, name: string, position: string, team: string, slot: string, out = false) => ({
  player: { id, name, team, position },
  slot,
  status: out ? 'out' : 'active',
  injuryStatus: out ? 'Out' : null,
  byeWeek: 9,
  onBye: false,
  kickoff: KICKOFF,
  opponent: { team: 'LAR', home: false },
  locked: false,
  projectedPoints: 15,
  points: null,
  recentPoints: null
});

const ALERT = {
  id: 'n-out',
  leagueId: 'L1',
  teamId: 'team-1',
  kind: 'player_status',
  urgent: true,
  title: 'Starter out: Christian McCaffrey',
  body: "Your starter Christian McCaffrey (RB, SF) is OUT for today's game. Set your lineup.",
  target: { section: 'lineup', tradeId: null, playerId: 'fx-cmc' },
  event: { detailType: 'Player Status Changed', eventId: 'evt-out' },
  createdAt: NOW,
  read: false,
  readAt: null,
  deliveredAt: null
};

const NEWS = {
  ...ALERT,
  id: 'n-news',
  kind: 'player_news',
  urgent: undefined,
  title: 'News: CeeDee Lamb',
  body: 'Lamb expected to play through ankle soreness (ESPN)',
  target: { section: 'lineup', tradeId: null, playerId: 'fx-lamb' },
  createdAt: '2026-10-04T15:10:00.000Z'
};

async function stubGameDay(page: Page) {
  const state = { out: false, inbox: [NEWS] as Record<string, unknown>[], rosterReads: 0 };
  const envelope = (data: unknown) => ({
    data,
    league: { id: 'L1', phase: 'regular_season', week: 4, allowedActions: ['set_lineup'] },
    warnings: []
  });
  const json = (route: Route, data: unknown) => route.fulfill({ json: envelope(data) });
  await stubLiveMatchup(page);
  await page.route(/\/api\/v1\/leagues\/L1\/teams\/team-1\/roster/, (route) => {
    state.rosterReads++;
    return json(route, {
      teamId: 'team-1',
      teamName: "Allen's Team",
      season: 2026,
      week: 4,
      lineupSaved: true,
      carriedFromWeek: null,
      slots: [
        { slot: 'QB', count: 1 },
        { slot: 'RB', count: 1 },
        { slot: 'WR', count: 1 },
        { slot: 'BN', count: 3 }
      ],
      players: [
        entry('fx-hurts', 'Jalen Hurts', 'QB', 'PHI', 'QB'),
        entry('fx-cmc', 'Christian McCaffrey', 'RB', 'SF', 'RB', state.out),
        entry('fx-lamb', 'CeeDee Lamb', 'WR', 'DAL', 'WR'),
        entry('fx-bijan', 'Bijan Robinson', 'RB', 'ATL', 'BN'),
        entry('fx-kittle', 'George Kittle', 'TE', 'SF', 'BN')
      ],
      projectedPoints: 45,
      optimal: null
    });
  });
  const unread = () => state.inbox.filter((n) => n.read !== true).length;
  await page.route(/\/api\/v1\/notifications$/, (route) =>
    json(route, {
      unreadCount: unread(),
      leagues: [
        {
          leagueId: 'L1',
          name: 'Sunday League',
          teamId: 'team-1',
          unreadCount: unread(),
          tradeOffersWaiting: 0
        }
      ]
    })
  );
  await page.route(/\/api\/v1\/leagues\/L1\/notifications/, (route) =>
    json(route, { teamId: 'team-1', unreadCount: unread(), notifications: state.inbox, nextCursor: null })
  );
  await page.route(/\/api\/v1\/notifications\/preferences/, (route) =>
    json(route, route.request().method() === 'PUT' ? route.request().postDataJSON() : { playerNews: true })
  );
  await page.route(/\/api\/v1\/notifications\/(read|delivered)/, (route) => {
    const body = route.request().postDataJSON() as { notificationIds?: string[] };
    if (route.request().url().endsWith('/read')) {
      state.inbox = state.inbox.map((n) =>
        body.notificationIds?.includes(n.id as string) ? { ...n, read: true } : n
      );
    }
    return json(route, { leagueId: 'L1', unreadCount: unread() });
  });
  return state;
}

/** Every open subscription hears each push (the lineup page's and the league's toasts). */
async function fanOutPushes(page: Page) {
  await page.addInitScript(() => {
    const handlers: ((event: unknown) => void)[] = [];
    window.__fantasyEvents = async (_target, h) => {
      handlers.push(h.onEvent as (event: unknown) => void);
      return () => undefined;
    };
    window.__pushFantasyEvent = (event) => handlers.forEach((handle) => handle(event));
  });
}

test.beforeEach(async ({ page }) => {
  await signInStubbed(page);
  await fanOutPushes(page);
});

test('a starter ruled out on game day: OUT without a reload, an urgent alert, one tap to his replacement', async ({
  page
}) => {
  await page.clock.install({ time: new Date(NOW) });
  const state = await stubGameDay(page);
  await page.goto('/leagues/L1/team/lineup');

  const cmc = page.getByTestId('roster-row-fx-cmc');
  await expect(cmc).toBeVisible();
  await expect(cmc.getByText('Out')).toHaveCount(0);
  await expect(page.getByTestId('notification-bell')).toHaveAccessibleName('Notifications, 1 unread');

  // ESPN's game-day report rules him out: the relay pushes the status, then his manager's alert.
  state.out = true;
  state.inbox = [ALERT, ...state.inbox];
  await page.evaluate(() =>
    window.__pushFantasyEvent?.({
      detailType: 'Player Status Changed',
      leagueId: null,
      detail: {
        playerId: 'fx-cmc',
        changes: [{ field: 'injuryStatus', from: null, to: 'Out' }],
        source: 'espn_gameday'
      }
    })
  );
  await expect(cmc.getByText('Out')).toBeVisible();
  await page.evaluate(
    (notification) =>
      window.__pushFantasyEvent?.({
        detailType: 'Notification Created',
        leagueId: 'L1',
        detail: { leagueId: 'L1', teamId: 'team-1', notification }
      }),
    ALERT
  );
  // The bell counts it and a red toast says so.
  await expect(page.getByTestId('notification-bell')).toHaveAccessibleName('Notifications, 2 unread');
  await expect(page.getByText(/Starter out: Christian McCaffrey\. Your starter/)).toBeVisible();

  // The inbox: the urgent alert on top, news quietly below it.
  await page.getByTestId('notification-bell').click();
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  const items = panel.getByRole('list', { name: 'Notifications' }).getByRole('link');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toHaveAccessibleName('Action needed: Starter out: Christian McCaffrey');
  await expect(items.nth(1)).toHaveAccessibleName('Unread: News: CeeDee Lamb');
  await expect(panel.getByRole('switch', { name: /Player news/ })).toBeChecked();

  // One tap: the lineup, with him highlighted and already picked up.
  await items.first().click();
  await expect(page).toHaveURL(/\/leagues\/L1\/team\/lineup\?player=fx-cmc$/);
  await expect(page.getByTestId('roster-row-fx-cmc')).toHaveAttribute('data-highlighted', 'true');
  await expect(page.getByTestId('player-alert')).toContainText('Christian McCaffrey is Out');
  await expect(page.getByTestId('moving-banner')).toContainText('Moving Christian McCaffrey');
  await page
    .getByRole('button', { name: /^Move Christian McCaffrey to the bench, swapping with Bijan Robinson/ })
    .click();
  await expect(page.getByRole('list', { name: 'Starters' })).toContainText('Bijan Robinson');
  await expect(page.getByTestId('notification-bell')).toHaveAccessibleName('Notifications, 1 unread');
});
