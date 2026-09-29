import { expect, test, type Page, type Route } from '@playwright/test';
import { serveAuthConfig } from './support';

/**
 * The roster workspace (#205) in a real browser at desktop size: add a free agent with a drop
 * without leaving the page, claim a waiver player and edit the bid, drop from the roster, and open
 * the market filtered from a roster need. Adds and drops change a roster, and the seeded in-season
 * league is shared with the lineup specs, so the league API here is a stateful fake behind
 * page.route answering with the documented envelopes (the server side is covered by
 * packages/server/test/integration/market-flows.test.ts). The phone sheet runs against the real
 * server in mobile.pw.ts.
 */

const b64 = (value: string) => Buffer.from(value).toString('base64url');
const ID_TOKEN = [
  b64(JSON.stringify({ alg: 'none' })),
  b64(JSON.stringify({ sub: 'alice', email: 'alice@example.com', given_name: 'Alice' })),
  'sig'
].join('.');

const CLEARS = '2026-09-16T08:00:00.000Z';
const ref = (id: string, name: string, position: string, team = 'SF') => ({ id, name, team, position });

const game = (opponent: string | null) => ({
  state: opponent === null ? 'bye' : 'upcoming',
  opponent,
  home: opponent === null ? null : true,
  kickoff: opponent === null ? null : '2026-09-13T17:00:00.000Z',
  period: null,
  clock: null,
  teamScore: null,
  opponentScore: null,
  possession: false,
  redZone: false,
  progress: null
});

interface Player {
  ref: ReturnType<typeof ref>;
  slot: string;
  proj: number;
  bye?: boolean;
}

