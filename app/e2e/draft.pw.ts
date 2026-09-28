import { expect, test, type Page } from '@playwright/test';

/**
 * A human makes a draft pick on the board. The API is a stateful stand-in served with
 * `page.route` (same envelope as the real API); the SPA runs for real in Chromium, signed in with
 * a stored session.
 */

const AUTH_CONFIG = { region: 'us-east-1', userPoolId: 'us-east-1_e2e', clientId: 'e2e-client' };

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

const ID_TOKEN = [
  base64url(JSON.stringify({ alg: 'none' })),
  base64url(
    JSON.stringify({ sub: 'allen', email: 'allen@example.com', given_name: 'Allen', family_name: 'H' })
  ),
  'sig'
].join('.');

const ref = (id: string, name: string, position: string, team: string) => ({ id, name, team, position });
const CHASE = ref('fx-chase', "Ja'Marr Chase", 'WR', 'CIN');
const CMC = ref('fx-cmc', 'Christian McCaffrey', 'RB', 'SF');
const LAMB = ref('fx-lamb', 'CeeDee Lamb', 'WR', 'DAL');

/** A 2-team, 2-round draft: the agent took CMC, and Allen is on the clock at pick 2. */
function draftApi(page: Page) {
  const picks: {
    overall: number;
    round: number;
    pick: number;
    teamId: string;
    player: typeof CMC;
    auto: boolean;
    madeAt: string | null;
  }[] = [{ overall: 1, round: 1, pick: 1, teamId: 'team-2', player: CMC, auto: false, madeAt: null }];
  const board = () => {
    const mine = picks.length === 1;
    return {
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
        overall: picks.length + 1,
        round: picks.length < 2 ? 1 : 2,
        pick: picks.length < 2 ? 2 : 1,
        teamId: mine ? 'team-1' : 'team-2',
        teamName: mine ? "Allen's Team" : 'The Spreadsheet',
        deadline: new Date(Date.now() + 90_000).toISOString(),
        secondsLeft: 90
      },
      yourTeamId: 'team-1',
      yourNextPick: mine
        ? { overall: 2, round: 1, pick: 2, picksAway: 0 }
        : { overall: 3, round: 2, pick: 1, picksAway: 1 },
      yourNeeds: ['QB', 'WR'],
      picks,
      rosters: [
        { teamId: 'team-2', teamName: 'The Spreadsheet', players: [CMC] },
        {
          teamId: 'team-1',
          teamName: "Allen's Team",
          players: picks.filter((p) => p.teamId === 'team-1').map((p) => p.player)
        }
      ],
      bestAvailable: [CHASE, LAMB]
        .filter((p) => !picks.some((pick) => pick.player.id === p.id))
        .map((player, i) => ({ player, rank: i + 1 }))
    };
  };
  const envelope = (data: unknown) => ({
    data,
    league: { id: 'L1', phase: 'drafting', week: null, allowedActions: [] },
    warnings: []
  });
  const posted: unknown[] = [];
  void page.route('**/api/v1/leagues/L1/draft?*', (route) => route.fulfill({ json: envelope(board()) }));
  void page.route('**/api/v1/leagues/L1/draft/picks', async (route) => {
    const body = route.request().postDataJSON() as { playerId: string; pick: number };
    posted.push({ body, key: route.request().headers()['idempotency-key'] });
    const player = [CHASE, LAMB].find((p) => p.id === body.playerId) ?? CHASE;
    picks.push({
      overall: 2,
      round: 1,
      pick: 2,
      teamId: 'team-1',
      player,
      auto: false,
      madeAt: new Date().toISOString()
    });
    await route.fulfill({
      json: envelope({
        pick: { overall: 2, round: 1, pick: 2, teamId: 'team-1', player },
        draftComplete: false,
        onTheClock: null
      })
    });
  });
  return posted;
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

test('a human on the clock drafts a player from the board', async ({ page }) => {
  const posted = draftApi(page);
  await page.goto('/leagues/L1/draft');
  await expect(page.getByText('You are on the clock!')).toBeVisible();
  await expect(page.getByTestId('cell-1')).toHaveText('Christian McCaffrey (RB)');
  await expect(page.getByTestId('pick-clock')).toHaveText(/^1:(2\d|30)$/);

  await page.getByRole('button', { name: "Draft Ja'Marr Chase" }).click();

  await expect(page.getByTestId('cell-2')).toHaveText("Ja'Marr Chase (WR)");
  await expect(page.getByRole('list', { name: 'Your roster' })).toContainText("Ja'Marr Chase");
  await expect(page.getByText('You are on the clock!')).toHaveCount(0);
  await expect(page.getByText(/Your next pick is #3/)).toBeVisible();
  expect(posted).toEqual([{ body: { playerId: 'fx-chase', pick: 2 }, key: expect.any(String) }]);
});
