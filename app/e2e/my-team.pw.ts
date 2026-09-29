import { expect, test, type BrowserContext } from '@playwright/test';
import { handle, signInAs } from './support';

/**
 * The league shell (#178) against the local API server: the side nav beside every league page, My
 * Team's profile (a new name and avatar that then show across the league), another team read-only
 * with "Propose trade" as its only action, and the quiet header bar with the league switcher.
 */

async function createLeague(context: BrowserContext, who: string): Promise<string> {
  const response = await context.request.post('/api/v1/leagues', {
    data: { name: 'Profile League', teamCount: 4, preset: 'full_ppr' },
    headers: {
      authorization: `Bearer dev:${who}`,
      'idempotency-key': `myteam-${Date.now()}-${Math.random()}`
    }
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { data: { id: string } }).data.id;
}

test('a manager renames the team and picks an avatar that shows across the league', async ({ browser }) => {
  const who = handle('myteam');
  const context = await browser.newContext();
  await signInAs(context, who);
  const leagueId = await createLeague(context, who);
  const page = await context.newPage();

  await page.goto(`/leagues/${leagueId}`);
  await expect(page).toHaveURL(/\/home$/);
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  // Before the draft it has its own place in the nav.
  await expect(nav.getByRole('link', { name: 'Draft' })).toBeVisible();

  await nav.getByRole('link', { name: 'Team profile' }).click();
  await expect(page).toHaveURL(/\/team\/profile$/);
  await page.getByLabel('Team name').fill('Gridiron Gang');
  await page.getByRole('button', { name: 'New avatar' }).click();
  await expect(page.getByRole('img', { name: 'Gridiron Gang avatar' })).toBeVisible();
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Team profile saved.')).toBeVisible();

  // The draft lobby shows the new name, with the avatar beside the person playing it.
  await nav.getByRole('link', { name: 'Draft' }).click();
  const here = page
    .getByRole('list', { name: "Who's here" })
    .getByRole('listitem')
    .filter({ hasText: 'Gridiron Gang' });
  await expect(here.getByRole('img', { name: `${who} avatar` })).toBeVisible();
  await context.close();
});

test('another team is read-only, with Propose trade as its only action', async ({ browser }) => {
  const context = await browser.newContext();
  await signInAs(context, 'season-e2e');
  const page = await context.newPage();
  await page.goto('/leagues/demo-season/team/teams');
  const teams = page.getByRole('list', { name: 'Teams' });
  await expect(teams.getByRole('link')).toHaveCount(3);
  await teams.getByRole('link', { name: /Team 2/ }).click();
  await expect(page).toHaveURL(/\/team\/teams\/team-2$/);
  await expect(page.getByRole('heading', { level: 2, name: 'Team 2' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Team 2 lineup' })).toContainText('Lamar Jackson');
  const view = page.getByTestId('team-view');
  await expect(view.getByRole('button')).toHaveCount(0);
  await view.getByRole('link', { name: 'Propose trade' }).click();
  await expect(page).toHaveURL(/\/team\/trades\?with=team-2$/);
  await expect(page.getByRole('region', { name: 'Trade builder' }).getByLabel('Trade with')).toHaveValue(
    'team-2'
  );
  await context.close();
});

test('the side nav groups the league under a quiet header bar', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await signInAs(context, 'season-e2e');
  const page = await context.newPage();
  await page.goto('/leagues/demo-season/team/lineup');
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav.getByRole('link', { name: 'Lineup' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.locator('.app-nav-section-title')).toHaveText(['League', 'My Team']);
  // After the draft, its results live with the league's other pages.
  await expect(nav.getByRole('link', { name: 'Draft', exact: true })).toHaveCount(0);
  // The rail sits beside the page and stays put while it scrolls.
  const rail = await page.locator('.app-nav-side').boundingBox();
  expect(rail?.x ?? -1).toBe(0);
  expect(rail?.height ?? 0).toBeGreaterThanOrEqual(900 - 1);
  // The header bar holds the league switcher and the bell; the sections are only in the side nav.
  await expect(page.getByLabel('League')).toHaveValue('demo-season');
  await expect(page.getByRole('button', { name: /^Notifications/ })).toBeVisible();
  await nav.getByRole('link', { name: 'Scoreboard' }).click();
  await expect(page).toHaveURL(/\/league\/scoreboard$/);
  await page
    .getByRole('navigation', { name: 'League pages' })
    .getByRole('link', { name: 'Draft results' })
    .click();
  await expect(page).toHaveURL(/\/league\/draft$/);
  await expect(nav.getByRole('link', { name: 'Scoreboard' })).toHaveAttribute('aria-current', 'page');
  await context.close();
});
