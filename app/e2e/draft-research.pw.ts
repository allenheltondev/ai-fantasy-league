import { expect, test, type Page } from '@playwright/test';

/**
 * Draft research (#136): open a player card from Best available, queue him from the card, then
 * view the depth chart. The API is a stand-in served with `page.route`; the SPA runs for real.
 */

const AUTH_CONFIG = { region: 'us-east-1', userPoolId: 'us-east-1_e2e', clientId: 'e2e-client' };
const b64 = (value: string) => Buffer.from(value).toString('base64url');
const ID_TOKEN = [
  b64(JSON.stringify({ alg: 'none' })),
  b64(JSON.stringify({ sub: 'allen', email: 'allen@example.com', given_name: 'Allen', family_name: 'H' })),
  'sig'
].join('.');

const ref = (id: string, name: string, position: string, team: string) => ({ id, name, team, position });
const CHASE = ref('fx-chase', "Ja'Marr Chase", 'WR', 'CIN');
const LAMB = ref('fx-lamb', 'CeeDee Lamb', 'WR', 'DAL');
const CMC = ref('fx-cmc', 'Christian McCaffrey', 'RB', 'SF');

const envelope = (data: unknown) => ({
  data,
  league: { id: 'L1', phase: 'drafting', week: null, allowedActions: [] },
  warnings: []
});

