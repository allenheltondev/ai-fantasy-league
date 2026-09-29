import { expect, test } from '@playwright/test';
import { signInAs } from './support';

/**
 * League › Playoffs and History (#178; they were tabs of Standings) against the local API server's
 * `demo-season` league (in week 1): the bracket is projected from the standings as they are, and
 * the history is empty until games are final.
 */
test('a manager checks the projected playoff bracket and the league history', async ({ browser }) => {
  const context = await browser.newContext();
  await signInAs(context, 'season-e2e');
  const page = await context.newPage();

  // The old Standings URL still lands there.
  await page.goto('/leagues/demo-season/standings');
  await expect(page).toHaveURL(/\/league\/standings$/);
  const pages = page.getByRole('navigation', { name: 'League pages' });
  await pages.getByRole('link', { name: 'Playoffs' }).click();
  await expect(page).toHaveURL(/\/league\/playoffs$/);
  await expect(page.getByText(/Projected: the bracket if the regular season ended today\./)).toBeVisible();
  const bracket = page.getByRole('region', { name: 'Championship bracket' });
  await expect(bracket.getByText('Week 16')).toBeVisible();
  await expect(bracket.getByText(/^Winner of championship-r1-g/).first()).toBeVisible();

  await pages.getByRole('link', { name: 'History' }).click();
  await expect(page.getByText('No completed seasons yet.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Head to head' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Best and worst trades' })).toBeVisible();
  await expect(page.getByText("No trade has changed a team's value yet.")).toBeVisible();

  await pages.getByRole('link', { name: 'Standings' }).click();
  await expect(page.getByRole('table', { name: 'Standings' })).toBeVisible();

  // So does an old link to one of its tabs.
  await page.goto('/leagues/demo-season/standings?view=history');
  await expect(page).toHaveURL(/\/league\/history$/);
  await expect(page.getByText('No completed seasons yet.')).toBeVisible();
  await context.close();
});
