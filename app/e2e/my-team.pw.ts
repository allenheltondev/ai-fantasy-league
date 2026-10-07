import { expect, test, type BrowserContext } from '@playwright/test';
import { handle, signInAs } from './support';

/**
 * The league shell (#178) against the local API server: the side nav beside every league page, My
 * Team's "Edit team" (a new name and avatar that then show across the league), another team from
 * My Team's picker, read-only with "Propose trade" as its only action, and the side nav's items
 * with their pages as tabs.
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

  await nav.getByRole('link', { name: 'My Team' }).click();
  await expect(page).toHaveURL(/\/team\/lineup$/);
  await page.getByRole('button', { name: 'Edit team' }).click();
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
  await page.goto('/leagues/demo-season/team/lineup');
  const picker = page.getByLabel('View team');
  // Yours and the league's three others.
  await expect(picker.getByRole('option')).toHaveCount(4);
  await picker.selectOption('team-2');
  await expect(page).toHaveURL(/\/team\/teams\/team-2$/);
  await expect(page.getByRole('heading', { level: 2, name: 'Team 2' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Team 2 lineup' })).toContainText('Lamar Jackson');
  const view = page.getByTestId('team-view');
  // No roster actions: the only buttons are player names, which open their cards (the team picker
  // is a select).
  await expect(view.locator('button:not([data-player-link])')).toHaveCount(0);
  await view.getByRole('button', { name: 'Lamar Jackson' }).click();
  await expect(page.getByTestId('player-card')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('player-card')).toBeHidden();
  await view.getByRole('link', { name: 'Propose trade' }).click();
  await expect(page).toHaveURL(/\/team\/trades\?with=team-2$/);
  await expect(page.getByRole('region', { name: 'Trade builder' }).getByLabel('Trade with')).toHaveValue(
    'team-2'
  );
  await context.close();
});

test('the side nav lists the league under its name, one item per job', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await signInAs(context, 'season-e2e');
  const page = await context.newPage();
  await page.goto('/leagues/demo-season/team/lineup');
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav.getByRole('link', { name: 'My Team' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.locator('.app-nav-section-title')).toHaveText(['Demo Season']);
  // After the draft, its results live with the league's other pages.
  await expect(nav.getByRole('link', { name: 'Draft', exact: true })).toHaveCount(0);
  // The rail sits beside the page and stays put while it scrolls.
  const rail = await page.locator('.app-nav-side').boundingBox();
  expect(rail?.x ?? -1).toBe(0);
  expect(rail?.height ?? 0).toBeGreaterThanOrEqual(900 - 1);
  // No bar over the page: the bell sits with the rail's actions, and you switch leagues from My Leagues.
  await expect(page.getByRole('combobox', { name: 'League' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'My Leagues' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Notifications/ })).toBeVisible();
  // An item's other pages are tabs over the page.
  await nav.getByRole('link', { name: 'Matchup' }).click();
  await page
    .getByRole('navigation', { name: 'Matchup pages' })
    .getByRole('link', { name: 'Scoreboard' })
    .click();
  await expect(page).toHaveURL(/\/league\/scoreboard$/);
  await expect(nav.getByRole('link', { name: 'Matchup' })).toHaveAttribute('aria-current', 'page');
  for (const name of ['Standings', 'Players']) {
    await expect(nav.getByRole('link', { name })).toBeVisible();
  }
  await expect(nav.getByRole('link', { name: 'Teams' })).toHaveCount(0);
  // The commissioner's last item is Settings, everyone else's League info.
  const info = nav.getByRole('link', { name: /^(Settings|League info)$/ });
  await info.click();
  await page.getByRole('button', { name: 'Draft results' }).click();
  await expect(page).toHaveURL(/\/settings\?view=draft$/);
  await expect(info).toHaveAttribute('aria-current', 'page');
  await context.close();
});