function fakeLeague() {
  const roster: Player[] = [
    { ref: ref('fx-jallen', 'Josh Allen', 'QB', 'BUF'), slot: 'QB', proj: 22 },
    { ref: ref('fx-cmc', 'Christian McCaffrey', 'RB'), slot: 'RB', proj: 18 },
    { ref: ref('fx-kwalker', 'Kenneth Walker', 'RB', 'SEA'), slot: 'RB', proj: 0, bye: true },
    { ref: ref('fx-chase', "Ja'Marr Chase", 'WR', 'CIN'), slot: 'WR', proj: 16 },
    { ref: ref('fx-swift', "D'Andre Swift", 'RB', 'CHI'), slot: 'BN', proj: 5 }
  ];
  const market = [
    { ref: ref('fx-bijan', 'Bijan Robinson', 'RB', 'ATL'), proj: 15.1, standing: { status: 'free_agent' } },
    {
      ref: ref('fx-bhall', 'Breece Hall', 'RB', 'NYJ'),
      proj: 13.4,
      standing: { status: 'waivers', clearsAt: CLEARS }
    },
    { ref: ref('fx-lamb', 'CeeDee Lamb', 'WR', 'DAL'), proj: 17.2, standing: { status: 'free_agent' } }
  ];
  const claims: Record<string, unknown>[] = [];
  const moves: Record<string, unknown>[] = [];
  const bodies: { method: string; path: string; body: unknown }[] = [];
  const marketQueries: URLSearchParams[] = [];

  const entry = (p: Player) => ({
    player: p.ref,
    slot: p.slot,
    status: 'active',
    injuryStatus: null,
    byeWeek: p.bye ? 3 : 9,
    onBye: p.bye === true,
    kickoff: p.bye ? null : '2026-09-13T17:00:00.000Z',
    opponent: p.bye ? null : { team: 'MIA', home: true },
    locked: false,
    projectedPoints: p.proj,
    points: null,
    seasonAverage: { average: p.proj - 1, games: 2 },
    game: game(p.bye ? null : 'MIA')
  });
  const ok = (route: Route, data: unknown) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data, league: null, warnings: [] })
    });
  const full = () => roster.length >= 5;

  async function handle(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    const body = request.postDataJSON() as Record<string, unknown> | null;
    if (method !== 'GET') bodies.push({ method, path, body });
    if (path === '/leagues/L1/state') {
      return ok(route, {
        leagueId: 'L1',
        name: 'Workspace League',
        phase: 'regular_season',
        week: 3,
        youAreCommissioner: false,
        yourTeam: { id: 'team-1', name: 'Alice FC' },
        allowedActions: [
          'claim_waiver',
          'drop_player',
          'set_lineup',
          'update_waiver_claim',
          'cancel_waiver_claim',
          'reorder_waiver_claims'
        ],
        teams: [
          { id: 'team-1', name: 'Alice FC' },
          { id: 'team-2', name: 'Bob Squad' }
        ]
      });
    }
    if (path === '/leagues/L1/teams/team-1/roster') {
      return ok(route, {
        teamId: 'team-1',
        teamName: 'Alice FC',
        week: 3,
        lineupSaved: true,
        carriedFromWeek: null,
        projectedPoints: 61,
        slots: [
          { slot: 'QB', count: 1 },
          { slot: 'RB', count: 2 },
          { slot: 'WR', count: 1 },
          { slot: 'BN', count: 1 }
        ],
        players: roster.map(entry)
      });
    }
    if (path === '/leagues/L1/players') {
      marketQueries.push(url.searchParams);
      const position = url.searchParams.get('position');
      const rows = market
        .filter(
          (m) =>
            position === null ||
            m.ref.position === position ||
            (position === 'FLEX' && m.ref.position !== 'QB')
        )
        .map((m) => ({
          player: m.ref,
          availability: m.standing,
          status: 'active',
          injuryStatus: null,
          byeWeek: 7,
          game: game('GB'),
          projectedPoints: m.proj,
          projectedRos: m.proj * 14,
          seasonPoints: m.proj * 2,
          average: m.proj - 0.5,
          games: 2,
          trend: { adds: 3200, drops: 100 }
        }));
      return ok(route, {
        season: 2026,
        week: 3,
        total: rows.length,
        nextOffset: null,
        trendHours: 24,
        waiverType: 'faab',
        faabRemaining: 100,
        dropClearsAt: CLEARS,
        players: rows
      });
    }
    if (path === '/leagues/L1/waivers/preview') {
      const drop = url.searchParams.get('dropPlayerId');
      const bid = Number(url.searchParams.get('bid') ?? 0);
      const blocked = full() && drop === null;
      const waivers = url.searchParams.get('playerId') === 'fx-bhall';
      return ok(route, {
        wouldSucceed: !blocked,
        outcome: blocked ? 'blocked' : waivers ? 'claim_pending' : 'add_now',
        issues: blocked
          ? [{ code: 'ROSTER_FULL', message: 'Your roster is full.', fix: 'Pick a drop.' }]
          : [],
        processesAt: waivers ? CLEARS : null,
        faabRemaining: 100,
        faabAfter: 100 - bid
      });
    }
    if (path === '/leagues/L1/waivers/claims' && method === 'POST') {
      const pick = market.find((m) => m.ref.id === body?.playerId);
      const drop = roster.find((p) => p.ref.id === body?.dropPlayerId);
      if (pick === undefined) return route.fulfill({ status: 404 });
      if (pick.standing.status === 'waivers') {
        const claim = {
          id: `claim-${claims.length + 1}`,
          teamName: 'Alice FC',
          player: pick.ref,
          drop: drop?.ref ?? null,
          bid: body?.bid ?? 0,
          priority: claims.length + 1,
          status: 'pending',
          processesAt: CLEARS
        };
        claims.push(claim);
        return ok(route, {
          outcome: 'claim_pending',
          player: pick.ref,
          dropped: claim.drop,
          claim,
          faabRemaining: 100
        });
      }
      if (drop !== undefined) roster.splice(roster.indexOf(drop), 1);
      roster.push({ ref: pick.ref, slot: 'BN', proj: pick.proj });
      market.splice(market.indexOf(pick), 1);
      moves.unshift({
        id: `m${moves.length}`,
        at: '2026-09-11T12:00:00.000Z',
        week: 3,
        type: 'add',
        teamId: 'team-1',
        teamName: 'Alice FC',
        added: pick.ref,
        dropped: drop?.ref ?? null,
        cost: null
      });
      return ok(route, {
        outcome: 'added',
        player: pick.ref,
        dropped: drop?.ref ?? null,
        claim: null,
        faabRemaining: 100
      });
    }
    if (path === '/leagues/L1/waivers/claims') return ok(route, { claims });
    if (path.startsWith('/leagues/L1/waivers/claims/') && method === 'PATCH') {
      const claim = claims.find((c) => path.endsWith(String(c.id))) as Record<string, unknown>;
      if (typeof body?.bid === 'number') claim.bid = body.bid;
      return ok(route, { claim });
    }
    if (path === '/leagues/L1/drops') {
      const drop = roster.find((p) => p.ref.id === body?.playerId) as Player;
      roster.splice(roster.indexOf(drop), 1);
      moves.unshift({
        id: `m${moves.length}`,
        at: '2026-09-11T13:00:00.000Z',
        week: 3,
        type: 'drop',
        teamId: 'team-1',
        teamName: 'Alice FC',
        added: null,
        dropped: drop.ref,
        cost: null
      });
      return ok(route, { dropped: drop.ref, clearsAt: CLEARS, rosterSize: roster.length });
    }
    if (path === '/leagues/L1/transactions') return ok(route, { transactions: moves, nextCursor: null });
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'ROUTE_NOT_FOUND', message: path, fix: 'Check the path.' } })
    });
  }
  return { handle, bodies, marketQueries };
}

