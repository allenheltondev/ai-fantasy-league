import { expect, test } from '@playwright/test';
import { LAMB, researchApi, signIn } from './draftRoom';

/**
 * The draft workspace's recovery and accessibility contracts: tabs work from the keyboard, a
 * collapsed conversation counts only what arrived while it was closed, a queue that fails to save
 * says so and recovers, and research actions on a phone stay below the pick clock.
 */

test.beforeEach(({ page }) => signIn(page));

const message = (id: string, text: string) => ({
  id,
  leagueId: 'L1',
  roomId: 'draft',
  kind: 'agent',
  author: { teamId: 'team-2', teamName: 'The Spreadsheet', name: 'Sheets', avatarSeed: 'sheets' },
  text,
  mentionedTeamIds: [],
  event: null,
  createdAt: new Date().toISOString()
});

test('the main view tabs move with arrow, Home, and End keys and keep focus', async ({ page }) => {
  researchApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/leagues/L1/draft');
  const tabs = page.getByRole('tablist', { name: 'Main view' });
  const players = tabs.getByRole('tab', { name: 'Players' });
  await expect(players).toHaveAttribute('aria-selected', 'true');
  await players.focus();

  const expectOn = async (name: string) => {
    const tab = tabs.getByRole('tab', { name });
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute('tabindex', '0');
  };
  await page.keyboard.press('ArrowRight');
  await expectOn('Research');
  await page.keyboard.press('End');
  await expectOn('Depth');
  await expect(page.getByRole('table', { name: 'Depth chart' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expectOn('Players');
  await page.keyboard.press('ArrowLeft');
  await expectOn('Depth');
  await page.keyboard.press('Home');
  await expectOn('Players');
  await expect(page.getByRole('table', { name: 'Best available' })).toBeVisible();
  // Only the selected tab is in the Tab order.
  await expect(tabs.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
});

test('a collapsed conversation counts only messages that arrive while it is closed', async ({ page }) => {
  const { chat } = researchApi(page);
  chat.push(message('m1', 'Chase is mine next round.'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/leagues/L1/draft');
  const toggle = page.getByRole('button', { name: /^Around the room/ });
  await expect(page.getByText('Chase is mine next round.')).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const chatTab = page.getByRole('tab', { name: 'Chat' });
  await expect(chatTab).toHaveText('Chat');
  await expect(toggle).not.toContainText('new');

  chat.push(message('m2', 'Trade you a third for that pick?'));
  await expect(chatTab).toHaveText('Chat (1)', { timeout: 10_000 });
  await expect(toggle).toContainText('· 1 new');

  await toggle.click();
  await expect(page.getByText('Trade you a third for that pick?')).toBeVisible();
  await expect(chatTab).toHaveText('Chat');
  await expect(toggle).not.toContainText('new');
});

test('on a phone, the chat history it opened with is not counted as unread', async ({ page }) => {
  const { chat } = researchApi(page);
  chat.push(message('m1', 'Chase is mine next round.'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/leagues/L1/draft');
  const chatTab = page.getByRole('tab', { name: 'Chat', exact: true });
  await expect(page.getByRole('table', { name: 'Best available' })).toBeVisible();
  // Let a poll pass with the conversation hidden.
  await page.waitForTimeout(3500);
  await expect(chatTab).toHaveText('Chat');
  chat.push(message('m2', 'Trade you a third for that pick?'));
  await expect(chatTab).toHaveText('Chat (1)', { timeout: 10_000 });
  await chatTab.click();
  await expect(page.getByText('Trade you a third for that pick?')).toBeVisible();
  await expect(chatTab).toHaveText('Chat');
});

test('a queue that cannot be saved says so, and the next good save recovers', async ({ page }) => {
  const { board, queue } = researchApi(page);
  board.bestAvailable.push({ ...board.bestAvailable[0]!, player: LAMB, rank: 2 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/leagues/L1/draft');
  const plan = page.getByTestId('autopick-plan');
  await expect(plan).toContainText('At timeout: autopick chooses an available player');

  queue.failSaves = true;
  await page.getByRole('button', { name: "Queue Ja'Marr Chase", exact: true }).click();
  await expect(plan).toHaveText('Queue changes could not be saved. Autopick uses your last saved queue.');
  // The change stays on screen so it can be retried.
  await expect(page.getByRole('tab', { name: 'Queue' })).toHaveText('Queue (1)');

  queue.failSaves = false;
  await page.getByRole('button', { name: 'Queue CeeDee Lamb', exact: true }).click();
  await expect(plan).toContainText("At timeout: try Ja'Marr Chase if available");
  await expect(page.getByRole('tab', { name: 'Queue' })).toHaveText('Queue (2)');
});

for (const width of [320, 390]) {
  test(`research actions stay below the pick clock while scrolling at ${width}px`, async ({ page }) => {
    researchApi(page);
    await page.setViewportSize({ width, height: 640 });
    await page.goto('/leagues/L1/draft');
    await page
      .getByTestId('available-fx-chase')
      .getByRole('button', { name: "Ja'Marr Chase", exact: true })
      .click();
    const card = page.getByRole('article', { name: "Ja'Marr Chase research" });
    await expect(card).toContainText('288');
    await card.getByText('Weekly production & stat detail').click();
    const clock = page.getByTestId('draft-topbar');
    const actions = card.locator('header').first();

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect
      .poll(async () => {
        const [top, bar] = await Promise.all([actions.boundingBox(), clock.boundingBox()]);
        return top !== null && bar !== null && top.y >= bar.y + bar.height - 1 && top.y < 640;
      })
      .toBe(true);
    await expect(card.getByRole('button', { name: `Remove Ja'Marr Chase from research` })).toBeInViewport();
    await expect(page.getByTestId('pick-clock')).toBeInViewport();
  });
}
