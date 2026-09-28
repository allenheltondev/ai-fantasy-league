import { expect, test } from '@playwright/test';
import { handle, signInAs } from './support';

// AI managers have names and avatars (#159): randomized, editable, and saved with the seat.
test('randomize the AI managers, rename one, and see the name after saving', async ({ browser }) => {
  const alice = handle('alice');
  const context = await browser.newContext();
  await signInAs(context, alice);
  const page = await context.newPage();

  await page.goto('/leagues/new');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  const cards = page.getByTestId('agent-card');
  await expect(cards).toHaveCount(7);

  // Randomize gives every card a new manager name; the personality moves to the subtitle.
  const before = await cards.first().getByRole('heading').innerText();
  await page.getByRole('button', { name: 'Randomize all' }).click();
  await expect(cards.first().getByRole('heading')).not.toHaveText(before);
  const names = await cards.getByRole('heading').allInnerTexts();
  expect(new Set(names).size).toBe(7);
  await expect(cards.first().getByTestId('personality-title')).toBeVisible();

  // Rename the first manager inline.
  const first = cards.first();
  await first.getByRole('button', { name: /^Rename / }).click();
  await first.getByLabel('Manager name').fill('Zelda "Waivers" Quinn');
  await first.getByRole('button', { name: 'Save name' }).click();
  await expect(first.getByRole('heading', { name: 'Zelda "Waivers" Quinn' })).toBeVisible();

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByTestId('review')).toContainText('Zelda "Waivers" Quinn');
  await page.getByRole('button', { name: 'Create league' }).click();
  await expect(page).toHaveURL(/\/leagues\/[^/]+\/settings$/);

  // Saved: the settings cards load the name back from the API, and it survives a reload.
  await expect(page.getByTestId('agent-card').first().getByRole('heading')).toHaveText(
    'Zelda "Waivers" Quinn'
  );

  // Rename again from settings, then reroll another manager's name and avatar.
  const card = page.getByTestId('agent-card').first();
  await card.getByRole('button', { name: /^Rename / }).click();
  await card.getByLabel('Manager name').fill('Imani Castillo');
  await card.getByLabel('Manager name').press('Enter');
  await expect(card.getByRole('heading')).toHaveText('Imani Castillo');
  const second = page.getByTestId('agent-card').nth(1);
  const secondName = await second.getByRole('heading').innerText();
  await second.getByRole('button', { name: `Reroll name for ${secondName}` }).click();
  await expect(second.getByRole('heading')).not.toHaveText(secondName);
  await page.reload();
  await expect(page.getByTestId('agent-card').first().getByRole('heading')).toHaveText('Imani Castillo');
  await expect(page.getByTestId('agent-card').nth(1).getByRole('heading')).not.toHaveText(secondName);

  // Everyone in the league sees the managers by name: the chat's @mention list offers it.
  const leagueId = new URL(page.url()).pathname.split('/')[2] as string;
  await page.goto(`/leagues/${leagueId}/chat`);
  const composer = page.getByRole('combobox', { name: 'Message' });
  await composer.pressSequentially('@Imani');
  await expect(page.getByRole('option', { name: /Imani Castillo/ })).toBeVisible();

  await context.close();
});
