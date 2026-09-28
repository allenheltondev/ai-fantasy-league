import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { serveAuthConfig } from './support';

/**
 * Chat rooms (#144) against the real API with its event loop and agents on the fake model (the
 * agents dev server, see playwright.config.ts): post in #Trash Talk, switch to #Draft and read its
 * announcement, open a DM with an AI manager and get its reply, and fit a 360px phone.
 *
 * The seeded in-season league (`demo-season`) belongs to dev user `local-rooms-e2e`; the other
 * three seats are AI managers.
 */

const WHO = 'rooms-e2e';
const AGENT_API = `http://127.0.0.1:${process.env.E2E_AGENT_API_PORT ?? Number(process.env.E2E_API_PORT ?? 8787) + 1}`;
const CHAT = '/leagues/demo-season/chat';

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

/** Signs in as the dev user and sends every API call to the agents server. */
async function signIn(context: BrowserContext): Promise<void> {
  await serveAuthConfig(context);
  const claims = { sub: `local-${WHO}`, email: `${WHO}@localhost`, given_name: WHO };
  const idToken = [base64url('{"alg":"none"}'), base64url(JSON.stringify(claims)), 'sig'].join('.');
  const session = JSON.stringify({ idToken, refreshToken: 'refresh', expiresAt: 4_102_444_800 });
  await context.addInitScript((value) => localStorage.setItem('rsc:auth', value), session);
  await context.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({
      url: `${AGENT_API}${url.pathname}${url.search}`,
      headers: { ...route.request().headers(), authorization: `Bearer dev:${WHO}` }
    });
    await route.fulfill({ response });
  });
}

const messages = (page: Page) => page.getByRole('list', { name: 'Chat messages' });

test('rooms: trash talk, the #Draft announcement, and a DM an AI manager answers', async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await signIn(context);
  const page = await context.newPage();
  await page.goto(CHAT);

  // Trash talk is where you land.
  await expect(page.getByRole('heading', { name: 'Trash Talk', level: 2 })).toBeVisible();
  const box = page.getByRole('combobox');
  const line = `Week 1 is mine ${Date.now().toString(36)}`;
  await box.fill(line);
  await box.press('Enter');
  await expect(messages(page).getByText(line)).toBeVisible();

  // #Draft holds the draft's announcement.
  const rooms = page.getByTestId('chat-sidebar');
  await rooms.getByRole('button', { name: /# Draft/ }).click();
  await expect(page).toHaveURL(/room=draft/);
  await expect(page.getByRole('article', { name: 'League announcement: Draft Completed' })).toContainText(
    'The draft is complete.'
  );
  await expect(messages(page).getByText(line)).toHaveCount(0);

  // A DM with an AI manager: it answers (the fake model speaks in its personality's voice).
  await rooms.getByRole('button', { name: '+ New message' }).click();
  await rooms
    .getByRole('list', { name: 'Message a team' })
    .getByRole('button', { name: /Team 3/ })
    .click();
  await expect(page).toHaveURL(/room=dm-team-1-team-3/);
  await expect(page.getByRole('heading', { name: 'Team 3', level: 2 })).toBeVisible();
  await box.fill('Want my backup QB for your kicker?');
  await box.press('Enter');
  await expect(messages(page).locator('[data-kind="agent"]').first()).toBeVisible({ timeout: 30_000 });
  // The DM is listed now, and the league room never shows it.
  await expect(rooms.getByRole('button', { name: /^Team 3/ })).toBeVisible();
  await rooms.getByRole('button', { name: /# Trash Talk/ }).click();
  await expect(messages(page).getByText(line)).toBeVisible();
  await expect(messages(page).getByText('Want my backup QB for your kicker?')).toHaveCount(0);
  await context.close();
});

test('mentions: press @, pick an AI manager, and the server resolves the mention (#177)', async ({
  browser
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await signIn(context);
  const page = await context.newPage();
  await page.goto(CHAT);
  const box = page.getByRole('combobox');
  await expect(box).toHaveAttribute('placeholder', 'Message Trash Talk. Type @ to talk to an AI manager.');
  await expect(page.getByTestId('chat-members')).toContainText('AI');

  // The @ button opens the list, AI managers first, each with its team and personality.
  await page.getByRole('button', { name: 'Mention someone' }).click();
  const first = page.getByRole('listbox', { name: 'Mention a team' }).getByRole('option').first();
  const label = (await first.getAttribute('aria-label')) ?? '';
  expect(label).toMatch(/, AI manager/);
  const manager = label.split(', ')[0] as string;
  await first.click();
  await expect(box).toHaveValue(`@${manager} `);
  const tag = Date.now().toString(36);
  await box.pressSequentially(`your bench is thin ${tag}`);
  const posted = page.waitForResponse(
    (r) => r.url().includes('/chat/messages') && r.request().method() === 'POST'
  );
  await box.press('Enter');
  const { data } = (await (await posted).json()) as { data: { message: { mentionedTeamIds: string[] } } };
  expect(data.message.mentionedTeamIds).toHaveLength(1);

  const mine = messages(page).locator('[data-kind="user"]', { hasText: tag });
  const mark = mine.locator('strong');
  await expect(mark).toHaveText(`@${manager}`);
  await expect(mark).toHaveAttribute('data-team-id', data.message.mentionedTeamIds[0] as string);
  await mark.hover();
  await expect(page.getByRole('tooltip')).toContainText(manager);
  await expect(page.getByRole('tooltip')).toContainText('AI');
  await context.close();
});

test('rooms fit a 360px phone, with the room sheet', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 740 },
    isMobile: true,
    hasTouch: true
  });
  await signIn(context);
  const page = await context.newPage();
  await page.goto(`${CHAT}?room=draft`);
  const fits = async () => {
    await page.waitForTimeout(250);
    const width = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.inner);
    expect(width.inner).toBe(360);
  };
  await expect(page.getByRole('article', { name: 'League announcement: Draft Completed' })).toBeVisible();
  await expect(page.getByTestId('chat-sidebar')).toBeHidden();
  await fits();

  // The top bar opens the rooms as a sheet; a room is one tap away.
  const switcher = page.getByRole('button', { name: /Chat room: Draft/ });
  expect((await switcher.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await switcher.tap();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: 'Direct messages' })).toBeVisible();
  await fits();
  const trash = sheet.getByRole('button', { name: /# Trash Talk/ });
  expect((await trash.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await trash.tap();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Chat room: Trash Talk/ })).toBeVisible();
  await fits();
  await context.close();
});
