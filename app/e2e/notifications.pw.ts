import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { serveAuthConfig } from './support';

/**
 * The notification inbox (#165) against the real API with its event loop (the agents dev server,
 * see playwright.config.ts), where the seeded league `demo-trades` has two people: dev users
 * `local-notify-e2e` on team-1 and `local-rival-e2e` on team-2. While you're away the rival sends
 * you a trade offer; the events consumer puts it in your inbox. You sign in and the bell shows it,
 * the Trades tab shows the offer waiting, and opening the item takes you to the offer and clears
 * the bell.
 */

const YOU = 'notify-e2e';
const RIVAL = 'rival-e2e';
const LEAGUE = 'demo-trades';
const AGENT_API = `http://127.0.0.1:${process.env.E2E_AGENT_API_PORT ?? Number(process.env.E2E_API_PORT ?? 8787) + 1}`;

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

/** Calls the agents server's API as a dev user. */
async function call(
  request: APIRequestContext,
  who: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const response = await request.fetch(`${AGENT_API}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer dev:${who}`,
      ...(method === 'POST' ? { 'idempotency-key': `notify-${Date.now()}-${Math.random()}` } : {})
    },
    ...(body === undefined ? {} : { data: body })
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}

/** Signs in as a dev user and sends every API call to the agents server. */
async function signIn(context: BrowserContext, who: string): Promise<void> {
  await serveAuthConfig(context);
  const claims = { sub: `local-${who}`, email: `${who}@localhost`, given_name: who };
  const idToken = [base64url('{"alg":"none"}'), base64url(JSON.stringify(claims)), 'sig'].join('.');
  const session = JSON.stringify({ idToken, refreshToken: 'refresh', expiresAt: 4_102_444_800 });
  await context.addInitScript((value) => localStorage.setItem('rsc:auth', value), session);
  await context.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({
      url: `${AGENT_API}${url.pathname}${url.search}`,
      headers: { ...route.request().headers(), authorization: `Bearer dev:${who}` }
    });
    await route.fulfill({ response });
  });
}

test('a trade offer that arrives while you are away is on the bell at sign-in; opening it clears it', async ({
  browser,
  request
}) => {
  test.setTimeout(60_000);
  // A clean slate on a reused server: nothing unread. (One by one, not "mark all": the local clock
  // is pinned, so "everything up to now" would cover the offer this test is about to receive.)
  const before = await call(request, YOU, 'GET', `/leagues/${LEAGUE}/notifications?limit=50`);
  const unread = (before.notifications as { id: string; read: boolean }[]).filter((n) => !n.read);
  if (unread.length > 0) {
    await call(request, YOU, 'POST', '/notifications/read', {
      leagueId: LEAGUE,
      notificationIds: unread.map((n) => n.id)
    });
  }

  // While you're away, the rival offers Lamar Jackson for your Patrick Mahomes.
  const offer = await call(request, RIVAL, 'POST', `/leagues/${LEAGUE}/trades`, {
    withTeamId: 'team-1',
    send: ['fx-lamar'],
    receive: ['fx-mahomes']
  });
  const tradeId = (offer.trade as { id: string }).id;
  // The event loop delivers the offer to the inbox consumer.
  await expect
    .poll(async () => (await call(request, YOU, 'GET', '/notifications')).unreadCount, { timeout: 15_000 })
    .toBe(1);

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await signIn(context, YOU);
  const page = await context.newPage();
  await page.goto('/');

  // The bell says so as soon as you arrive.
  const bell = page.getByRole('button', { name: /^Notifications/ });
  await expect(bell).toHaveAccessibleName('Notifications, 1 unread');
  await expect(bell.getByTestId('notification-count')).toHaveText('1');

  // Its panel names the offer; opening it goes to the offer, ringed, and marks it read.
  await bell.click();
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  const item = panel.getByRole('link', { name: `Unread: Trade offer from ${RIVAL}'s Team` });
  await expect(item).toContainText("You'd get Lamar Jackson for Patrick Mahomes.");
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/leagues/${LEAGUE}/team/trades\\?trade=${tradeId}$`));
  await expect(panel).toBeHidden();
  await expect(page.locator('[aria-current="true"]').getByTestId(`trade-${tradeId}`)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Inbox' })).toContainText('sends Lamar Jackson');

  // The bell is clear; My Team › Trades in the side nav still shows the offer waiting on your answer.
  await expect(bell).toHaveAccessibleName('Notifications');
  await expect(bell.getByTestId('notification-count')).toHaveCount(0);
  const tradesTab = page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: /^Trades/ });
  await expect(tradesTab).toHaveAccessibleName('Trades 1 offer waiting');
  await expect(tradesTab.locator('.app-nav-link-badge')).toContainText('1');

  // Answering it clears the Trades badge.
  await page.getByRole('region', { name: 'Inbox' }).getByRole('button', { name: 'Reject' }).first().click();
  await expect(page.getByText('Reject: the trade is now rejected.')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Lineup' })
    .click();
  await expect(tradesTab.locator('.app-nav-link-badge')).toHaveCount(0);
  await context.close();
});
