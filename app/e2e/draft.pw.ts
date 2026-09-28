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

/**
 * A 2-team, 2-round draft: the agent took CMC, and Allen is on the clock at pick 2. Allen's draft
 * queue lives in the stand-in, as on the server; `expire()` runs the pick clock's autopick, which
 * takes the first queued player still available.
 */
function draftApi(page: Page, options: { pickSeconds?: number; startsAt?: number } = {}) {
  const pickSeconds = options.pickSeconds ?? 90;
  const deadline = new Date(Date.now() + pickSeconds * 1000).toISOString();
  let queue: string[] = [];
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
        deadline: mine ? deadline : new Date(Date.now() + 90_000).toISOString(),
        secondsLeft: pickSeconds
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
  // A scheduled draft: before `startsAt` there is no board (the lobby shows), then the draft is on.
  const startsAt = options.startsAt;
  void page.route('**/api/v1/leagues/L1/draft?*', (route) =>
    startsAt !== undefined && Date.now() < startsAt
      ? route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'DRAFT_NOT_STARTED',
              message: 'The draft has not started yet.',
              fix: 'Wait for the commissioner to start the draft.'
            }
          }
        })
      : route.fulfill({ json: envelope(board()) })
  );
  const lobbyTeams = [
    { teamId: 'team-2', teamName: 'The Spreadsheet', seatType: 'agent', here: true, lastSeenAt: null },
    { teamId: 'team-1', teamName: "Allen's Team", seatType: 'human', here: true, lastSeenAt: null }
  ];
  void page.route('**/api/v1/leagues/L1/draft/lobby', (route) =>
    route.fulfill({
      json: envelope({
        phase: startsAt !== undefined && Date.now() < startsAt ? 'setup' : 'drafting',
        scheduledAt: startsAt === undefined ? null : new Date(startsAt).toISOString(),
        orderMode: 'slots',
        serverTime: new Date().toISOString(),
        order: lobbyTeams,
        teams: lobbyTeams,
        commissionerHere: true,
        canStart: false
      })
    })
  );
  void page.route('**/api/v1/players?*', (route) =>
    route.fulfill({ json: envelope({ players: [CHASE, LAMB] }) })
  );
  const queueView = () => ({
    teamId: 'team-1',
    maxSize: 50,
    updatedAt: null,
    players: queue.map((id) => ({
      player: [CHASE, LAMB, CMC].find((p) => p.id === id),
      rank: null,
      available: !picks.some((p) => p.player.id === id)
    }))
  });
  void page.route('**/api/v1/leagues/L1/draft/queue', async (route) => {
    if (route.request().method() === 'PUT') {
      queue = (route.request().postDataJSON() as { playerIds: string[] }).playerIds;
    }
    await route.fulfill({ json: envelope(queueView()) });
  });
  // The league header and the realtime token (off here, so the board polls).
  // The header bell's summary (#165): nothing waiting.
  void page.route('**/api/v1/notifications', (route) =>
    route.fulfill({ json: envelope({ unreadCount: 0, leagues: [] }) })
  );
  void page.route('**/api/v1/leagues/L1/state', (route) =>
    route.fulfill({
      json: envelope({
        leagueId: 'L1',
        name: 'Draft Day League',
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
  /** The pick clock ran out on Allen: autopick takes his first queued player still available. */
  const expire = () => {
    const player = queue
      .map((id) => [CHASE, LAMB].find((p) => p.id === id))
      .find((p) => p !== undefined && !picks.some((pick) => pick.player.id === p.id));
    picks.push({
      overall: 2,
      round: 1,
      pick: 2,
      teamId: 'team-1',
      player: player ?? CHASE,
      auto: true,
      madeAt: null
    });
  };
  return { posted, expire, queue: () => queue };
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

test('a finished draft shows the recap with the AI teams reasoning', async ({ page }) => {
  draftApi(page);
  const reason = 'Best back on the board, and I will not miss.';
  const recapEntry = {
    overall: 1,
    round: 1,
    teamId: 'team-2',
    teamName: 'The Spreadsheet',
    player: CMC,
    adp: 1,
    value: 0,
    reason
  };
  await page.route('**/api/v1/leagues/L1/draft?*', (route) =>
    route.fulfill({
      json: {
        data: {
          status: 'complete',
          rounds: 1,
          pickSeconds: 90,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          order: [
            { teamId: 'team-2', teamName: 'The Spreadsheet', seatType: 'agent' },
            { teamId: 'team-1', teamName: "Allen's Team", seatType: 'human' }
          ],
          onTheClock: null,
          yourTeamId: 'team-1',
          yourNextPick: null,
          yourNeeds: [],
          picks: [
            {
              overall: 1,
              round: 1,
              pick: 1,
              teamId: 'team-2',
              player: CMC,
              auto: false,
              madeAt: null,
              adp: 1,
              reason
            },
            {
              overall: 2,
              round: 1,
              pick: 2,
              teamId: 'team-1',
              player: LAMB,
              auto: false,
              madeAt: null,
              adp: 14,
              reason: null
            }
          ],
          recap: {
            steals: [],
            reaches: [
              {
                ...recapEntry,
                overall: 2,
                teamId: 'team-1',
                teamName: "Allen's Team",
                player: LAMB,
                adp: 14,
                value: -12,
                reason: null
              }
            ],
            agentPicks: [recapEntry]
          },
          rosters: [],
          bestAvailable: []
        },
        league: { id: 'L1', phase: 'regular_season', week: 1, allowedActions: [] },
        warnings: []
      }
    })
  );
  await page.goto('/leagues/L1/draft');
  await expect(page.getByText('The draft is complete. Good luck this season!')).toBeVisible();
  const recap = page.getByTestId('draft-recap');
  await expect(recap).toContainText("Reaches: Allen's Team: CeeDee Lamb at pick 2 (ADP 14)");
  await expect(page.getByRole('list', { name: 'AI first picks' })).toContainText(
    `The Spreadsheet took Christian McCaffrey at pick 1: “${reason}”`
  );
  await expect(page.getByTestId('cell-1')).toHaveAttribute('title', reason);
});

test('a human on the clock drafts a player from the board', async ({ page }) => {
  const { posted } = draftApi(page);
  await page.goto('/leagues/L1/draft');
  await expect(page.getByText('You are on the clock!')).toBeVisible();
  await expect(page.getByTestId('cell-1')).toHaveText('Christian McCaffrey (RB)');
  await expect(page.getByTestId('pick-clock')).toHaveText(/^1:(2\d|30)$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Draft Day League' })).toBeVisible();
  await expect(page.getByTestId('draft-updates')).toHaveText('Refreshing every 3s');

  // Line up a queue, then draft from it.
  await page.getByRole('button', { name: 'Queue CeeDee Lamb' }).click();
  await page.getByRole('button', { name: "Queue Ja'Marr Chase" }).click();
  await page.getByRole('button', { name: "Move Ja'Marr Chase up" }).click();
  await expect(page.getByRole('list', { name: 'Your queue' }).getByRole('listitem').first()).toContainText(
    "1. Ja'Marr Chase"
  );
  await page.getByRole('button', { name: "Draft Ja'Marr Chase from the queue" }).click();

  await expect(page.getByTestId('cell-2')).toHaveText("Ja'Marr Chase (WR)");
  await expect(page.getByRole('list', { name: 'Your roster' })).toContainText("Ja'Marr Chase");
  await expect(page.getByText('You are on the clock!')).toHaveCount(0);
  await expect(page.getByText(/Your next pick is #3/)).toBeVisible();
  // Drafted players leave the queue; the rest stays on the server, across a reload.
  await expect(page.getByRole('list', { name: 'Your queue' })).not.toContainText("Ja'Marr Chase");
  await page.reload();
  await expect(page.getByRole('list', { name: 'Your queue' })).toContainText('CeeDee Lamb');
  expect(posted).toEqual([{ body: { playerId: 'fx-chase', pick: 2 }, key: expect.any(String) }]);
});

test('when the clock runs out, autopick takes your first queued player', async ({ page }) => {
  const api = draftApi(page, { pickSeconds: 4 });
  await page.goto('/leagues/L1/draft');
  await expect(page.getByText('You are on the clock!')).toBeVisible();
  // Chase is the best available, but Allen queues Lamb.
  await page.getByRole('button', { name: 'Queue CeeDee Lamb' }).click();
  await expect(page.getByRole('list', { name: 'Your queue' })).toContainText('1. CeeDee Lamb');
  await expect.poll(() => api.queue()).toEqual(['fx-lamb']);
  await expect(page.getByTestId('pick-clock')).toHaveText('0:00', { timeout: 10_000 });

  api.expire();
  await expect(page.getByTestId('cell-2')).toHaveText('CeeDee Lamb (WR) · auto', { timeout: 10_000 });
  await expect(page.getByRole('list', { name: 'Your roster' })).toContainText('CeeDee Lamb');
  await expect(page.getByRole('list', { name: 'Your queue' })).toHaveCount(0);
});

test('a scheduled draft: the lobby counts down, then flips to the live board', async ({ page }) => {
  draftApi(page, { startsAt: Date.now() + 6_000 });
  await page.goto('/leagues/L1/draft');
  const lobby = page.getByTestId('draft-lobby');
  await expect(lobby.getByTestId('draft-countdown')).toHaveText(/^0:0[1-6]$/);
  await expect(lobby.getByRole('list', { name: "Who's here" })).toContainText("Allen's Team");
  await expect(lobby.getByRole('list', { name: 'Draft order' })).toContainText('The Spreadsheet');
  // Queue from the lobby before the draft.
  await lobby.getByRole('button', { name: 'Queue CeeDee Lamb' }).click();
  await expect(lobby.getByRole('list', { name: 'Your queue' })).toContainText('1. CeeDee Lamb');

  // The countdown runs out and the board replaces the lobby, no reload.
  await expect(page.getByText('You are on the clock!')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('draft-lobby')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Your queue' })).toContainText('1. CeeDee Lamb');
});
