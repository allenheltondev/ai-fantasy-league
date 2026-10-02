import { expect, test } from '@playwright/test';
import { CHASE, LAMB, researchApi, signIn } from './draftRoom';

/**
 * Draft research (#136): open a player card from Best available, queue him from the card, then
 * view the depth chart. The API is a stand-in served with `page.route`; the SPA runs for real.
 */

test.beforeEach(({ page }) => signIn(page));

test('open a player card from best available, queue him, then view depth', async ({ page }) => {
  researchApi(page);
  await page.goto('/leagues/L1/draft');
  await page.getByRole('button', { name: 'Research', exact: true }).click();
  const row = page.getByTestId('available-fx-chase');
  await expect(row).toContainText('17.7');
  await expect(row).toContainText('288');

  await row.getByRole('button', { name: "Ja'Marr Chase", exact: true }).click();
  const card = page.getByRole('article', { name: "Ja'Marr Chase research" });
  await expect(card).toContainText('17.7 · 17 games');
  await card.getByText('Weekly production & stat detail').click();
  await expect(card.getByTestId('weekly-points').first()).toBeVisible();
  await expect(card).toContainText('Bye 10');
  await expect(card.getByRole('link', { name: 'Chase full go at practice' })).toBeVisible();
  await card.getByRole('button', { name: '＋ Queue', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Queued ✓' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tab', { name: 'Queue' })).toHaveText('Queue (1)');
  await page.getByRole('tab', { name: 'Queue' }).click();
  await expect(page.getByRole('list', { name: 'Your queue' })).toContainText("1.WRJa'Marr Chase");

  await page.getByRole('tab', { name: 'Depth' }).click();
  const chart = page.getByRole('table', { name: 'Depth chart' });
  await expect(chart.getByRole('row').nth(1)).toContainText("Allen's Team");
  await expect(page.getByTestId('depth-team-2-RB')).toContainText('RB 1/2');
  await expect(page.getByTestId('depth-team-2-RB')).toContainText('Christian McCaffrey');
  await expect(page.getByTestId('depth-team-2')).toContainText('1 pick before you');
  await expect(page.getByTestId('depth-team-1-QB')).toHaveAttribute('data-gap', 'true');
});

test('research survives a rival pick, keeps a fallback ready, and composes a shared comparison', async ({
  page
}, testInfo) => {
  const { board } = researchApi(page);
  board.bestAvailable.push({ ...board.bestAvailable[0]!, player: LAMB, rank: 2 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/leagues/L1/draft');
  await page.getByRole('button', { name: "Queue Ja'Marr Chase", exact: true }).click();
  await page.getByRole('button', { name: 'Queue CeeDee Lamb', exact: true }).click();
  await page.getByRole('button', { name: "Compare Ja'Marr Chase", exact: true }).click();
  await page.getByRole('button', { name: 'Compare CeeDee Lamb', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('desktop-players.png') });
  await page.getByRole('button', { name: 'Compare 2 / 3 players' }).click();
  const chase = page.getByRole('article', { name: "Ja'Marr Chase research" });
  const lamb = page.getByRole('article', { name: 'CeeDee Lamb research' });
  await expect(chase).toContainText('288');
  await expect(lamb).toContainText('274');
  await chase.getByText('Private notes', { exact: true }).click();
  await chase.getByLabel("Notes for Ja'Marr Chase").fill('Watch the injury report before my pick.');
  await page
    .locator('#draft-center > div')
    .nth(1)
    .evaluate((element) => (element.scrollTop = 0));
  await page.screenshot({ path: testInfo.outputPath('desktop-research.png') });
  board.picks.push({
    overall: 2,
    round: 1,
    pick: 2,
    teamId: 'team-2',
    player: CHASE,
    auto: false,
    madeAt: null
  });
  board.bestAvailable = board.bestAvailable.filter((p) => p.player.id !== CHASE.id);
  board.onTheClock = {
    ...board.onTheClock,
    overall: 3,
    round: 2,
    pick: 1,
    teamId: 'team-1',
    teamName: "Allen's Team"
  };
  board.yourNextPick = { overall: 3, round: 2, pick: 1, picksAway: 0 };
  await expect(chase).toContainText('Drafted · research kept for reference', { timeout: 10000 });
  await expect(chase.getByLabel("Notes for Ja'Marr Chase")).toHaveValue(
    'Watch the injury report before my pick.'
  );
  await expect(lamb.getByRole('button', { name: 'Draft CeeDee Lamb' })).toBeEnabled();
  await expect(page.getByTestId('autopick-plan')).toContainText('try CeeDee Lamb');
  await page.getByRole('button', { name: 'Discuss in chat' }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
    "Who would you take: Ja'Marr Chase or CeeDee Lamb?"
  );
  await expect(page.getByRole('table', { name: 'Best available' })).toBeHidden();
  await page.getByRole('tab', { name: 'Players', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Compare CeeDee Lamb', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});

for (const width of [320, 390, 768, 1024]) {
  test(`draft research and navigation remain usable at ${width}px`, async ({ page }, testInfo) => {
    researchApi(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/leagues/L1/draft');
    await expect(page.getByRole('table', { name: 'Best available' })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page
      .getByTestId('available-fx-chase')
      .getByRole('button', { name: "Ja'Marr Chase", exact: true })
      .click();
    await expect(page.getByRole('article')).toContainText('288');
    await expect(page.getByTestId('pick-clock')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`research-${width}.png`) });
    if (width < 1024) {
      await page.getByRole('tab', { name: 'Chat', exact: true }).click();
      await page.getByLabel('Message', { exact: true }).fill('My draft-day hot take');
      await page.getByRole('tab', { name: 'Queue', exact: true }).click();
      await page.getByRole('tab', { name: 'Chat', exact: true }).click();
      await expect(page.getByLabel('Message', { exact: true })).toHaveValue('My draft-day hot take');
    }
  });
}
