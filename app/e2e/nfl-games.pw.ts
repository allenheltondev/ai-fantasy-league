import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Live red-zone highlights and the NFL games strip on the matchup page (#132). The API is a
 * stateful stand-in served with `page.route` (the get_matchup / get_nfl_games contract in
 * packages/server/openapi.json). Realtime is on, with a page script standing in for Momento (the dev
 * server honors `window.__fantasyEvents`), so the test pushes `NFL Games Updated` like the relay
 * would and watches the page update without polling.
 */

const AUTH_CONFIG = { region: 'us-east-1', userPoolId: 'us-east-1_e2e', clientId: 'e2e-client' };
const b64 = (value: string) => Buffer.from(value).toString('base64url');
const ID_TOKEN = [
  b64(JSON.stringify({ alg: 'none' })),
  b64(JSON.stringify({ sub: 'allen', email: 'allen@example.com', given_name: 'Allen', family_name: 'H' })),
  'sig'
].join('.');

const row = (id: string, name: string, position: string, team: string, slot = position, points = 6.4) => ({
  player: { id, name, team, position },
  slot,
  status: 'active',
  injuryStatus: null,
  byeWeek: 9,
  onBye: false,
  kickoff: '2026-10-04T17:00:00.000Z',
  locked: true,
  projectedPoints: 18,
  points
});

const MATCHUP = {
  week: 4,
  teamId: 'team-1',
  matchup: {
    id: 'W04-M1',
    status: 'in_progress',
    home: { teamId: 'team-1', teamName: "Allen's Team", score: 24.3 },
    away: { teamId: 'team-2', teamName: 'The Spreadsheet', score: 18.1 }
  },
  lineups: {
    home: {
      teamId: 'team-1',
      points: 24.3,
      players: [
        row('fx-hurts', 'Jalen Hurts', 'QB', 'PHI'),
        row('fx-ajbrown', 'A.J. Brown', 'WR', 'PHI'),
        row('fx-def-phi', 'Eagles', 'DEF', 'PHI'),
        row('fx-lamb', 'CeeDee Lamb', 'WR', 'DAL')
      ]
    },
    away: {
      teamId: 'team-2',
      points: 18.1,
      players: [
        row('fx-mclaurin', 'Terry McLaurin', 'WR', 'WAS'),
        row('fx-cmc', 'Christian McCaffrey', 'RB', 'SF')
      ]
    }
  }
};

const game = (away: string, home: string, extra: Record<string, unknown>) => ({
  gameId: `2026_04_${away}_${home}`,
  homeTeam: home,
  awayTeam: away,
  homeScore: 14,
  awayScore: 10,
  kickoff: '2026-10-04T17:00:00.000Z',
  state: 'in',
  status: '8:32 - 2nd',
  period: 2,
  clock: '8:32',
  possessionTeam: null,
  isRedZone: false,
  downDistance: null,
  fieldPosition: null,
  yardsToGoal: null,
  ...extra
});

function nflGames(redZone: boolean) {
  const games = [
    game('KC', 'JAX', { state: 'post', status: 'Final', clock: null, homeScore: 24, awayScore: 27 }),
    game('LAR', 'SF', {
      state: 'pre',
      status: '10/4 - 4:25 PM EDT',
      homeScore: null,
      awayScore: null,
      period: null,
      clock: null,
      kickoff: '2026-10-04T20:25:00.000Z'
    }),
    game('WAS', 'NYG', {
      homeScore: 3,
      awayScore: 7,
      possessionTeam: 'WAS',
      downDistance: '1st & 10 at WAS 35',
      fieldPosition: 'WAS 35',
      yardsToGoal: 65
    }),
    redZone
      ? game('DAL', 'PHI', {
          possessionTeam: 'PHI',
          isRedZone: true,
          downDistance: '2nd & 4 at DAL 7',
          fieldPosition: 'DAL 7',
          yardsToGoal: 7
        })
      : game('DAL', 'PHI', { homeScore: 21, status: '8:01 - 2nd', clock: '8:01', possessionTeam: 'DAL' })
  ];
  return {
    season: 2026,
    week: 4,
    games,
    redZone: redZone ? [{ team: 'PHI', downDistance: '2nd & 4 at DAL 7', fieldPosition: 'DAL 7' }] : [],
    updatedAt: '2026-10-04T18:30:00.000Z'
  };
}

/** The API stand-in. `drive.redZone` is what get_nfl_games serves next. */
async function stubApi(page: Page) {
  const drive = { redZone: true, reads: 0 };
  const json = (route: Route, data: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({
        data,
        league: { id: 'L1', phase: 'regular_season', week: 4, allowedActions: [] },
        warnings: []
      })
    });
  // Anything this page does not need (the outlook panel, the chat badge) answers 404.
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not stubbed.', fix: 'None.' } })
    })
  );
  await page.route('**/api/v1/leagues/L1/state', (route) =>
    json(route, {
      leagueId: 'L1',
      name: 'Red Zone League',
      phase: 'regular_season',
      week: 4,
      allowedActions: []
    })
  );
  await page.route('**/api/v1/leagues/L1/matchup', (route) => json(route, MATCHUP));
  await page.route('**/api/v1/leagues/L1/nfl-games', (route) => {
    drive.reads++;
    return json(route, nflGames(drive.redZone));
  });
  await page.route('**/api/v1/leagues/L1/realtime', (route) =>
    json(route, {
      enabled: true,
      token: 'e2e-token',
      endpoint: null,
      cacheName: 'e2e-cache',
      topics: { league: 'fantasy.league.L1', global: 'fantasy.global', team: null },
      expiresAt: null,
      pollIntervalSeconds: 30
    })
  );
  return drive;
}

