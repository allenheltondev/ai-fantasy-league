import type { Page } from '@playwright/test';

/**
 * A live draft room's API (#136), served with `page.route` in the shape of the draft, queue, card,
 * depth, and chat operations. The SPA runs for real; tests mutate the returned state to move the
 * draft along, deliver chat, or make queue saves fail.
 */

const AUTH_CONFIG = { region: 'us-east-1', userPoolId: 'us-east-1_e2e', clientId: 'e2e-client' };
const b64 = (value: string) => Buffer.from(value).toString('base64url');
const ID_TOKEN = [
  b64(JSON.stringify({ alg: 'none' })),
  b64(JSON.stringify({ sub: 'allen', email: 'allen@example.com', given_name: 'Allen', family_name: 'H' })),
  'sig'
].join('.');

const ref = (id: string, name: string, position: string, team: string) => ({ id, name, team, position });
export const CHASE = ref('fx-chase', "Ja'Marr Chase", 'WR', 'CIN');
export const LAMB = ref('fx-lamb', 'CeeDee Lamb', 'WR', 'DAL');
export const CMC = ref('fx-cmc', 'Christian McCaffrey', 'RB', 'SF');

const envelope = (data: unknown) => ({
  data,
  league: { id: 'L1', phase: 'drafting', week: null, allowedActions: [] },
  warnings: []
});

export function researchApi(page: Page) {
  // The draft room's chat: push onto `chat` to have the next poll deliver a message.
  const chat: unknown[] = [];
  void page.route('**/api/v1/leagues/L1/chat/messages?*', (route) =>
    route.fulfill({ json: envelope({ messages: chat, nextCursor: null }) })
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
  // Set `queue.failSaves` to have every PUT fail, as an outage would; `queue.saved()` is what the server holds.
  let queued: string[] = [];
  const known = [LAMB, CHASE, CMC];
  const queue = { failSaves: false, saved: () => queued };
  void page.route('**/api/v1/leagues/L1/draft/queue', async (route) => {
    if (route.request().method() === 'PUT' && queue.failSaves) {
      return route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE', message: 'The draft queue is unavailable.' } }
      });
    }
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
        httpHost: null,
        realtimeHost: null,
        channels: null,
        refreshAt: null,
        pollIntervalSeconds: 3
      })
    })
  );
  return { board, card, chat, queue };
}

/** Signs the browser in before the SPA boots. */
export async function signIn(page: Page): Promise<void> {
  await page.route('**/auth-config.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AUTH_CONFIG) })
  );
  await page.addInitScript((token) => {
    localStorage.setItem(
      'rsc:auth',
      JSON.stringify({ idToken: token, refreshToken: 'refresh', expiresAt: 4_102_444_800_000 })
    );
  }, ID_TOKEN);
}
