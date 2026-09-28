import { expect, test, type Page, type Route } from '@playwright/test';
import { AUTH_CONFIG } from './support';

/**
 * The matchup scoring log (#162). The API is a stand-in served with `page.route` (the get_matchup /
 * get_scoring_log contract in packages/server/openapi.json). Realtime is on, with a page script
 * standing in for Momento (the dev server honors `window.__fantasyEvents`), so the test pushes
 * `Scores Updated` carrying a new log entry, like the relay would, and watches it pop in.
 */

const b64 = (value: string) => Buffer.from(value).toString('base64url');
const ID_TOKEN = [
  b64(JSON.stringify({ alg: 'none' })),
  b64(JSON.stringify({ sub: 'allen', email: 'allen@example.com', given_name: 'Allen', family_name: 'H' })),
  'sig'
].join('.');

const MATCHUP = {
  week: 4,
  teamId: 'team-1',
  matchup: {
    id: 'W04-M1',
    status: 'in_progress',
    home: { teamId: 'team-1', teamName: "Allen's Team", score: 24.3, manager: null },
    away: {
      teamId: 'team-2',
      teamName: 'The Spreadsheet',
      score: 18.1,
      manager: { name: 'Marcus Hale', avatarSeed: 'marcus', personality: 'The Spreadsheet' }
    }
  },
  lineups: {
    home: { teamId: 'team-1', points: 24.3, players: [] },
    away: { teamId: 'team-2', points: 18.1, players: [] }
  }
};

const entry = (
  at: string,
  player: { id: string; name: string; team: string; position: string },
  extra = {}
) => ({
  id: `${at}#${player.id}`,
  at,
  kind: 'live',
  teamId: 'team-1',
  teamName: "Allen's Team",
  slot: player.position,
  starter: true,
  player,
  changes: [{ stat: 'rec_yd', delta: 12 }],
  summary: '+1 rec, +12 rec yds',
  points: 1.7,
  touchdown: false,
  ...extra
});

const BROWN = { id: 'fx-ajbrown', name: 'A.J. Brown', team: 'PHI', position: 'WR' };
const CMC = { id: 'fx-cmc', name: 'Christian McCaffrey', team: 'SF', position: 'RB' };
const LOG = [
  entry('2026-10-04T17:40:00.000Z', CMC, {
    teamId: 'team-2',
    teamName: 'The Spreadsheet',
    summary: '+9 rush yds',
    points: 0.9,
    changes: [{ stat: 'rush_yd', delta: 9 }]
  }),
  entry('2026-10-04T17:32:00.000Z', BROWN)
];
const TOUCHDOWN = entry('2026-10-04T17:44:00.000Z', BROWN, {
  summary: '+1 rec, +18 rec yds, +1 rec TD',
  points: 8.3,
  touchdown: true,
  changes: [
    { stat: 'rec', delta: 1 },
    { stat: 'rec_td', delta: 1 },
    { stat: 'rec_yd', delta: 18 }
  ]
});

async function stubApi(page: Page) {
  const json = (route: Route, data: unknown) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data,
        league: { id: 'L1', phase: 'regular_season', week: 4, allowedActions: [] },
        warnings: []
      })
    });
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not stubbed.', fix: 'None.' } })
    })
  );
  await page.route('**/api/v1/leagues/L1/state', (route) =>
    json(route, { leagueId: 'L1', name: 'Log League', phase: 'regular_season', week: 4, allowedActions: [] })
  );
  await page.route('**/api/v1/leagues/L1/matchup', (route) => json(route, MATCHUP));
  await page.route('**/api/v1/leagues/L1/nfl-games', (route) =>
    json(route, { season: 2026, week: 4, games: [], redZone: [], updatedAt: null })
  );
  // The log's newest page stays the same: the new entry can only come from the push.
  await page.route('**/api/v1/leagues/L1/matchup/scoring-log?**', (route) =>
    json(route, { week: 4, teamId: 'team-1', matchupId: 'W04-M1', entries: LOG, nextCursor: null })
  );
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
}

declare global {
  interface Window {
    __pushFantasyEvent?: (event: {
      detailType: string;
      leagueId: string | null;
      detail?: Record<string, unknown>;
    }) => void;
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
    window.__fantasyEvents = async (target, handlers) => {
      window.__fantasyTopics = target.topics;
      window.__pushFantasyEvent = handlers.onEvent;
      return () => undefined;
    };
  }, ID_TOKEN);
});

test('a live touchdown pops into the scoring log, and the filter narrows it', async ({ page }) => {
  await stubApi(page);
  await page.goto('/leagues/L1/matchup');

  const log = page.getByRole('list', { name: 'Scoring plays, newest first' });
  await expect(log.getByRole('listitem')).toHaveCount(2);
  await expect(log.getByRole('listitem').first()).toContainText('Christian McCaffrey');
  await expect(log.getByRole('img', { name: 'Marcus Hale (The Spreadsheet)' })).toBeVisible();

  // The relay pushes Scores Updated with the new entry for this matchup.
  await expect.poll(() => page.evaluate(() => window.__fantasyTopics)).toContain('fantasy.global');
  await page.evaluate(
    (touchdown) =>
      window.__pushFantasyEvent?.({
        detailType: 'Scores Updated',
        leagueId: 'L1',
        detail: { leagueId: 'L1', scoringLog: [{ matchupId: 'W04-M1', entries: [touchdown] }] }
      }),
    TOUCHDOWN
  );
  const newest = log.getByRole('listitem').first();
  await expect(log.getByRole('listitem')).toHaveCount(3);
  await expect(newest).toContainText('+1 rec, +18 rec yds, +1 rec TD');
  await expect(newest).toContainText('+8.30');
  await expect(newest).toContainText('Touchdown');
  await expect(newest).toHaveClass(/scoring-log-td/);
  await expect(newest).toHaveAttribute('data-new', 'true');
  await expect.poll(() => newest.evaluate((li) => getComputedStyle(li).animationName)).toBe('motion-pop');

  await page.getByRole('button', { name: 'Theirs' }).click();
  await expect(log.getByRole('listitem')).toHaveCount(1);
  await expect(log.getByRole('listitem')).toContainText('Christian McCaffrey');
  await page.getByRole('button', { name: 'Mine' }).click();
  await expect(log.getByRole('listitem')).toHaveCount(2);
});

test('the scoring log fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await stubApi(page);
  await page.goto('/leagues/L1/matchup');
  await expect(
    page.getByRole('list', { name: 'Scoring plays, newest first' }).getByRole('listitem')
  ).toHaveCount(2);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
  ).toBe(true);
});
