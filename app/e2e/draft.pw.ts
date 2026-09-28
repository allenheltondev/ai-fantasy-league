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
function draftApi(
  page: Page,
  options: { pickSeconds?: number; startsAt?: number; allowedActions?: string[] } = {}
) {
  const pickSeconds = options.pickSeconds ?? 90;
  // The draft's status (the commissioner can pause it) and what the caller may do.
  const clock = { status: 'in_progress' };
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
      status: clock.status,
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
    league: { id: 'L1', phase: 'drafting', week: null, allowedActions: options.allowedActions ?? [] },
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
  return { posted, expire, queue: () => queue, clock };
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

test('a finished draft opens on the report card, with the recap and the board', async ({ page }) => {
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
  const graded = (teamId: string, teamName: string, grade: string, wins: number, rank: number) => ({
    teamId,
    teamName,
    yours: teamId === 'team-1',
    grade,
    headline: `${teamName} headline.`,
    strengths: ['A strength.'],
    weaknesses: ['A weakness.'],
    analysis: 'An analysis.',
    projectedWins: wins,
    projectedLosses: 1 - wins,
    projectedRank: rank,
    projectedPoints: 100,
    expectedWins: wins
  });
  await page.route('**/api/v1/leagues/L1/draft/report-card', (route) =>
    route.fulfill({
      json: {
        data: {
          status: 'ready',
          source: 'model',
          summary: 'The Spreadsheet ran away with it.',
          generatedAt: new Date().toISOString(),
          teams: [graded('team-2', 'The Spreadsheet', 'A', 1, 1), graded('team-1', "Allen's Team", 'C', 0, 2)]
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
  // The results open first: the AI report card and projected standings.
  const results = page.getByTestId('draft-results');
  await expect(results).toContainText('The Spreadsheet ran away with it.');
  await expect(page.getByTestId('report-team-1')).toContainText('Projected 0-1, 2nd place');
  await expect(page.getByRole('table', { name: 'Projected standings' })).toContainText('The Spreadsheet1-0A');
  await page.getByRole('tab', { name: 'Board' }).click();
  await expect(page.getByTestId('cell-1')).toHaveAttribute('title', reason);
});

test('a human on the clock drafts a player from the board', async ({ page }) => {
  const { posted } = draftApi(page);
  await page.goto('/leagues/L1/draft');
  await expect(page.getByText('You are on the clock!')).toBeVisible();
  await expect(page.getByTestId('youre-up')).toHaveText("You're up!");
  await expect(page.getByTestId('ticker-1')).toContainText('C. McCaffrey');
  await expect(page.getByTestId('pick-clock')).toHaveText(/^1:(2\d|30)$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Draft Day League' })).toBeVisible();
  await expect(page.getByTestId('draft-updates')).toHaveText('Refreshing every 3s');

  // Line up a queue, then draft from it.
  await expect(page.getByTestId('queue-hint')).toHaveCount(0);
  await page.getByRole('button', { name: 'Queue CeeDee Lamb' }).click();
  await page.getByRole('button', { name: "Queue Ja'Marr Chase" }).click();
  await page.getByRole('tab', { name: 'Queue' }).click();
  await page.getByRole('button', { name: "Move Ja'Marr Chase up" }).click();
  await expect(page.getByRole('list', { name: 'Your queue' }).getByRole('listitem').first()).toContainText(
    "1.WRJa'Marr Chase"
  );
  await page.getByRole('button', { name: "Draft Ja'Marr Chase from the queue" }).click();

  await expect(page.getByTestId('ticker-2')).toContainText('J. Chase');
  await page.getByRole('tab', { name: 'Board' }).click();
  await expect(page.getByTestId('cell-2')).toHaveText('J. ChaseWR · CIN');
  await expect(page.getByText('You are on the clock!')).toHaveCount(0);
  await expect(page.getByTestId('your-next-pick')).toHaveText('Your pick #3 in 1 pick');
  // Drafted players leave the queue; the rest stays on the server, across a reload.
  await expect(page.getByRole('list', { name: 'Your queue' })).not.toContainText("Ja'Marr Chase");
  await page.getByRole('tab', { name: 'My roster' }).click();
  await expect(page.getByRole('list', { name: 'Your roster' })).toContainText("Ja'Marr Chase");
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Queue' })).toHaveText('Queue (1)');
  await page.getByRole('tab', { name: 'Queue' }).click();
  await expect(page.getByRole('list', { name: 'Your queue' })).toContainText('CeeDee Lamb');
  expect(posted).toEqual([{ body: { playerId: 'fx-chase', pick: 2 }, key: expect.any(String) }]);
});

test('when the clock runs out, autopick takes your first queued player', async ({ page }) => {
  const api = draftApi(page, { pickSeconds: 4 });
  await page.goto('/leagues/L1/draft');
  await expect(page.getByText('You are on the clock!')).toBeVisible();
  // Chase is the best available, but Allen queues Lamb.
  await page.getByRole('button', { name: 'Queue CeeDee Lamb' }).click();
  await page.getByRole('tab', { name: 'Queue' }).click();
  await expect(page.getByRole('list', { name: 'Your queue' })).toContainText('1.WRCeeDee Lamb');
  await expect.poll(() => api.queue()).toEqual(['fx-lamb']);
  await expect(page.getByTestId('pick-clock')).toHaveText('0:00', { timeout: 10_000 });

  api.expire();
  await expect(page.getByTestId('ticker-2')).toContainText('auto', { timeout: 10_000 });
  await expect(page.getByTestId('queue-hint')).toBeVisible();
  await page.getByRole('tab', { name: 'Board' }).click();
  await expect(page.getByTestId('cell-2')).toHaveText('C. LambWR · DAL · auto');
  await page.getByRole('tab', { name: 'My roster' }).click();
  await expect(page.getByRole('list', { name: 'Your roster' })).toContainText('CeeDee Lamb');
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

  // The countdown runs out and the room replaces the lobby, no reload.
  await expect(page.getByText('You are on the clock!')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('draft-lobby')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Queue' })).toHaveText('Queue (1)');
  await page.getByRole('tab', { name: 'Queue' }).click();
  await expect(page.getByRole('list', { name: 'Your queue' })).toContainText('1.WRCeeDee Lamb');
});

test('the draft room fits a desktop screen, with the chat a tab away', async ({ page }) => {
  draftApi(page);
  await page.route('**/api/v1/leagues/L1/chat/**', (route) =>
    route.fulfill({
      json: {
        data: route.request().url().includes('/rooms')
          ? { defaultRoomId: 'trash-talk', rooms: [] }
          : {
              messages: [
                {
                  id: 'm1',
                  leagueId: 'L1',
                  roomId: 'draft',
                  kind: 'agent',
                  author: { teamId: 'team-2', teamName: 'The Spreadsheet', name: 'Sheets', avatarSeed: 's' },
                  text: 'Took the best back on the board. Your move.',
                  mentionedTeamIds: [],
                  event: null,
                  createdAt: new Date().toISOString()
                }
              ],
              nextCursor: null
            },
        league: null,
        warnings: []
      }
    })
  );
  // The league's teams, for @mentions.
  await page.route('**/api/v1/leagues/L1', (route) =>
    route.fulfill({ json: { data: { teams: [] }, league: null, warnings: [] } })
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/leagues/L1/draft');
  await expect(page.getByTestId('draft-room')).toHaveAttribute('data-layout', 'wide');
  await expect(page.getByRole('table', { name: 'Best available' })).toBeVisible();
  // Everything on one screen: the page itself does not scroll; the panels do.
  const fits = async () =>
    page.evaluate(() => ({
      scroll: document.documentElement.scrollHeight - window.innerHeight,
      sideways: document.documentElement.scrollWidth - window.innerWidth
    }));
  await expect.poll(fits).toEqual({ scroll: 0, sideways: 0 });
  for (const id of ['draft-topbar', 'pick-ticker']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box !== null && box.y + box.height <= 900).toBe(true);
  }
  await expect(page.getByTestId('roster-needs')).toContainText('Need:');

  await page.getByRole('tab', { name: 'Chat' }).click();
  await expect(page.getByText('Took the best back on the board. Your move.')).toBeVisible();
  await page.getByRole('tab', { name: 'Board' }).click();
  await expect(page.getByRole('table', { name: 'Draft board' })).toBeVisible();
  await expect.poll(fits).toEqual({ scroll: 0, sideways: 0 });
});

test('the commissioner pauses a stalled draft and resumes it', async ({ page }) => {
  const { clock } = draftApi(page, { allowedActions: ['pause_draft', 'resume_draft', 'make_draft_pick'] });
  const posted: string[] = [];
  await page.route(/\/api\/v1\/leagues\/L1\/draft\/(pause|resume)$/, async (route) => {
    const action = route.request().url().endsWith('/pause') ? 'pause' : 'resume';
    posted.push(action);
    clock.status = action === 'pause' ? 'paused' : 'in_progress';
    await route.fulfill({
      json: { data: { status: clock.status, deadline: null, secondsLeft: 60 }, league: null, warnings: [] }
    });
  });
  await page.goto('/leagues/L1/draft');
  await page.getByRole('button', { name: 'Pause draft' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pause the draft?' });
  await expect(dialog).toContainText('The pick clock freezes for everyone');
  await dialog.getByRole('button', { name: 'Pause draft' }).click();
  await expect(page.getByTestId('draft-topbar')).toContainText('Paused');
  await expect(page.getByText('The commissioner paused the draft. The clock is frozen.')).toBeVisible();
  await page.getByRole('button', { name: 'Resume draft' }).click();
  await expect(page.getByRole('button', { name: 'Pause draft' })).toBeVisible();
  expect(posted).toEqual(['pause', 'resume']);
});
