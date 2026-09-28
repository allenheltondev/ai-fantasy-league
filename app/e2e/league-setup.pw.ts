import { expect, test } from '@playwright/test';
import { handle, signInAs } from './support';

test('create a league with defaults, tune the AI managers, and invite a second person', async ({
  browser
}) => {
  const alice = handle('alice');
  const bob = handle('bob');
  const commissioner = await browser.newContext();
  await signInAs(commissioner, alice);
  const page = await commissioner.newPage();

  // The wizard: Next through every step with the defaults.
  await page.goto('/leagues/new');
  await expect(page.getByLabel('League name')).toHaveValue(`${alice}'s League`);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByTestId('seat-split')).toHaveText('1 human, 7 AI');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByTestId('agent-card')).toHaveCount(7);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByTestId('review')).toContainText('Half-PPR');
  await page.getByRole('button', { name: 'Create league' }).click();
  await expect(page).toHaveURL(/\/leagues\/[^/]+\/settings$/);
  const settingsUrl = page.url();

  // Randomize every AI seat, then make one of them a Hall of Famer.
  const cards = page.getByTestId('agent-card');
  await expect(cards).toHaveCount(7);
  await page.getByRole('button', { name: 'Randomize all' }).click();
  await expect(page.getByText('AI managers randomized.')).toBeVisible();
  await expect(cards).toHaveCount(7);
  const first = cards.first();
  // Controls stay disabled until the randomized seats have reloaded.
  await expect(first.getByLabel('Difficulty', { exact: true })).toBeEnabled();
  const target =
    (await first.getByTestId('difficulty-pill').innerText()) === 'Hall of Famer' ? 'rookie' : 'hall_of_famer';
  const label = target === 'rookie' ? 'Rookie' : 'Hall of Famer';
  await first.getByLabel('Difficulty', { exact: true }).selectOption(target);
  await expect(first.getByTestId('difficulty-pill')).toHaveText(label);
  await page.reload();
  await expect(page.getByTestId('agent-card').first().getByTestId('difficulty-pill')).toHaveText(label);

  // An invite link for a second person.
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const link = await page.getByLabel('Invite link').inputValue();
  expect(link).toMatch(/\/join\/.+/);
  await expect(page.getByRole('list', { name: 'Invites' })).toContainText('Active');

  const friend = await browser.newContext();
  await signInAs(friend, bob);
  const bobPage = await friend.newPage();
  await bobPage.goto(new URL(link).pathname);
  await expect(bobPage.getByRole('heading', { name: `${alice}'s League` })).toBeVisible();
  await bobPage.getByLabel('Team name (optional)').fill('Bobcats');
  await bobPage.getByRole('button', { name: 'Join league' }).click();
  await expect(bobPage).toHaveURL(settingsUrl);
  await expect(bobPage.getByTestId('seat-team-2')).toContainText('Bobcats');
  await expect(bobPage.getByText(/Only the commissioner can change the rules/)).toBeVisible();

  // The commissioner sees the new member, and the invite is used.
  await page.reload();
  await expect(page.getByTestId('seat-team-2')).toContainText(bob);
  await expect(page.getByTestId('agent-card')).toHaveCount(6);
  await expect(page.getByRole('list', { name: 'Invites' })).toContainText('Used');

  await friend.close();
  await commissioner.close();
});
