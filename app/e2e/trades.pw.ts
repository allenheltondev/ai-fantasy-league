import { expect, test } from '@playwright/test';
import { signInAs } from './support';

/**
 * Proposing a trade against the local API server's in-season demo league (`demo-season`, for dev
 * user local-season-e2e; see lineup.pw.ts). The manager picks team-2, offers Patrick Mahomes for
 * Lamar Jackson, reads the live preview, proposes, sees the offer in Sent offers, and withdraws it
 * so a reused server starts clean. Rosters never change: the offer is never accepted.
 */
test('a manager previews and proposes a trade, then withdraws it', async ({ browser }) => {
  const context = await browser.newContext();
  await signInAs(context, 'season-e2e');
  const page = await context.newPage();

  await page.goto('/leagues/demo-season/trades');
  const builder = page.getByRole('region', { name: 'Trade builder' });
  await builder.getByLabel('Trade with').selectOption('team-2');
  await builder.getByLabel('You send: Patrick Mahomes').check();
  await builder.getByLabel('You receive: Lamar Jackson').check();

  const preview = page.getByRole('region', { name: 'Trade preview' });
  await expect(preview).toContainText('This trade is legal.');
  await builder.getByRole('button', { name: 'Propose trade' }).click();
  await expect(page.getByText('Offer sent: the trade is now proposed.')).toBeVisible();

  const sent = page.getByRole('region', { name: 'Sent offers' });
  await expect(sent).toContainText('sends Patrick Mahomes');
  await expect(sent).toContainText('for Lamar Jackson');
  await expect(sent).toContainText('Expires in');

  await sent.getByRole('button', { name: 'Withdraw' }).first().click();
  await expect(page.getByText('Withdraw: the trade is now withdrawn.')).toBeVisible();
  await context.close();
});

/**
 * A pending offer shows up above the lineup (who, what goes each way, and a link to it), and the
 * pending trades sit above the builder on the trades page. Withdrawn at the end, like the test above.
 */
test('a pending trade is called out on the lineup and leads the trades page', async ({ browser }) => {
  const context = await browser.newContext();
  await signInAs(context, 'season-e2e');
  const page = await context.newPage();

  await page.goto('/leagues/demo-season/trades');
  const builder = page.getByRole('region', { name: 'Trade builder' });
  await builder.getByLabel('Trade with').selectOption('team-2');
  await builder.getByLabel('You send: Patrick Mahomes').check();
  await builder.getByLabel('You receive: Lamar Jackson').check();
  await expect(page.getByRole('region', { name: 'Trade preview' })).toContainText('This trade is legal.');
  await builder.getByRole('button', { name: 'Propose trade' }).click();
  await expect(page.getByText('Offer sent: the trade is now proposed.')).toBeVisible();

  await page.goto('/leagues/demo-season/team/lineup');
  const callout = page.getByRole('region', { name: 'Pending trades' });
  await expect(callout).toContainText('Trade pending');
  await expect(callout).toContainText('You give');
  await expect(callout).toContainText('Patrick Mahomes');
  await expect(callout).toContainText('Lamar Jackson');
  await expect(page.getByTestId('roster-row-fx-mahomes').getByTestId('in-trade')).toBeVisible();
  if (process.env.E2E_SHOTS)
    await page.screenshot({ path: `${process.env.E2E_SHOTS}/lineup.png`, fullPage: true });

  await callout.getByRole('link', { name: 'View trade' }).click();
  await expect(page).toHaveURL(/\/team\/trades\?trade=/);
  const sent = page.getByRole('region', { name: 'Sent offers' });
  const sentBox = await sent.boundingBox();
  const builderBox = await page.getByRole('region', { name: 'Trade builder' }).boundingBox();
  expect(sentBox?.y ?? Infinity).toBeLessThan(builderBox?.y ?? 0);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/trades.png` });

  await sent.getByRole('button', { name: 'Withdraw' }).first().click();
  await expect(page.getByText('Withdraw: the trade is now withdrawn.')).toBeVisible();
  await context.close();
});
