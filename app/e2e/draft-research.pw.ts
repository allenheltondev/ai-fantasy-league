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
const CMC = ref('fx-cmc', 'Christian McCaffrey', 'RB', 'SF');

const envelope = (data: unknown) => ({
  data,
  league: { id: 'L1', phase: 'drafting', week: null, allowedActions: [] },
  warnings: []
});

function researchApi(page: Page) {
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
  void page.route('**/api/v1/players/card?*', (route) => route.fulfill({ json: envelope(card) }));
  // The server-side draft queue (#134): starts empty; a PUT stores the order and echoes it back.
  let queued: string[] = [];
  const known = [CHASE, CMC];
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
  const row = page.getByTestId('available-fx-chase');
  await expect(row).toContainText('17.7');
  await expect(row).toContainText('288');

  await row.getByRole('button', { name: "Ja'Marr Chase", exact: true }).click();
  const card = page.getByTestId('player-card');
  await expect(card).toContainText('301.4 pts · 17.7 PPG · 17 games');
  await expect(card.getByTestId('sparkline')).toBeVisible();
  await expect(card).toContainText('bye 10');
  await expect(card.getByRole('link', { name: 'Chase full go at practice' })).toBeVisible();
  await card.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Queued' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('list', { name: 'Your queue' })).toContainText("1. Ja'Marr Chase");

  await page.getByRole('button', { name: 'Depth' }).click();
  const chart = page.getByRole('table', { name: 'Depth chart' });
  await expect(chart.getByRole('row').nth(1)).toContainText("Allen's Team");
  await expect(page.getByTestId('depth-team-2-RB')).toContainText('RB 1/2');
  await expect(page.getByTestId('depth-team-2-RB')).toContainText('Christian McCaffrey');
  await expect(page.getByTestId('depth-team-2')).toContainText('1 pick before you');
  await expect(page.getByTestId('depth-team-1-QB')).toHaveAttribute('data-gap', 'true');
});
