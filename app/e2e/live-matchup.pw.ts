import { expect, test, type Page, type Route } from '@playwright/test';
import { matchup, NOW, signInStubbed, stubLiveMatchup } from './liveMatchup';

/**
 * The live game-day matchup and lineup locks (#193), against a stubbed API (the get_matchup,
 * get_nfl_games, get_roster, and set_lineup contracts in packages/server/openapi.json) with a page
 * script standing in for AppSync Events, so the test pushes `NFL Games Updated` like the relay would. The
 * page clock is pinned to a Sunday afternoon.
 */

test.use({ timezoneId: 'America/New_York' });

const cell = (page: Page, id: string) => page.getByTestId(`h2h-player-${id}`);

test.beforeEach(async ({ page }) => {
  await signInStubbed(page);
});

test('a live Sunday: who is playing, how far along, and what is done', async ({ page }) => {
  await page.clock.install({ time: new Date(NOW) });
  let data = matchup();
  const reads = await stubLiveMatchup(page, { matchup: () => data });
  await page.goto('/leagues/L1/team/matchup');

  // Both teams' totals, live projections, and who is playing, in words beside the pips.
  const mine = page.getByRole('region', { name: "Allen's Team" });
  await expect(mine.getByTestId('score-team-1')).toHaveText('66.42');
  await expect(mine.getByTestId('projected-team-1')).toHaveText(/^Proj \d+\.\d$/);
  await expect(mine.getByTestId('status-counts')).toHaveText('5 playing · 1 to play · 3 done · 1 out');
  await expect(page.getByRole('region', { name: 'The Spreadsheet' }).getByTestId('status-counts')).toHaveText(
    '4 playing · 3 to play · 2 done · 1 out'
  );

  // Slot by slot: my QB against theirs.
  const qb = page.getByTestId('h2h-row-QB-0');
  await expect(qb.getByRole('rowheader')).toHaveText('QB');
  await expect(qb).toContainText('Jalen Hurts');
  await expect(qb).toContainText('Josh Allen');

  // Live: the quarter and clock, the score, the red zone, the box score, and a lock.
  const hurts = cell(page, 'fx-hurts');
  await expect(hurts.getByTestId('game-context')).toContainText('Q1 9:12·vs DAL 7–0');
  await expect(hurts.getByTestId('red-zone-chip')).toContainText('Red zone·2nd & 4 at DAL 7');
  await expect(hurts.getByTestId('stat-line')).toHaveText('5/7 · 58 yds · 12 rush yds');
  await expect(hurts.getByRole('img', { name: 'Locked: game started' })).toBeVisible();
  // Started, but the scoreboard has not caught up: live, never upcoming.
  await expect(cell(page, 'fx-cmc').getByTestId('game-context')).toHaveText('Live·vs LAR');
  // Final, bye, ruled out, and still to come.
  await expect(cell(page, 'fx-bijan').getByTestId('game-context')).toHaveText('Final W 27–20');
  await expect(cell(page, 'fx-jsn').getByTestId('sits-out')).toContainText('BYE');
  await expect(cell(page, 'fx-kittle').getByTestId('sits-out')).toContainText('OUT');
  await expect(cell(page, 'fx-jjefferson').getByTestId('game-context')).toHaveText('Sun 8:20 PM @ GB');
  // Their players carry no lock: only your own lineup is yours to change.
  await expect(cell(page, 'fx-nabers').getByTestId('lock-mark')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Edit lineup' })).toHaveAttribute(
    'href',
    '/leagues/L1/team/lineup'
  );

  // The bench, collapsed under its totals.
  const bench = page.getByRole('button', { name: 'Bench' });
  await expect(bench).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('h2h-bench')).toBeHidden();
  await bench.click();
  await expect(page.getByTestId('h2h-bench')).toContainText('Patrick Mahomes');

  // Chase's game ends: the relay pushes NFL Games Updated, and the matchup re-reads at once.
  await expect.poll(() => page.evaluate(() => window.__fantasyChannels)).toContain('/fantasy/global');
  const before = reads.matchup;
  data = matchup();
  const chase = data.lineups.home.players.find((p) => p.player.id === 'fx-chase');
  if (chase === undefined) throw new Error('fixture');
  chase.game = { ...chase.game, state: 'final', clock: null, progress: 1, teamScore: 23, opponentScore: 23 };
  chase.points = 17.2;
  data.matchup.home.score = 69.02;
  await page.evaluate(() => window.__pushFantasyEvent?.({ detailType: 'NFL Games Updated', leagueId: null }));
  await expect(cell(page, 'fx-chase').getByTestId('game-context')).toHaveText('Final T 23–23');
  expect(reads.matchup).toBeGreaterThan(before);
  await expect(mine.getByTestId('status-counts')).toHaveText('4 playing · 1 to play · 4 done · 1 out');
  // Screen readers hear the new score, politely.
  await expect(page.getByTestId('score-announcer')).toHaveText("Allen's Team 69.02, The Spreadsheet 41.90.");
});

for (const width of [360, 390, 430]) {
  test(`the live matchup fits a ${width}px phone, with the score bar pinned while it scrolls`, async ({
    page
  }) => {
    await page.clock.install({ time: new Date(NOW) });
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubLiveMatchup(page);
    await page.goto('/leagues/L1/team/matchup');
    await expect(page.getByTestId('score-team-1')).toHaveText('66.42');
    // Short names in the narrow column; the page never scrolls sideways.
    await expect(cell(page, 'fx-cmc')).toContainText('C. McCaffrey');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
    ).toBe(true);
    // The live dot stands still under reduced motion; the red zone does not pulse.
    await expect(cell(page, 'fx-hurts').locator('.motion-live-dot')).toHaveCSS('animation-name', 'none');
    await expect(cell(page, 'fx-hurts')).toHaveCSS('animation-name', 'none');

    await page.getByTestId('h2h-row-DEF-0').scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 400);
    await expect
      .poll(async () => (await page.getByTestId('score-bar').boundingBox())?.y ?? -1)
      .toBeLessThan(20);
    await expect(page.getByTestId('score-bar')).toBeInViewport();
  });
}

