import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support';

/**
 * #212 against the local API server, in the seeded in-season league (`demo-season`, dev user
 * local-season-e2e): the tab names the page, each page has one h1, and `/` goes back into the
 * league you last opened while My Leagues stays a list.
 */

const LEAGUE = 'Demo Season';

async function expectOneH1(page: Page, name: string) {
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
}

test.beforeEach(async ({ page, context }) => {
  await page.clock.setSystemTime(new Date('2026-09-10T12:00:00Z'));
  await signInAs(context, 'season-e2e');
});

test('the tab title and the one h1 follow you around a league', async ({ page }) => {
  await page.goto('/leagues/demo-season/home');
  await expect(page).toHaveTitle(`Home · ${LEAGUE} · AI Fantasy Football`);
  await expectOneH1(page, 'Home');
  // The side nav names the league, so nothing on the page repeats it as a heading.
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav.locator('.app-nav-section-title')).toHaveText([LEAGUE]);
  await expect(page.getByRole('heading', { name: LEAGUE })).toHaveCount(0);

  await nav.getByRole('link', { name: 'Chat' }).click();
  await expect(page).toHaveTitle(`Chat · ${LEAGUE} · AI Fantasy Football`);
  await expectOneH1(page, 'Chat');

  await nav.getByRole('link', { name: 'Matchup' }).click();
  await expect(page).toHaveTitle(`Matchup · ${LEAGUE} · AI Fantasy Football`);
  await expectOneH1(page, 'Matchup');
  // The matchup header's teams stay: they are what the page is about.
  await expect(page.getByRole('region', { name: "season-e2e's Team" })).toBeVisible();

  await page.goto('/leagues/demo-season/team/teams/team-2');
  await expect(page).toHaveTitle(`Team 2 · ${LEAGUE} · AI Fantasy Football`);
  await expectOneH1(page, 'My Team');
  await expect(page.getByRole('heading', { level: 2, name: 'Team 2' })).toBeVisible();

  await nav.getByRole('link', { name: 'My Leagues' }).click();
  await expect(page).toHaveURL(/\/leagues$/);
  await expect(page).toHaveTitle('My Leagues · AI Fantasy Football');
  await expectOneH1(page, 'My Leagues');
  await expect(page.getByRole('heading', { level: 1, name: 'My Leagues' })).toBeVisible();
});

test('/ goes back into the league you opened last; My Leagues stays the list', async ({ page }) => {
  await page.goto('/leagues/demo-season/team/lineup');
  await expect(page.getByTestId('league-section-roster')).toBeVisible();

  await page.goto('/');
  await expect(page).toHaveURL(/\/leagues\/demo-season\/home$/);
  await expect(page.getByTestId('league-section-home')).toBeVisible();

  // The side nav's My Leagues is a real list, not a bounce back into the league.
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'My Leagues' })
    .click();
  await expect(page).toHaveURL(/\/leagues$/);
  await expect(page.getByRole('list', { name: 'Leagues' })).toBeVisible();

  // A league you're no longer in is forgotten, and / shows My Leagues.
  await page.evaluate(() => localStorage.setItem('aff:lastLeagueId', 'no-such-league'));
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Leagues' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(() => localStorage.getItem('aff:lastLeagueId'))).toBeNull();
});
