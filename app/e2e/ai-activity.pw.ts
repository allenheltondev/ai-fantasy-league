import { expect, test } from '@playwright/test';
import { signInAs } from './support';

/**
 * Agent customization views against the local API server's `demo-season` league (see
 * lineup.pw.ts): its three agent seats each play a different model family. Members see which
 * model is winning under the standings; the commissioner reviews the agents in Settings → AI
 * activity (spend against budget, the kill switch, and the decision log).
 */
test('the commissioner compares models and reviews AI activity', async ({ browser }) => {
  const context = await browser.newContext();
  await signInAs(context, 'season-e2e');
  const page = await context.newPage();

  await page.goto('/leagues/demo-season/standings');
  await expect(page.getByRole('heading', { name: 'Which model wins the league?' })).toBeVisible();
  const models = page.getByRole('table', { name: 'Model power rankings' });
  await expect(models.getByText('Claude Opus 5')).toBeVisible();
  await expect(models.getByText('Human')).toBeVisible();
  await expect(models.getByRole('columnheader', { name: 'Trade value' })).toBeVisible();
  await expect(models.getByRole('columnheader', { name: 'Waiver hits' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI activity' }).click();
  const panel = page.getByTestId('ai-activity');
  await expect(panel.getByText('Kill switch')).toBeVisible();
  await expect(panel.getByText('Not set up')).toBeVisible();
  const spend = panel.getByRole('table', { name: 'Spend by agent' });
  await expect(spend.getByRole('row')).toHaveCount(4);
  await expect(panel.getByRole('heading', { name: 'Decision log' })).toBeVisible();

  // Each agent seat's saved versions, the current one marked.
  const history = page.getByRole('table', { name: 'Seat version history' });
  await expect(history.getByText('Current')).toBeVisible();
  await expect(history.getByText('First version')).toBeVisible();
  const seatPicker = page.getByLabel('Agent seat');
  const seats = await seatPicker.locator('option').count();
  expect(seats).toBe(3);
  await seatPicker.selectOption({ index: 2 });
  await expect(history.getByText('Current')).toBeVisible();

  await page.getByRole('button', { name: 'League settings' }).click();
  await expect(page.getByRole('heading', { name: 'Seats' })).toBeVisible();
  await context.close();
});