declare global {
  interface Window {
    __pushFantasyEvent?: (event: { detailType: string; leagueId: string | null }) => void;
    __fantasyTopics?: string[];
  }
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
    // Stand in for Momento: remember the handler so the test can push relayed events.
    window.__fantasyEvents = async (target, handlers) => {
      window.__fantasyTopics = target.topics;
      window.__pushFantasyEvent = handlers.onEvent;
      return () => undefined;
    };
  }, ID_TOKEN);
});

test('a red-zone drive highlights my players and the game, and clears on a realtime push', async ({
  page
}) => {
  const drive = await stubApi(page);
  await page.goto('/leagues/L1/matchup');

  const hurts = page.getByRole('row', { name: /Jalen Hurts/ });
  await expect(hurts).toHaveClass(/red-zone-row/);
  await expect(hurts).toContainText('Red zone·2nd & 4 at DAL 7');
  await expect(page.getByRole('row', { name: /A\.J\. Brown/ })).toHaveClass(/red-zone-row/);
  // A defense is not highlighted, nor a player on the other team in that game.
  await expect(page.getByRole('row', { name: /Eagles/ })).not.toHaveClass(/red-zone-row/);
  await expect(page.getByRole('row', { name: /CeeDee Lamb/ })).not.toHaveClass(/red-zone-row/);
  // The pulse runs on the row's left bar.
  const bar = hurts.getByRole('cell').first();
  await expect.poll(() => bar.evaluate((td) => getComputedStyle(td).animationName)).toBe('red-zone-pulse');

  const strip = page.getByRole('region', { name: 'NFL games · week 4' });
  const cards = strip.getByRole('article');
  // My started players' games first (PHI, then DAL's is the same game), then live, upcoming, final.
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0)).toHaveAccessibleName('DAL at PHI');
  await expect(cards.nth(1)).toHaveAccessibleName('WAS at NYG');
  await expect(cards.nth(2)).toHaveAccessibleName('LAR at SF');
  await expect(cards.nth(3)).toHaveAccessibleName('KC at JAX');
  await expect(cards.nth(0)).toHaveClass(/red-zone-card/);
  await expect(cards.nth(0).getByRole('img', { name: 'PHI ball, 7 yards from the end zone' })).toBeVisible();
  await expect(cards.nth(1)).toContainText('1st & 10 at WAS 35');
  await expect(cards.nth(3)).toContainText('Final');

  // The drive ends in a touchdown: the relay pushes NFL Games Updated and the page re-reads.
  await expect.poll(() => page.evaluate(() => window.__fantasyTopics)).toContain('fantasy.global');
  drive.redZone = false;
  const reads = drive.reads;
  await page.evaluate(() => window.__pushFantasyEvent?.({ detailType: 'NFL Games Updated', leagueId: null }));
  await expect(hurts).not.toHaveClass(/red-zone-row/);
  await expect(page.getByTestId('red-zone-chip')).toHaveCount(0);
  await expect(cards.nth(0)).toContainText('21');
  await expect(cards.nth(0)).toContainText('8:01 - 2nd');
  expect(drive.reads).toBe(reads + 1);
});

test('reduced motion keeps the highlight still, and the strip fits a phone', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 800 });
  await stubApi(page);
  await page.goto('/leagues/L1/matchup');

  const hurts = page.getByRole('row', { name: /Jalen Hurts/ });
  await expect(hurts).toHaveClass(/red-zone-row/);
  await expect(hurts).not.toHaveClass(/red-zone-pulse/);
  await expect(hurts.getByRole('cell').first()).toHaveCSS('animation-name', 'none');
  await expect(page.getByRole('region', { name: 'NFL games · week 4' }).getByRole('article')).toHaveCount(4);
  // The strip scrolls sideways on its own; the page does not.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
  ).toBe(true);
});