function researchApi(page: Page) {
  void page.route('**/api/v1/leagues/L1/chat/messages?*', (route) =>
    route.fulfill({ json: envelope({ messages: [], nextCursor: null }) })
  );
  void page.route('**/api/v1/leagues/L1/chat/rooms/draft/read', (route) =>
    route.fulfill({ json: envelope({}) })
  );
  void page.route('**/api/v1/leagues/L1', (route) => route.fulfill({ json: envelope({ teams: [] }) }));
  const board = {
    status: 'in_progress',
    rounds: 2,
    pickSeconds: 90,
    startedAt: new Date().toISOString(),
    completedAt: null,
    order: [
      { teamId: 'team-2', teamName: 'The Spreadsheet', seatType: 'agent' },
      { teamId: 'team-1', teamName: "Allen's Team", seatType: 'human' }
    ],
    onTheClock: {
      overall: 2,
      round: 1,
      pick: 2,
      teamId: 'team-2',
      teamName: 'The Spreadsheet',
      deadline: new Date(Date.now() + 90_000).toISOString(),
      secondsLeft: 90
    },
    yourTeamId: 'team-1',
    yourNextPick: { overall: 3, round: 2, pick: 1, picksAway: 1 },
    yourNeeds: ['QB', 'RB', 'WR'],
    picks: [{ overall: 1, round: 1, pick: 1, teamId: 'team-2', player: CMC, auto: false, madeAt: null }],
    rosters: [
      { teamId: 'team-2', teamName: 'The Spreadsheet', players: [CMC] },
      { teamId: 'team-1', teamName: "Allen's Team", players: [] }
    ],
    bestAvailable: [
      {
        player: CHASE,
        rank: 1,
        lastSeason: { points: 301.4, ppg: 17.7, games: 17 },
        projection: { points: 288 },
        bye: 10,
        injuryStatus: 'Questionable'
      }
    ]
  };
  const card = {
    player: { ...CHASE, rank: 1 },
    scoring: { source: 'league' },
    bye: 10,
    injuryStatus: 'Questionable',
    lastSeason: {
      season: 2025,
      points: 301.4,
      ppg: 17.7,
      games: 17,
      weekly: Array.from({ length: 17 }, (_, i) => ({ week: i + 1, points: 10 + (i % 5) * 4 })),
      totals: { rec_tgt: 160, rec: 110, rec_yd: 1500, rec_td: 12 }
    },
    projection: { season: 2026, points: 288, totals: { rec: 105, rec_yd: 1400 } },
    news: [
      {
        id: 'n1',
        title: 'Chase full go at practice',
        url: 'https://example.com/chase',
        source: 'ESPN',
        publishedAt: '2026-09-08T12:00:00.000Z'
      }
    ]
  };
  const depth = {
    yourTeamId: 'team-1',
    teams: [
      {
        teamId: 'team-1',
        teamName: "Allen's Team",
        yours: true,
        picksBeforeYou: 0,
        positions: ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((position) => ({ position, players: [] })),
        slots: [
          { slot: 'QB', required: 1, filled: 0 },
          { slot: 'RB', required: 2, filled: 0 }
        ],
        gaps: ['QB', 'RB', 'RB']
      },
      {
        teamId: 'team-2',
        teamName: 'The Spreadsheet',
        yours: false,
        picksBeforeYou: 1,
        positions: ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((position) => ({
          position,
          players: position === 'RB' ? [CMC] : []
        })),
        slots: [
          { slot: 'QB', required: 1, filled: 0 },
          { slot: 'RB', required: 2, filled: 1 }
        ],
        gaps: ['QB', 'RB']
      }
    ]
  };
  void page.route('**/api/v1/leagues/L1/draft?*', (route) => route.fulfill({ json: envelope(board) }));
  void page.route('**/api/v1/leagues/L1/draft/depth', (route) => route.fulfill({ json: envelope(depth) }));
  void page.route('**/api/v1/players/card?*', (route) =>
    route.fulfill({
      json: envelope(
        new URL(route.request().url()).searchParams.get('playerId') === LAMB.id
          ? { ...card, player: { ...LAMB, rank: 2 }, projection: { ...card.projection, points: 274 } }
          : card
      )
    })
  );
  // The server-side draft queue (#134): starts empty; a PUT stores the order and echoes it back.
  let queued: string[] = [];
  const known = [LAMB, CHASE, CMC];
  void page.route('**/api/v1/leagues/L1/draft/queue', async (route) => {
    if (route.request().method() === 'PUT') {
      queued = (route.request().postDataJSON() as { playerIds: string[] }).playerIds;
    }
    await route.fulfill({
      json: envelope({
        teamId: 'team-1',
        maxSize: 50,
        updatedAt: null,
        players: queued.flatMap((id) => {
          const player = known.find((p) => p.id === id);
          return player === undefined ? [] : [{ player, rank: null, available: true }];
        })
      })
    });
  });
  // The shell (#178): the header's league switcher and the side nav's chat unread count.
  void page.route('**/api/v1/leagues', (route) =>
    route.fulfill({ json: envelope({ leagues: [{ id: 'L1', name: 'Research League' }] }) })
  );
  void page.route('**/api/v1/leagues/L1/chat/rooms', (route) =>
    route.fulfill({ json: envelope({ defaultRoomId: 'trash-talk', rooms: [] }) })
  );
  // The header bell's summary (#165): nothing waiting.
  void page.route('**/api/v1/notifications', (route) =>
    route.fulfill({ json: envelope({ unreadCount: 0, leagues: [] }) })
  );
  void page.route('**/api/v1/leagues/L1/state', (route) =>
    route.fulfill({
      json: envelope({
        leagueId: 'L1',
        name: 'Research League',
        phase: 'drafting',
        week: null,
        allowedActions: []
      })
    })
  );
  void page.route('**/api/v1/leagues/L1/realtime', (route) =>
    route.fulfill({
      json: envelope({
        enabled: false,
        token: null,
        endpoint: null,
        cacheName: null,
        topics: null,
        expiresAt: null,
        pollIntervalSeconds: 3
      })
    })
  );
  return { board, card };
}

test.beforeEach(async ({ page }) => {
  await page.route('**/auth-config.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AUTH_CONFIG) })
  );
  await page.addInitScript((token) => {
    localStorage.setItem(
      'rsc:auth',
      JSON.stringify({ idToken: token, refreshToken: 'refresh', expiresAt: 4_102_444_800_000 })
    );
  }, ID_TOKEN);
});

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
