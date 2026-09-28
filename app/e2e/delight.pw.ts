import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support';

/**
 * Motion on the matchup page (#133) against the local API server's `demo-season` league. Its clock
 * sits before week 1 kicks off, so the real matchup is scheduled; these tests rewrite the scores and
 * status on the real get_matchup response (everything else is the real server) to play out a live
 * update and a won final.
 */

const WHO = 'season-e2e';
const MATCHUP = /\/api\/v1\/leagues\/demo-season\/matchup(\?|$)/;

interface Side {
  teamId: string;
  score: number | null;
}
interface MatchupBody {
  data: { teamId: string; matchup: { status: string; home: Side; away: Side } };
}

/** Serves the real matchup with the viewer's score and status rewritten by `scores()`. */
async function rewriteMatchup(page: Page, scores: () => { status: string; mine: number; theirs: number }) {
  await page.route(MATCHUP, async (route) => {
    // Page routes win over the context's auth rewrite, so carry the dev token here too.
    const response = await route.fetch({
      headers: { ...route.request().headers(), authorization: `Bearer dev:${WHO}` }
    });
    const body = (await response.json()) as MatchupBody;
    const { status, mine, theirs } = scores();
    const m = body.data.matchup;
    const homeIsMine = m.home.teamId === body.data.teamId;
    m.status = status;
    m.home.score = homeIsMine ? mine : theirs;
    m.away.score = homeIsMine ? theirs : mine;
    await route.fulfill({ response, json: body });
  });
}

const yourScore = (page: Page) => page.getByRole('region', { name: `${WHO}'s Team` }).getByTestId(/^score-/);

test('a won final bursts confetti once, and not again on reload', async ({ browser }) => {
  const context = await browser.newContext();
  await signInAs(context, WHO);
  const page = await context.newPage();
  await rewriteMatchup(page, () => ({ status: 'final', mine: 112.4, theirs: 98.1 }));

  await page.goto('/leagues/demo-season/matchup');
  await expect(page.getByText('You won week 1!')).toBeVisible();
  await expect(page.getByTestId('confetti')).toHaveCount(1);
  await expect(yourScore(page)).toHaveText('112.40');

  await page.reload();
  await expect(page.getByText('Final', { exact: true })).toBeVisible();
  await expect(yourScore(page)).toHaveText('112.40');
  await expect(page.getByText('You won week 1!')).toHaveCount(0);
  await expect(page.getByTestId('confetti')).toHaveCount(0);
  await context.close();
});

test('a live score update counts up and lands on the new total', async ({ browser }) => {
  const context = await browser.newContext();
  await signInAs(context, WHO);
  const page = await context.newPage();
  await page.clock.install();
  let mine = 10;
  await rewriteMatchup(page, () => ({ status: 'in_progress', mine, theirs: 20 }));

  await page.goto('/leagues/demo-season/matchup');
  await expect(yourScore(page)).toHaveText('10.00');

  // The next poll (30s without realtime) brings the new score.
  mine = 27.5;
  await page.clock.fastForward(30_000);
  await expect(yourScore(page)).toHaveAttribute('data-flash', 'up');
  await expect(yourScore(page)).toHaveText('27.50');
  // Now ahead, the viewer's side takes the lead emphasis.
  await expect(page.getByRole('region', { name: `${WHO}'s Team` })).toHaveAttribute('data-leading', 'true');
  await context.close();
});

test('reduced motion skips the confetti but still says you won', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  await signInAs(context, WHO);
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await rewriteMatchup(page, () => ({ status: 'final', mine: 101, theirs: 99 }));

  await page.goto('/leagues/demo-season/matchup');
  await expect(page.getByText('You won week 1!')).toBeVisible();
  await expect(yourScore(page)).toHaveText('101.00');
  await expect(page.getByTestId('confetti')).toHaveCount(0);
  await context.close();
});
