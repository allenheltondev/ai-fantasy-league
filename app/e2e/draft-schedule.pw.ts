import { expect, test } from '@playwright/test';
import { handle, signInAs } from './support';

/**
 * Against the local API (its clock is pinned to 2026-09-10T12:00Z): the commissioner schedules the
 * draft in the settings (a local date and time, stored as UTC), and the draft room is a lobby
 * counting down to it, with the AI seats already there.
 */
test('the commissioner schedules the draft, and the draft room counts down to it', async ({ browser }) => {
  const alice = handle('sched');
  const context = await browser.newContext();
  await signInAs(context, alice);
  const page = await context.newPage();

  await page.goto('/leagues/new');
  for (let step = 0; step < 3; step++) await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Create league' }).click();
  await expect(page).toHaveURL(/\/leagues\/[^/]+\/settings$/);
  const leagueUrl = page.url().replace(/\/settings$/, '');

  const schedule = page.getByTestId('draft-schedule');
  await expect(schedule.getByRole('button', { name: 'Save draft time' })).toBeDisabled();
  // Ten days after the server's pinned clock, in this browser's time zone.
  await schedule.getByLabel(/^Draft starts \(/).fill('2026-09-20T12:00');
  await schedule.getByLabel('Draft order').selectOption('random');
  await schedule.getByRole('button', { name: 'Save draft time' }).click();
  await expect(page.getByText('Draft scheduled.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('draft-schedule').getByLabel(/^Draft starts \(/)).toHaveValue(
    '2026-09-20T12:00'
  );
  await expect(page.getByTestId('draft-schedule').getByLabel('Draft order')).toHaveValue('random');

  await page.goto(`${new URL(leagueUrl).pathname}/draft`);
  const lobby = page.getByTestId('draft-lobby');
  await expect(lobby.getByTestId('draft-countdown')).toHaveText(/^\d+d \d\d:\d\d:\d\d$/);
  await expect(lobby.getByText('The order is shuffled when the draft starts.')).toBeVisible();
  await expect(lobby.getByText("Who's here (8 of 8)")).toBeVisible();
  await expect(lobby.getByRole('button', { name: 'Start now' })).toBeVisible();

  // Queue a player from the lobby; the queue is saved on the server.
  await lobby
    .getByRole('button', { name: /^Queue / })
    .first()
    .click();
  await expect(lobby.getByRole('list', { name: 'Your queue' }).getByRole('listitem')).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId('draft-lobby').getByRole('list', { name: 'Your queue' })).toBeVisible();

  // Start now: the lobby turns into the live board.
  await page.getByRole('button', { name: 'Start now' }).click();
  await expect(page.getByTestId('pick-clock')).toBeVisible();
  await expect(page.getByTestId('draft-lobby')).toHaveCount(0);
  await context.close();
});
