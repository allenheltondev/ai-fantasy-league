import { expect, test } from '@playwright/test';
import { signInAs } from './support';

/**
 * The Playoffs and History tabs of the Standings section against the local API server's
 * `demo-season` league (in week 1): the bracket is projected from the standings as they are, and
 * the history is empty until games are final.
 */
test('a manager checks the projected playoff bracket and the league history', async ({ browser }) => {
  const context = await browser.newContext();
  await signInAs(context, 'season-e2e');
  const page = await context.newPage();

  await page.goto('/leagues/demo-season/standings');
  await page.getByRole('tab', { name: 'Playoffs' }).click();
  await expect(page).toHaveURL(/view=playoffs/);
  await expect(page.getByText(/Projected: the bracket if the regular season ended today\./)).toBeVisible();
  const bracket = page.getByRole('region', { name: 'Championship bracket' });
  await expect(bracket.getByText('Week 16')).toBeVisible();
  await expect(bracket.getByText(/^Winner of championship-r1-g/).first()).toBeVisible();

  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByText('No completed seasons yet.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Head to head' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Best and worst trades' })).toBeVisible();
  await expect(page.getByText("No trade has changed a team's value yet.")).toBeVisible();

  await page.getByRole('tab', { name: 'Standings' }).click();
  await expect(page.getByRole('table', { name: 'Standings' })).toBeVisible();
  await context.close();
});