async function openWorkspace(page: Page, path = '/leagues/L1/team/moves') {
  const league = fakeLeague();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setSystemTime(new Date('2026-09-11T12:00:00Z'));
  await serveAuthConfig(page);
  await page.route('**/api/v1/**', league.handle);
  await page.addInitScript((token) => {
    localStorage.setItem(
      'rsc:auth',
      JSON.stringify({ idToken: token, refreshToken: 'refresh', expiresAt: 4_102_444_800_000 })
    );
  }, ID_TOKEN);
  await page.goto(path);
  await expect(page.getByRole('list', { name: 'Starters' })).toBeVisible();
  return league;
}

test('desktop: add a free agent with a drop without leaving the page', async ({ page }) => {
  const league = await openWorkspace(page);
  // The roster and the market side by side.
  const market = page.getByRole('list', { name: 'Available players' });
  await expect(market.getByText('Bijan Robinson')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add players' })).toHaveCount(0);

  await market.getByRole('button', { name: 'Add Bijan Robinson' }).click();
  const sheet = page.getByTestId('add-sheet');
  await expect(sheet.getByText('Your roster is full: pick who to drop')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Add player' })).toBeDisabled();
  await sheet.getByRole('radio', { name: /D'Andre Swift/ }).check();
  await expect(sheet.getByTestId('compare')).toContainText("− D'Andre Swift");
  await sheet.getByRole('button', { name: "Add, drop D'Andre Swift" }).click();

  await expect(page.getByText("Added Bijan Robinson, dropped D'Andre Swift.")).toBeVisible();
  await expect(page).toHaveURL(/\/team\/moves$/);
  await expect(page.getByRole('list', { name: 'Bench' })).toContainText('Bijan Robinson');
  await expect(page.getByRole('region', { name: 'Your moves' })).toContainText(
    "added Bijan Robinson, dropping D'Andre Swift"
  );
  const post = league.bodies.find((b) => b.path === '/leagues/L1/waivers/claims');
  expect(post?.body).toEqual({ playerId: 'fx-bijan', dropPlayerId: 'fx-swift' });
});

test('desktop: claim a waiver player, then edit the bid in place', async ({ page }) => {
  const league = await openWorkspace(page);
  const market = page.getByRole('list', { name: 'Available players' });
  await market.getByRole('button', { name: 'Claim Breece Hall' }).click();
  const sheet = page.getByTestId('add-sheet');
  await sheet.getByRole('radio', { name: /D'Andre Swift/ }).check();
  await sheet.getByLabel('FAAB bid ($)').fill('5');
  await expect(sheet.getByText('$100 left; $95 if this claim wins.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Place claim ($5)' }).click();
  await expect(page.getByText(/Claim placed for Breece Hall: processes/)).toBeVisible();

  const claims = page.getByTestId('pending-claims');
  await expect(claims).toContainText("Claiming Breece Hall, dropping D'Andre Swift · $5 bid");
  await claims.getByRole('button', { name: 'Edit' }).click();
  await claims.getByLabel('Bid ($)').fill('9');
  await claims.getByRole('button', { name: 'Save claim' }).click();
  await expect(page.getByText('Claim for Breece Hall updated.')).toBeVisible();
  await expect(claims).toContainText('$9 bid');
  const patch = league.bodies.find((b) => b.method === 'PATCH');
  expect(patch).toEqual({
    method: 'PATCH',
    path: '/leagues/L1/waivers/claims/claim-1',
    body: { bid: 9, dropPlayerId: 'fx-swift' }
  });
});

test('desktop: drop a player from the roster, confirmed in place', async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole('button', { name: "D'Andre Swift, BN: moves" }).click();
  await page.getByRole('button', { name: 'Drop', exact: true }).click();
  const confirm = page.getByRole('group', { name: "Drop D'Andre Swift?" });
  await expect(confirm).toContainText('He goes to waivers until');
  await confirm.getByRole('button', { name: "Drop D'Andre Swift" }).click();
  await expect(page.getByText(/^Dropped D'Andre Swift\./)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Bench' })).toContainText('Nobody on the bench.');
  await expect(page.getByRole('region', { name: 'Your moves' })).toContainText("dropped D'Andre Swift");
});

test('a roster need opens the market filtered, and so does a deep link', async ({ page }) => {
  const league = await openWorkspace(page);
  const needs = page.getByRole('region', { name: 'Roster needs' });
  await expect(needs).toContainText('RB2 Kenneth Walker is on bye: find a replacement');
  await needs.getByRole('button', { name: 'Find RB' }).click();
  await expect(page).toHaveURL(/\?market=RB$/);
  await expect(page.getByRole('button', { name: 'RB', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const market = page.getByRole('list', { name: 'Available players' });
  await expect(market.getByText('CeeDee Lamb')).toHaveCount(0);
  expect(league.marketQueries.at(-1)?.get('position')).toBe('RB');

  await page.goto('/leagues/L1/team/moves?market=WR');
  await expect(page.getByRole('button', { name: 'WR', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('list', { name: 'Available players' }).getByText('CeeDee Lamb')).toBeVisible();
});