/** A lineup on the lineup page, an hour before the 1pm games (#193). */
const K1 = '2026-10-04T17:00:00.000Z';
const K2 = '2026-10-04T20:25:00.000Z';
const rosterEntry = (
  id: string,
  name: string,
  position: string,
  team: string,
  slot: string,
  kickoff: string
) => ({
  player: { id, name, team, position },
  slot,
  status: 'active',
  injuryStatus: null,
  byeWeek: 9,
  onBye: false,
  kickoff,
  opponent: { team: 'DAL', home: true },
  locked: false,
  projectedPoints: 15,
  points: null,
  recentPoints: null
});

async function stubLineup(page: Page) {
  const calls = { roster: 0, saves: 0 };
  const envelope = (data: unknown) => ({
    data,
    league: { id: 'L1', phase: 'regular_season', week: 4, allowedActions: ['set_lineup'] },
    warnings: []
  });
  const json = (route: Route, data: unknown) => route.fulfill({ json: envelope(data) });
  await stubLiveMatchup(page);
  await page.route(/\/api\/v1\/leagues\/L1\/teams\/team-1\/roster/, (route) => {
    calls.roster++;
    return json(route, {
      teamId: 'team-1',
      teamName: "Allen's Team",
      season: 2026,
      week: 4,
      lineupSaved: true,
      carriedFromWeek: null,
      slots: [
        { slot: 'QB', count: 1 },
        { slot: 'WR', count: 2 },
        { slot: 'BN', count: 2 }
      ],
      players: [
        rosterEntry('fx-hurts', 'Jalen Hurts', 'QB', 'PHI', 'QB', K1),
        rosterEntry('fx-chase', "Ja'Marr Chase", 'WR', 'CIN', 'WR', K1),
        rosterEntry('fx-nacua', 'Puka Nacua', 'WR', 'LAR', 'WR', K2),
        rosterEntry('fx-lamb', 'CeeDee Lamb', 'WR', 'DAL', 'BN', K2)
      ],
      projectedPoints: 45,
      optimal: null
    });
  });
  await page.route(/\/api\/v1\/leagues\/L1\/teams\/team-1\/lineup/, (route) => {
    calls.saves++;
    return route.fulfill({
      status: 409,
      json: {
        error: {
          code: 'PLAYER_LOCKED',
          message: "Puka Nacua (fx-nacua)'s game has kicked off, so he must stay in WR.",
          fix: 'Keep Puka Nacua in WR.',
          details: { lockedPlayerIds: ['fx-nacua'] }
        }
      }
    });
  });
  return calls;
}

test('a player locks at his kickoff without a reload, after a countdown; a lost race is named', async ({
  page
}) => {
  await page.clock.install({ time: new Date('2026-10-04T15:50:00.000Z') });
  const calls = await stubLineup(page);
  await page.goto('/leagues/L1/team/lineup');

  const hurts = page.getByTestId('roster-row-fx-hurts');
  await expect(hurts).toBeVisible();
  // More than an hour out: no countdown.
  await expect(hurts.getByTestId('lock-status')).toHaveCount(0);
  await page.clock.fastForward('10:00');
  await expect(hurts.getByTestId('lock-status')).toHaveText('Locks in 60m');
  await page.clock.fastForward('48:00');
  await expect(hurts.getByTestId('lock-status')).toHaveText('Locks in 12m');
  await expect(page.getByRole('button', { name: 'Jalen Hurts, QB' })).toHaveAttribute(
    'aria-disabled',
    'false'
  );

  // Kickoff: he locks on the spot, and cannot be picked up.
  await page.clock.fastForward('12:00');
  await expect(hurts.getByTestId('lock-status')).toHaveText('Locked');
  await expect(page.getByRole('button', { name: 'Jalen Hurts, QB, locked' })).toHaveAttribute(
    'aria-disabled',
    'true'
  );
  // Players in the 4:25 games still move.
  await expect(page.getByTestId('roster-row-fx-nacua').getByTestId('lock-status')).toHaveCount(0);

  // Swap Lamb in for Nacua; the save loses a race with a kickoff the page had not seen yet.
  // Off his name: the name opens his card, the rest of the row picks him up.
  await page.getByRole('button', { name: 'CeeDee Lamb, BN' }).click({ position: { x: 6, y: 6 } });
  await page.getByRole('button', { name: /^Move CeeDee Lamb to WR, swapping with Puka Nacua/ }).click();
  const readsBefore = calls.roster;
  await page.getByRole('button', { name: 'Save lineup' }).click();
  await expect(page.getByTestId('lock-race')).toHaveText(
    'Puka Nacua is locked: his game kicked off before your changes were saved, so nothing was changed.'
  );
  // No generic error; the lineup reloads from the server.
  await expect(page.getByText('Keep Puka Nacua in WR.')).toHaveCount(0);
  await expect.poll(() => calls.roster).toBeGreaterThan(readsBefore);
  await expect(page.getByRole('region', { name: 'Unsaved changes' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Starters' })).toContainText('Puka Nacua');
});
