import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { signInAs } from './support';
import type { EventConnect, LeagueEvent } from '../src/realtime/leagueEvents';

/**
 * The league dashboard (#166) against the local API server's in-season demo league (`demo-season`,
 * dev user local-season-e2e): the league opens on Home with this week's matchups (yours first and
 * highlighted), the standings (your row highlighted), and the move board. The manager adds a free
 * agent and drops him again; each move shows up on the board when a league event arrives. Realtime
 * is switched on with a stand-in for Momento that the test pushes events through (as
 * nfl-games.pw.ts does). The roster ends as it started, so the other specs see the same league.
 */

const WHO = 'season-e2e';
const L = 'demo-season';
const TEAM = `${WHO}'s Team`;

declare global {
  interface Window {
    __dashboardHandlers?: ((event: LeagueEvent) => void)[];
  }
}

async function liveEvents(context: BrowserContext) {
  await context.route(`**/api/v1/leagues/${L}/realtime`, (route) =>
    route.fulfill({
      json: {
        data: {
          enabled: true,
          token: 'e2e-token',
          endpoint: null,
          cacheName: 'e2e-cache',
          topics: { league: `fantasy.league.${L}`, global: 'fantasy.global', team: null },
          expiresAt: '2099-01-01T00:00:00.000Z',
          pollIntervalSeconds: 30
        },
        league: null,
        warnings: []
      }
    })
  );
  await context.addInitScript(() => {
    const connect: EventConnect = async (_target, handlers) => {
      (window.__dashboardHandlers ??= []).push(handlers.onEvent);
      return () => undefined;
    };
    window.__fantasyEvents = connect;
  });
}

/** Pushes a league event to every open subscription, as the realtime relay would. */
const push = (page: Page, detailType: string) =>
  page.evaluate(
    ([type, leagueId]) => window.__dashboardHandlers?.forEach((h) => h({ detailType: type, leagueId })),
    [detailType, L] as const
  );

async function callApi(context: BrowserContext, method: 'get' | 'post', path: string, data?: object) {
  const response = await context.request[method](`/api/v1${path}`, {
    ...(data === undefined ? {} : { data }),
    headers: { authorization: `Bearer dev:${WHO}`, 'idempotency-key': `dash-${Date.now()}-${Math.random()}` }
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { data: unknown }).data;
}

test('the league opens on its dashboard and the move board updates live', async ({ browser }) => {
  const context = await browser.newContext();
  await signInAs(context, WHO);
  await liveEvents(context);
  const page = await context.newPage();

  await page.goto(`/leagues/${L}`);
  await expect(page).toHaveURL(/\/home$/);
  await expect(
    page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Home' })
  ).toHaveAttribute('aria-current', 'page');

  // Your matchup leads the strip, highlighted; every tile shows both managers.
  const matchups = page.getByRole('region', { name: 'Matchups' });
  await expect(matchups.getByRole('heading', { name: 'Week 1 matchups' })).toBeVisible();
  const yours = matchups.locator('[data-yours="true"]');
  await expect(yours).toHaveCount(1);
  await expect(yours).toContainText(TEAM);
  await expect(yours).toContainText('Your matchup');
  await expect(matchups.getByRole('img', { name: / avatar$/ }).first()).toBeVisible();

  // Standings: your row is marked.
  const standings = page.getByRole('region', { name: 'Standings' });
  await expect(standings.locator('[aria-current="true"]')).toContainText(TEAM);

  // A free agent added, then dropped: each shows up on the board as its event arrives.
  const board = page.getByRole('region', { name: 'Move board' });
  await expect(board).toBeVisible();
  const [agent] = (await callApi(
    context,
    'get',
    `/players?leagueId=${L}&availability=free_agent&limit=1`
  ).then((d) => (d as { players: { id: string; name: string }[] }).players)) as [
    { id: string; name: string }
  ];
  await callApi(context, 'post', `/leagues/${L}/waivers/claims`, { playerId: agent.id });
  await push(page, 'Waivers Processed');
  await expect(
    board.getByRole('article', { name: `Free-agent add: ${TEAM}` }).filter({ hasText: agent.name })
  ).toBeVisible();

  await callApi(context, 'post', `/leagues/${L}/drops`, { playerId: agent.id });
  await push(page, 'Trade Processed');
  // The e2e server's clock is fixed, so the add and the drop share a timestamp and their order on
  // the board is not defined: look for the drop anywhere in the feed.
  await expect(
    board.getByRole('article', { name: `Drop: ${TEAM}` }).filter({ hasText: agent.name })
  ).toBeVisible();

  // A tap on your matchup opens it.
  await yours.click();
  await expect(page).toHaveURL(/\/matchup$/);
  await expect(page.getByRole('region', { name: TEAM })).toBeVisible();

  // My Leagues shows the same dashboard (`/` would go back into the league, #212).
  await page.goto('/leagues');
  await expect(page.getByRole('heading', { level: 2, name: 'Demo Season' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Matchups' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Move board' })).toContainText(agent.name);
  await context.close();
});
