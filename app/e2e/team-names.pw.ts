import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { serveAuthConfig } from './support';

/**
 * AI managers name their own teams (#194), against the agents dev server (its event loop runs the
 * agents on the fake model; see playwright.config.ts). A new league drafts to the end: the person's
 * picks through the API, the three AI managers' picks in process. After the draft every AI seat
 * still called "Team N" gets a name in its personality's style (the fake model picks from the
 * personality's own name list), and the move board shows each rename.
 *
 * The local clock is pinned in e2e, so the post-draft kickoff (scheduled a minute after the last
 * pick) never comes due here; the agent tests and the season replay cover that path. This spec
 * drives the other seat trigger: the commissioner changes each AI seat after the draft (`Agent Seat
 * Changed`), and the manager names its placeholder team right away.
 */

const AGENT_API = `http://127.0.0.1:${process.env.E2E_AGENT_API_PORT ?? Number(process.env.E2E_API_PORT ?? 8787) + 1}`;
const WHO = `names-${Date.now().toString(36)}`;
const AGENTS = ['team-2', 'team-3', 'team-4'];

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

let step = 0;
async function call<T = Record<string, unknown>>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown
): Promise<T> {
  const response = await request.fetch(`${AGENT_API}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer dev:${WHO}`,
      ...(method === 'GET' ? {} : { 'idempotency-key': `${WHO}-${++step}` })
    },
    ...(body === undefined ? {} : { data: body })
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return ((await response.json()) as { data: T }).data;
}

async function signIn(context: BrowserContext): Promise<void> {
  await serveAuthConfig(context);
  const claims = { sub: `local-${WHO}`, email: `${WHO}@localhost`, given_name: WHO };
  const idToken = [base64url('{"alg":"none"}'), base64url(JSON.stringify(claims)), 'sig'].join('.');
  const session = JSON.stringify({ idToken, refreshToken: 'refresh', expiresAt: 4_102_444_800 });
  await context.addInitScript((value) => localStorage.setItem('rsc:auth', value), session);
  await context.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({
      url: `${AGENT_API}${url.pathname}${url.search}`,
      headers: { ...route.request().headers(), authorization: `Bearer dev:${WHO}` }
    });
    await route.fulfill({ response });
  });
}

type Board = {
  status: string;
  onTheClock: { teamId: string; overall: number } | null;
  yourNeeds: string[];
  bestAvailable: { player: { id: string; position: string } }[];
};
type Team = { id: string; name: string; nameSetBy: string; renamedFrom: string | null };

test('after the draft, every AI manager names its placeholder team in character', async ({
  browser,
  request
}) => {
  test.setTimeout(180_000);
  const league = await call<{ id: string }>(request, 'POST', '/leagues', { name: 'Name Game', teamCount: 4 });
  const leagueId = league.id;
  await call(request, 'POST', `/leagues/${leagueId}/agents/randomize`, {
    teamIds: AGENTS,
    seed: 'names-e2e'
  });
  await call(request, 'POST', `/leagues/${leagueId}/draft/start`);

  // The person picks the best player for an open starting slot; the AI managers pick in process.
  for (let polls = 0; polls < 400; polls++) {
    const board = await call<Board>(request, 'GET', `/leagues/${leagueId}/draft?limit=40`);
    if (board.status === 'complete') break;
    if (board.onTheClock?.teamId === 'team-1') {
      const need = new Set(board.yourNeeds.flatMap((n) => (n === 'W/R/T' ? ['RB', 'WR', 'TE'] : [n])));
      const pick = board.bestAvailable.find((c) => need.has(c.player.position)) ?? board.bestAvailable[0];
      await call(request, 'POST', `/leagues/${leagueId}/draft/picks`, {
        playerId: pick?.player.id,
        pick: board.onTheClock.overall
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const teams = async () => (await call<{ teams: Team[] }>(request, 'GET', `/leagues/${leagueId}`)).teams;
  expect((await teams()).filter((t) => AGENTS.includes(t.id)).map((t) => t.name)).toEqual([
    'Team 2',
    'Team 3',
    'Team 4'
  ]);

  // The commissioner changes each AI seat after the draft; each manager names its team.
  for (const teamId of AGENTS) {
    const seat = await call<{ commissioner: { current: { config: Record<string, unknown> } } }>(
      request,
      'GET',
      `/leagues/${leagueId}/agents/${teamId}`
    );
    const config = seat.commissioner.current.config;
    await call(request, 'PUT', `/leagues/${leagueId}/agents/${teamId}`, {
      ...config,
      difficulty: config.difficulty === 'rookie' ? 'pro' : 'rookie'
    });
  }
  await expect
    .poll(
      async () => (await teams()).filter((t) => AGENTS.includes(t.id) && t.nameSetBy === 'agent').length,
      {
        timeout: 30_000
      }
    )
    .toBe(AGENTS.length);
  const named = (await teams()).filter((t) => AGENTS.includes(t.id));
  for (const t of named) {
    expect(t.name).not.toMatch(/^Team \d+$/);
    expect(t.renamedFrom).toBe(`Team ${t.id.slice('team-'.length)}`);
  }
  expect(new Set(named.map((t) => t.name)).size).toBe(AGENTS.length);

  // The move board shows each rename, and the chat carries the managers' announcements.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await signIn(context);
  const page = await context.newPage();
  await page.goto(`/leagues/${leagueId}`);
  const board = page.getByRole('region', { name: 'Move board' });
  const renames = board.getByTestId('move-team_renamed');
  await expect(renames).toHaveCount(AGENTS.length);
  for (const t of named) {
    await expect(
      board.getByRole('article', { name: `New team name: ${t.renamedFrom} is now ${t.name}` })
    ).toContainText(`Renamed from ${t.renamedFrom} by its AI manager`);
  }

  // Only the commissioner sees each seat's naming switch.
  await page.goto(`/leagues/${leagueId}/settings`);
  await expect(
    page
      .getByTestId('agent-card')
      .first()
      .getByRole('checkbox', { name: /Let this manager name its team/ })
  ).toBeChecked();
  await context.close();
});
