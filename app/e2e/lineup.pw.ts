import { expect, test } from '@playwright/test';
import { signInAs } from './support';

/**
 * Setting a lineup against the local API server. The server seeds `demo-season` (an in-season
 * league, FANTASY_LOCAL_SEASON_DEMO in playwright.config.ts) for dev user local-season-e2e, and
 * its clock is pinned before week 1 kicks off, so nobody is locked yet. The test swaps its
 * quarterbacks, checks the lineup stuck, and swaps back so a reused server starts clean.
 */
test('a manager swaps a bench player into the lineup and sees it saved', async ({ browser }) => {
  const context = await browser.newContext();
  await signInAs(context, 'season-e2e');
  const page = await context.newPage();

  await page.goto('/leagues/demo-season/roster');
  const starters = page.getByRole('table', { name: 'Starters' });
  const bench = page.getByRole('table', { name: 'Bench' });
  await expect(starters.getByText('Josh Allen')).toBeVisible();
  await expect(bench.getByText('Patrick Mahomes')).toBeVisible();
  // Kenneth Walker III's Seahawks are on bye in week 1.
  await expect(page.getByTestId('roster-row-fx-kwalker').getByText('Bye', { exact: true })).toBeVisible();

  // Starting Mahomes at QB benches Allen: the editor sends both moves to set_lineup.
  await page.getByRole('combobox', { name: 'Move Patrick Mahomes' }).selectOption('QB');
  await expect(starters.getByText('Patrick Mahomes')).toBeVisible();
  await expect(bench.getByText('Josh Allen')).toBeVisible();

  await page.reload();
  await expect(starters.getByText('Patrick Mahomes')).toBeVisible();

  // Both lineups show on the matchup page.
  await page.getByRole('link', { name: 'Matchup' }).click();
  await expect(page.getByRole('region', { name: "season-e2e's Team" })).toContainText('Patrick Mahomes');

  // Put Allen back for the next run.
  await page.getByRole('link', { name: 'Roster' }).click();
  await page.getByRole('combobox', { name: 'Move Josh Allen' }).selectOption('QB');
  await expect(starters.getByText('Josh Allen')).toBeVisible();
  await context.close();
});
