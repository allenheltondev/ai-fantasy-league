import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs } from './support';

/**
 * Setting a lineup against the local API server (#176). The server seeds `demo-season` (an
 * in-season league, FANTASY_LOCAL_SEASON_DEMO in playwright.config.ts) for dev user
 * local-season-e2e, with week-1 projections, and its clock is pinned before week 1 kicks off, so
 * nobody is locked yet. Each test puts the seeded lineup back, so a reused server starts clean.
 */

/** The seeded team-1 lineup (src/dev/season-demo.ts), as set_lineup moves. */
const SEEDED = [
  ['fx-jallen', 'QB'],
  ['fx-cmc', 'RB'],
  ['fx-bijan', 'RB'],
  ['fx-chase', 'WR'],
  ['fx-jjefferson', 'WR'],
  ['fx-arsb', 'WR'],
  ['fx-kelce', 'W/R/T'],
  ['fx-butker', 'K'],
  ['fx-def-sf', 'DEF'],
  ['fx-mahomes', 'BN'],
  ['fx-bhall', 'BN'],
  ['fx-lamb', 'BN'],
  ['fx-kwalker', 'BN']
].map(([playerId, slot]) => ({ playerId, slot }));

async function restoreLineup(page: Page, moves = SEEDED) {
  const status = await page.evaluate(async (moves) => {
    const res = await fetch('/api/v1/leagues/demo-season/teams/team-1/lineup', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ moves })
    });
    return res.status;
  }, moves);
  expect(status).toBe(200);
}

/** Drags with the mouse in small steps, as a person would, so the drag sensor engages. */
async function drag(page: Page, from: Locator, to: Locator) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (a === null || b === null) throw new Error('drag: element not visible');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

test.beforeEach(async ({ page, context }) => {
  await signInAs(context, 'season-e2e');
  await page.goto('/leagues/demo-season/roster');
  await restoreLineup(page);
  await page.reload();
});

test('a manager drags a bench player into the lineup, sees the projection change, and saves', async ({
  page
}) => {
  const starters = page.getByRole('list', { name: 'Starters' });
  const bench = page.getByRole('list', { name: 'Bench' });
  await expect(starters.getByText('Josh Allen')).toBeVisible();
  await expect(bench.getByText('Patrick Mahomes')).toBeVisible();
  // Projections under league scoring, with the opponent; Walker's Seahawks are on bye.
  await expect(page.getByTestId('roster-row-fx-jallen').getByTestId('game-line')).toContainText('vs MIA');
  await expect(page.getByTestId('roster-row-fx-jallen').getByTestId('player-projection')).not.toHaveText(/–/);
  await expect(page.getByTestId('roster-row-fx-kwalker').getByText('Bye', { exact: true })).toBeVisible();
  const total = page.getByTestId('lineup-projection');
  await expect(total).toContainText('Saved');

  // While Mahomes is picked up, the QB slot lights up and the RB slots dim.
  const mahomes = page.getByRole('button', { name: 'Patrick Mahomes, BN' });
  const allenRow = page.getByTestId('roster-row-fx-jallen');
  const box = await mahomes.boundingBox();
  await page.mouse.move((box?.x ?? 0) + 20, (box?.y ?? 0) + 20);
  await page.mouse.down();
  await page.mouse.move((box?.x ?? 0) + 40, (box?.y ?? 0) + 40, { steps: 4 });
  await expect(allenRow).toHaveAttribute('data-target', 'valid');
  await expect(page.getByTestId('roster-row-fx-cmc')).toHaveAttribute('data-target', 'invalid');
  await page.mouse.up();

  await drag(page, mahomes, allenRow);
  await expect(starters.getByText('Patrick Mahomes')).toBeVisible();
  await expect(bench.getByText('Josh Allen')).toBeVisible();
  const pending = page.getByRole('region', { name: 'Unsaved changes' });
  await expect(pending).toContainText('2 unsaved changes');
  await expect(pending).toContainText('Patrick Mahomes BN → QB');
  await expect(page.getByTestId('lineup-projection-delta')).toBeVisible();

  await pending.getByRole('button', { name: 'Save lineup' }).click();
  await expect(pending).toBeHidden();
  await expect(total).toContainText('Saved');
  await page.reload();
  await expect(starters.getByText('Patrick Mahomes')).toBeVisible();

  // Both lineups show on the matchup page, with the outlook's win probability.
  await page.getByRole('link', { name: 'Matchup' }).click();
  await expect(page.getByTestId('h2h-row-QB-0')).toContainText('Patrick Mahomes');
  await expect(page.getByRole('region', { name: "season-e2e's Team" }).getByTestId(/^score-/)).toBeVisible();
  await expect(page.getByTestId('win-probability')).toContainText('to win');

  await restoreLineup(page);
});

test('a manager optimizes the lineup, reviews the diff, and saves it', async ({ page }) => {
  const optimize = page.getByRole('button', { name: /^Optimize lineup \(\+/ });
  await expect(optimize).toBeEnabled();
  await optimize.click();
  const pending = page.getByRole('region', { name: 'Unsaved changes' });
  // Lamb projects above St. Brown, Hall fills the flex, and Kelce moves into the empty TE slot.
  await expect(pending).toContainText('CeeDee Lamb BN → WR');
  await expect(pending).toContainText('Amon-Ra St. Brown WR → BN');
  await expect(pending).toContainText('Travis Kelce W/R/T → TE');
  await expect(page.getByRole('button', { name: 'Optimize lineup' })).toBeDisabled();

  await pending.getByRole('button', { name: 'Save lineup' }).click();
  await expect(pending).toBeHidden();
  await page.reload();
  await expect(page.getByRole('list', { name: 'Starters' }).getByText('CeeDee Lamb')).toBeVisible();
  await expect(page.getByText('Your lineup is the best projected one.')).toBeVisible();

  await restoreLineup(page);
});

test('a manager moves players from the keyboard and discards the change', async ({ page }) => {
  await page.getByRole('button', { name: 'Josh Allen, QB' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('moving-banner')).toContainText('Moving Josh Allen');
  await page
    .getByRole('button', { name: 'Move Josh Allen to the bench, swapping with Patrick Mahomes' })
    .focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('list', { name: 'Starters' }).getByText('Patrick Mahomes')).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('list', { name: 'Starters' }).getByText('Josh Allen')).toBeVisible();
});

test('a manager whose whole team is on the bench sets a lineup with one tap', async ({ page }) => {
  // As right after a draft: everyone on the bench.
  await restoreLineup(
    page,
    SEEDED.map((m) => ({ ...m, slot: 'BN' }))
  );
  await page.reload();
  const callout = page.getByRole('region', { name: 'Your lineup is empty' });
  await expect(callout).toBeVisible();
  await callout.getByRole('button', { name: 'Set my lineup' }).click();
  await expect(callout).toBeHidden();
  const starters = page.getByRole('list', { name: 'Starters' });
  await expect(starters.getByText('Josh Allen')).toBeVisible();
  await expect(starters.getByText('CeeDee Lamb')).toBeVisible();
  await expect(page.getByTestId('lineup-projection')).toContainText('Saved');

  await restoreLineup(page);
});
