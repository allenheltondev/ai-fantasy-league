import { expect, test, type Route } from '@playwright/test';
import { serveAuthConfig } from './support';

/**
 * The players page end to end in a real browser: search, then claim a player on waivers with a drop
 * and a FAAB bid, and see it in My claims. A league only reaches the season (and waivers) after a
 * draft, which the local API cannot run yet, so the league API here is a stateful fake behind
 * page.route answering with the documented envelopes. Once the draft lands, drive this against the
 * local server like league-setup.pw.ts.
 */

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

const ID_TOKEN = [
  base64url(JSON.stringify({ alg: 'none' })),
  base64url(JSON.stringify({ sub: 'alice', email: 'alice@example.com', given_name: 'Alice' })),
  'sig'
].join('.');

const ref = (id: string, name: string, position: string) => ({ id, name, team: 'SF', position });

interface FakeClaim {
  id: string;
  teamName: string;
  player: ReturnType<typeof ref>;
  drop: ReturnType<typeof ref> | null;
  bid: number;
  priority: number;
  status: string;
  processesAt: string;
}

test('a manager claims a player on waivers with a drop and a FAAB bid', async ({ page }) => {
  const claims: FakeClaim[] = [];
  const posted: unknown[] = [];
  const roster = [ref('fx-jallen', 'Josh Allen', 'QB'), ref('fx-swift', "D'Andre Swift", 'RB')];
  const players = [
    {
      ...ref('fx-cmc', 'Christian McCaffrey', 'RB'),
      availability: { status: 'waivers', clearsAt: '2026-09-12T12:00:00.000Z' }
    },
    { ...ref('fx-bijan', 'Bijan Robinson', 'RB'), availability: { status: 'free_agent' } }
  ];
  const ok = (route: Route, data: unknown) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data, league: null, warnings: [] })
    });

  await serveAuthConfig(page);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    if (path === '/leagues/L1/state') {
      return ok(route, {
        yourTeam: { id: 'team-1', name: 'Alice FC', faabRemaining: 100 },
        allowedActions: ['claim_waiver', 'cancel_waiver_claim'],
        teams: [{ id: 'team-1', name: 'Alice FC' }]
      });
    }
    if (path === '/players') {
      const q = url.searchParams.get('q') ?? '';
      return ok(route, { players: players.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) });
    }
    if (path === '/leagues/L1/waivers/preview') {
      const drop = url.searchParams.get('dropPlayerId');
      const bid = Number(url.searchParams.get('bid') ?? 0);
      return ok(route, {
        wouldSucceed: drop !== null,
        outcome: drop === null ? 'blocked' : 'claim_pending',
        issues:
          drop === null
            ? [{ code: 'ROSTER_FULL', message: 'Your roster is full.', fix: 'Pick a drop.' }]
            : [],
        processesAt: drop === null ? null : '2026-09-13T08:00:00.000Z',
        currentRoster: roster,
        resultingRoster: roster,
        faabRemaining: 100,
        faabAfter: 100 - bid
      });
    }
    if (path === '/leagues/L1/waivers/claims' && request.method() === 'POST') {
      const body = request.postDataJSON() as { playerId: string; bid: number; dropPlayerId: string };
      posted.push(body);
      expect(request.headers()['idempotency-key']).toBeTruthy();
      const claim: FakeClaim = {
        id: 'claim-1',
        teamName: 'Alice FC',
        player: ref('fx-cmc', 'Christian McCaffrey', 'RB'),
        drop: roster.find((p) => p.id === body.dropPlayerId) ?? null,
        bid: body.bid,
        priority: 1,
        status: 'pending',
        processesAt: '2026-09-13T08:00:00.000Z'
      };
      claims.push(claim);
      return ok(route, {
        outcome: 'claim_pending',
        player: claim.player,
        dropped: claim.drop,
        claim,
        faabRemaining: 100
      });
    }
    if (path === '/leagues/L1/waivers/claims') return ok(route, { claims });
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'ROUTE_NOT_FOUND', message: path, fix: 'Check the path.' } })
    });
  });
  await page.addInitScript((token) => {
    localStorage.setItem(
      'rsc:auth',
      JSON.stringify({ idToken: token, refreshToken: 'refresh', expiresAt: 4_102_444_800_000 })
    );
  }, ID_TOKEN);

  await page.goto('/leagues/L1/players');
  await expect(page.getByText('Alice FC: $100 FAAB left')).toBeVisible();
  await page.getByLabel('Search players').fill('mccaffrey');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('cell', { name: 'Bijan Robinson' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Claim Christian McCaffrey' }).click();
  const panel = page.getByRole('region', { name: 'Claim Christian McCaffrey' });
  await expect(panel.getByText('Your roster is full. Pick a drop.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Submit claim' })).toBeDisabled();
  await panel.getByLabel('Drop player').selectOption('fx-swift');
  await panel.getByLabel('FAAB bid').fill('17');
  await expect(panel.getByText('You have $100; $83 left if it wins.')).toBeVisible();
  await panel.getByRole('button', { name: 'Submit claim' }).click();

  await expect(
    page.getByText('Claim for Christian McCaffrey ($17) queued; it runs 2026-09-13 08:00 UTC.')
  ).toBeVisible();
  const myClaims = page.getByRole('region', { name: 'My claims' });
  await expect(myClaims.getByText(/Christian McCaffrey for \$17, dropping D'Andre Swift/)).toBeVisible();
  expect(posted).toEqual([{ playerId: 'fx-cmc', bid: 17, dropPlayerId: 'fx-swift' }]);
});
