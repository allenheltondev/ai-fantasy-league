import { appendFileSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { handle, signInAs } from './support';

/**
 * The mobile regression guard (#138): every route and meaningful state at three phone widths, with
 * nothing wider than the screen. A page passes when the document does not scroll sideways and no
 * visible element pokes past either edge (unless a container that scrolls it sideways fits, as a
 * wide table in its own `overflow-x-auto` wrapper does; clipping does not count, since clipped
 * content is lost content). On failure the message lists the outermost offending elements: the
 * boundary where the layout first stopped fitting.
 *
 * Form fields are also checked for a 16px+ font (so iOS Safari does not zoom in on focus), and
 * buttons, tabs, nav links and fields for a 44px tap target.
 *
 * Runs against the local API server: a league made with the wizard (then drafted), and the seeded
 * in-season `demo-season` league (FANTASY_LOCAL_SEASON_DEMO in playwright.config.ts). Set
 * MOBILE_REPORT=<file> to also append one JSON line per page checked.
 */

const VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 430, height: 932 }
] as const;

const SEASON_WHO = 'season-e2e';

const nflGame = (away: string, home: string, extra: Record<string, unknown>) => ({
  gameId: `2026_01_${away}_${home}`,
  homeTeam: home,
  awayTeam: away,
  homeScore: 14,
  awayScore: 10,
  kickoff: '2026-09-13T17:00:00.000Z',
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

/** A busy Sunday for the live matchup: final, not started, a drive, and a red-zone trip. */
const NFL_GAMES = [
  nflGame('KC', 'JAX', { state: 'post', status: 'Final', clock: null, homeScore: 24, awayScore: 27 }),
  nflGame('LAR', 'SF', {
    state: 'pre',
    status: '9/13 - 4:25 PM EDT',
    homeScore: null,
    awayScore: null,
    period: null,
    clock: null
  }),
  nflGame('WAS', 'NYG', { possessionTeam: 'WAS', downDistance: '1st & 10 at WAS 35', yardsToGoal: 65 }),
  nflGame('BUF', 'MIA', {
    possessionTeam: 'BUF',
    isRedZone: true,
    downDistance: '3rd & Goal at MIA 4',
    fieldPosition: 'MIA 4',
    yardsToGoal: 4
  }),
  nflGame('CIN', 'CLE', {}),
  nflGame('DET', 'GB', {}),
  nflGame('ATL', 'NO', {})
];

/** Scoring log entries for the live matchup (#162), long enough to test the row wrapping. */
const SCORING_LOG = (home: string, away: string) => {
  const entry = (
    at: string,
    teamId: string,
    player: Record<string, string>,
    extra: Record<string, unknown>
  ) => ({
    id: `${at}#${player.id}`,
    at,
    kind: 'live',
    teamId,
    teamName: teamId,
    slot: 'WR',
    starter: true,
    player,
    changes: [],
    summary: '+1 rec',
    points: 1,
    touchdown: false,
    ...extra
  });
  return [
    entry(
      '2026-09-13T18:44:00.000Z',
      home,
      { id: 'fx-jallen', name: 'Josh Allen', team: 'BUF', position: 'QB' },
      {
        summary: '+31 pass yds, +12 rush yds, +2 carries, +1 completion, +1 pass TD, +1 rush TD',
        points: 11.44,
        touchdown: true,
        // ESPN's play description (#164): long, so it has to wrap under the summary.
        play: {
          text: 'Josh Allen 12 Yd Run (Two-Point Pass Conversion: Josh Allen pass to Khalil Shakir is Good)'
        }
      }
    ),
    entry(
      '2026-09-13T18:30:00.000Z',
      away,
      { id: 'fx-lamar', name: 'Lamar Jackson', team: 'BAL', position: 'QB' },
      {
        kind: 'correction',
        summary: '-4 pass yds',
        points: -0.16
      }
    ),
    entry(
      '2026-09-13T18:02:00.000Z',
      home,
      { id: 'fx-bench', name: 'Amon-Ra St. Brown', team: 'DET', position: 'WR' },
      {
        starter: false,
        slot: 'BN',
        summary: '+1 rec, +18 rec yds',
        points: 2.3
      }
    )
  ];
};

interface Offender {
  element: string;
  x: number;
}

interface Measurement {
  innerWidth: number;
  scrollWidth: number;
  offenders: Offender[];
  smallInputs: string[];
  smallTargets: string[];
}

/**
 * Runs in the page: the document's width, the elements past either edge of a `width`-wide screen,
 * form fields under 16px, and controls under a 44px tap target.
 */
function measure(width: number): Measurement {
  const describe = (el: Element): string => {
    const id = el.id ? `#${el.id}` : '';
    const testId = el.getAttribute('data-testid');
    const label = el.getAttribute('aria-label');
    const classes = Array.from(el.classList).slice(0, 4).join('.');
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return [
      `${el.tagName.toLowerCase()}${id}${classes ? `.${classes}` : ''}`,
      testId ? `[data-testid=${testId}]` : '',
      label ? `[aria-label="${label}"]` : '',
      text ? ` "${text}"` : ''
    ].join('');
  };
  const visible = (el: Element): boolean => {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (el.closest('[inert], [aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const past = (r: DOMRect) => r.right > width + 1 || r.left < -1;
  /** An ancestor that scrolls sideways, and itself fits, contains the overflow. */
  const contained = (el: Element): boolean => {
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const x = getComputedStyle(a).overflowX;
      if ((x === 'auto' || x === 'scroll') && !past(a.getBoundingClientRect())) return true;
    }
    return false;
  };
  const over = new Set<Element>();
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (!past(el.getBoundingClientRect())) continue;
    if (!visible(el) || contained(el)) continue;
    over.add(el);
  }
  const offenders = Array.from(over)
    .filter((el) => !el.parentElement || !over.has(el.parentElement))
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { element: describe(el), x: Math.round(r.right > width + 1 ? r.right : r.left) };
    });
  const fields = Array.from(document.querySelectorAll('input, select, textarea')).filter((el) => {
    const type = el.getAttribute('type');
    return type !== 'checkbox' && type !== 'radio' && type !== 'hidden' && visible(el);
  });
  const smallInputs = fields.filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).map(describe);
  const controls = Array.from(document.querySelectorAll('button, [role="tab"], nav a, a.btn')).filter(
    visible
  );
  const smallTargets = [...controls, ...fields]
    .filter((el) => el.getBoundingClientRect().height < 43.5)
    .map((el) => `${Math.round(el.getBoundingClientRect().height)}px ${describe(el)}`);
  return {
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    offenders,
    smallInputs,
    smallTargets
  };
}

/**
 * Asserts `page` fits its viewport right now, recording the result under `name`. A phone zooms a
 * page out to fit content wider than the screen, which widens `innerWidth` to match; so the page
 * fits when neither the document nor `innerWidth` is wider than the viewport it was given.
 */
async function expectFits(page: Page, name: string): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  // Let fonts, transitions and late layout settle.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  const m = await page.evaluate(measure, width);
  // MOBILE_SHOTS=<dir>: a full-page screenshot of every state, to look at by eye.
  if (process.env.MOBILE_SHOTS)
    await page.screenshot({
      path: `${process.env.MOBILE_SHOTS}/${width}-${name.replace(/\W+/g, '_')}.png`,
      fullPage: true
    });
  const report = process.env.MOBILE_REPORT;
  if (report) appendFileSync(report, `${JSON.stringify({ page: name, viewport: width, ...m })}\n`);
  const where = `${name} at ${width}px`;
  const list = m.offenders.map((o) => `  x=${o.x} ${o.element}`).join('\n');
  expect
    .soft(m.scrollWidth, `${where}: the page scrolls sideways. Offenders:\n${list}`)
    .toBeLessThanOrEqual(m.innerWidth);
  expect.soft(m.innerWidth, `${where}: the page zoomed out to fit. Offenders:\n${list}`).toBe(width);
  expect.soft(m.offenders, `${where}: elements past the screen's edge:\n${list}`).toEqual([]);
  expect.soft(m.smallInputs, `${where}: form fields under 16px (iOS zooms on focus)`).toEqual([]);
  expect.soft(m.smallTargets, `${where}: controls under a 44px tap target`).toEqual([]);
}

async function phone(browser: Browser, viewport: (typeof VIEWPORTS)[number], who: string) {
  const context = await browser.newContext({
    viewport,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2
  });
  await signInAs(context, who);
  return context;
}

/** Calls the local API as `who` (through the dev server's /api proxy). */
async function callApi(context: BrowserContext, who: string, path: string) {
  const response = await context.request.post(`/api/v1${path}`, {
    data: {},
    headers: {
      authorization: `Bearer dev:${who}`,
      'idempotency-key': `mobile-${Date.now()}-${Math.random()}`
    }
  });
  expect(response.ok(), await response.text()).toBe(true);
}

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.width}x${viewport.height}`, () => {
    test('the wizard, settings, invites, join, my leagues and a live draft fit the screen', async ({
      browser
    }) => {
      test.setTimeout(120_000);
      const alice = handle(`m${viewport.width}a`);
      const bob = handle(`m${viewport.width}b`);
      const context = await phone(browser, viewport, alice);
      const page = await context.newPage();

      // Wizard step 1: the league, with the most teams.
      await page.goto('/leagues/new');
      await expect(page.getByLabel('League name')).toBeVisible();
      await page.getByLabel('Teams').selectOption('12');
      await expectFits(page, 'create: league');
      await page.getByRole('button', { name: 'Next' }).click();

      // Seats: every seat but yours goes to an AI manager.
      await expect(page.getByTestId('seat-split')).toHaveText('1 human, 11 AI');
      await expectFits(page, 'create: seats');
      await page.getByRole('button', { name: 'Next' }).click();

      // AI managers: a card per seat, then one card's advanced controls open.
      await expect(page.getByTestId('agent-card')).toHaveCount(11);
      await expectFits(page, 'create: AI managers');
      await page.getByTestId('agent-card').first().getByRole('button', { name: 'Advanced' }).click();
      const drawer = page.getByRole('dialog');
      await expect(drawer.getByLabel('Strategy')).toBeVisible();
      await expectFits(page, 'create: AI manager advanced');
      await drawer.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      // One-handed, deep in the list: tap a card's difficulty and Shuffle, with Next pinned on screen
      // the whole way down (the wizard's primary action never scrolls away).
      const next = page.getByRole('button', { name: 'Next' });
      await expect(next).toBeInViewport();
      const last = page.getByTestId('agent-card').last();
      await last.scrollIntoViewIfNeeded();
      await last.getByLabel('Difficulty', { exact: true }).selectOption('rookie');
      await expect(last.getByTestId('difficulty-pill')).toHaveText('Rookie');
      const before = await last.getAttribute('aria-label');
      await last.getByRole('button', { name: 'Shuffle' }).tap();
      await expect(page.getByTestId('agent-card').last()).not.toHaveAttribute('aria-label', before ?? '');
      await expect(next).toBeInViewport();
      for (const control of [
        next,
        last.getByRole('button', { name: 'Shuffle' }),
        last.getByRole('button', { name: 'Advanced' }),
        last.getByLabel('Difficulty', { exact: true })
      ]) {
        expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
      // The manager's name (#159): rename inline and reroll, with thumb-sized controls, still fitting.
      for (const name of [/^Rename /, /^Reroll name for /, /^New avatar for /]) {
        const box = await last.getByRole('button', { name }).boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      }
      await last.getByRole('button', { name: /^Rename / }).tap();
      await last.getByLabel('Manager name').fill('Wilhelmina "Double Time" Fitzgerald');
      await expectFits(page, 'create: AI manager rename');
      await last.getByRole('button', { name: 'Save name' }).tap();
      await expect(last.getByRole('heading', { name: 'Wilhelmina "Double Time" Fitzgerald' })).toBeVisible();
      await expectFits(page, 'create: AI manager long name');

      // Back to Seats for a second person, so there is someone to invite; then Review.
      await page.getByRole('button', { name: 'Back' }).click();
      await page.getByLabel('Human seats').selectOption('2');
      await page.getByRole('button', { name: 'Next' }).click();
      await expect(page.getByTestId('agent-card')).toHaveCount(10);
      await page.getByRole('button', { name: 'Next' }).click();
      await expect(page.getByTestId('review')).toBeVisible();
      await expectFits(page, 'create: review');
      await page.getByRole('button', { name: 'Create league' }).click();

      // Settings for a league in setup: seats, AI managers, invites, rules; then AI activity.
      await expect(page).toHaveURL(/\/leagues\/[^/]+\/settings$/);
      const leagueId = new URL(page.url()).pathname.split('/')[2] as string;
      await expect(page.getByTestId('agent-card')).toHaveCount(10);
      await page.getByRole('button', { name: 'Create invite link' }).click();
      const link = await page.getByLabel('Invite link').inputValue();
      await expectFits(page, 'settings (setup): league settings');
      await page.getByRole('button', { name: 'AI activity' }).click();
      await expect(page.getByRole('heading', { name: 'Seat version history' })).toBeVisible();
      await expectFits(page, 'settings (setup): AI activity');

      // Join, as the second person.
      const friend = await phone(browser, viewport, bob);
      const bobPage = await friend.newPage();
      await bobPage.goto(new URL(link).pathname);
      await expect(bobPage.getByRole('button', { name: 'Join league' })).toBeVisible();
      await expectFits(bobPage, 'join');
      await bobPage.getByRole('button', { name: 'Join league' }).click();
      await expect(bobPage).toHaveURL(/\/settings$/);
      await friend.close();

      // My leagues, with the league's dashboard before the draft (#166): seats filled, the lobby.
      await page.goto('/');
      await expect(page.getByRole('list', { name: 'Leagues' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Draft' })).toContainText('seats filled');
      await expectFits(page, 'my leagues');

      // The draft lobby before the draft (#134): a countdown to a scheduled start (ten days after the
      // local API's pinned clock), the order, who's here, and your queue.
      const scheduled = await context.request.patch(`/api/v1/leagues/${leagueId}/settings`, {
        data: { changes: { draft: { scheduledAt: '2026-09-20T12:00:00.000Z' } } },
        headers: {
          authorization: `Bearer dev:${alice}`,
          'idempotency-key': `mobile-${Date.now()}-${Math.random()}`
        }
      });
      expect(scheduled.ok(), await scheduled.text()).toBe(true);
      await page.goto(`/leagues/${leagueId}/draft`);
      await expect(page.getByTestId('draft-countdown')).toHaveText(/^\d+d \d\d:\d\d:\d\d$/);
      await expect(
        page.getByRole('list', { name: 'Players to queue' }).getByRole('listitem').first()
      ).toBeVisible();
      await expectFits(page, 'draft lobby (countdown)');

      // The draft, in progress.
      await callApi(context, alice, `/leagues/${leagueId}/draft/start`);
      await page.goto(`/leagues/${leagueId}/draft`);
      await expect(page.getByRole('table', { name: 'Draft board' })).toBeVisible();
      await expectFits(page, 'draft (in progress)');
      // The league's Home while drafting: who is on the clock (#166).
      await page.goto(`/leagues/${leagueId}/home`);
      await expect(page.getByRole('region', { name: 'Draft' })).toContainText('On the clock');
      await expectFits(page, 'league home (drafting)');
      await page.goto(`/leagues/${leagueId}/draft`);

      // Draft research (#136): the best-available table, an open player card, and the depth chart.
      const firstAvailable = page.locator('[data-testid^="available-"]').first();
      await expect(firstAvailable).toBeVisible();
      await firstAvailable.getByRole('button').first().click();
      await expect(page.getByTestId('player-card')).toBeVisible();
      await expectFits(page, 'draft: player card');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('player-card')).toBeHidden();
      await page.getByRole('button', { name: 'Depth' }).click();
      await expect(page.getByRole('table', { name: 'Depth chart' })).toBeVisible();
      await expectFits(page, 'draft: depth chart');
      await context.close();
    });

    test('every in-season page fits the screen', async ({ browser }) => {
      test.setTimeout(120_000);
      const context = await phone(browser, viewport, SEASON_WHO);
      const page = await context.newPage();

      // League home is the dashboard (#166): the matchup strip, standings, and the move board.
      await page.goto('/leagues/demo-season');
      await expect(page).toHaveURL(/\/home$/);
      await expect(
        page.getByRole('region', { name: 'Matchups' }).locator('[data-yours="true"]')
      ).toBeVisible();
      await expect(page.getByRole('region', { name: 'Move board' })).toBeVisible();
      await expectFits(page, 'league home (dashboard)');
      await page.goto('/');
      await expect(page.getByRole('region', { name: 'Standings' })).toBeVisible();
      await expectFits(page, 'my leagues (in season)');

      await page.goto('/leagues/demo-season/matchup');
      await expect(page.getByRole('region', { name: `${SEASON_WHO}'s Team` })).toBeVisible();
      await expectFits(page, 'matchup');

      await page.goto('/leagues/demo-season/roster');
      await expect(page.getByRole('table', { name: 'Starters' })).toBeVisible();
      await expectFits(page, 'roster');

      await page.goto('/leagues/demo-season/standings');
      await expect(page.getByRole('table', { name: 'Standings' })).toBeVisible();
      await expectFits(page, 'standings');
      await page.getByRole('tab', { name: 'Playoffs' }).click();
      await expect(page.getByRole('region', { name: 'Championship bracket' })).toBeVisible();
      await expectFits(page, 'standings: playoffs');
      await page.getByRole('tab', { name: 'History' }).click();
      await expect(page.getByRole('heading', { name: 'Head to head' })).toBeVisible();
      await expectFits(page, 'standings: history');

      await page.goto('/leagues/demo-season/players');
      const claim = page.getByRole('button', { name: /^(Add|Claim) / }).first();
      await expect(claim).toBeVisible();
      await expectFits(page, 'players');
      if (await claim.isEnabled()) {
        await claim.click();
        await expectFits(page, 'players: claim panel');
      }

      await page.goto('/leagues/demo-season/trades');
      const builder = page.getByRole('region', { name: 'Trade builder' });
      await builder.getByLabel('Trade with').selectOption('team-2');
      await builder.getByLabel('You send: Patrick Mahomes').check();
      await builder.getByLabel('You receive: Lamar Jackson').check();
      await expect(page.getByRole('region', { name: 'Trade preview' })).toContainText('This trade is legal.');
      await expectFits(page, 'trades (builder and preview)');

      await page.goto('/leagues/demo-season/chat');
      await expect(page.getByLabel('Chat messages')).toBeVisible();
      await expectFits(page, 'chat');
      // Chat rooms (#144): the room sheet, a room with an announcement, and a new DM.
      await page.getByRole('button', { name: /Chat room: Trash Talk/ }).tap();
      const sheet = page.getByRole('dialog');
      await expect(sheet.getByRole('heading', { name: 'Direct messages' })).toBeVisible();
      await expectFits(page, 'chat: room sheet');
      await sheet.getByRole('button', { name: '+ New message' }).tap();
      await expectFits(page, 'chat: room sheet, new message');
      await sheet.getByRole('button', { name: /^# Draft/ }).tap();
      await expect(page.getByRole('article', { name: 'League announcement: Draft Completed' })).toBeVisible();
      await expectFits(page, 'chat: #Draft');
      await page.goto('/leagues/demo-season/chat?room=dm-team-1-team-2');
      await expect(page.getByRole('heading', { name: 'Team 2', level: 2 })).toBeVisible();
      await expectFits(page, 'chat: DM');

      // The section nav is one row that scrolls sideways: Settings, off to the right, is a tap away.
      const sections = page.getByRole('navigation', { name: 'League sections' });
      expect((await sections.boundingBox())?.height ?? 0).toBeLessThan(80);
      await sections.getByRole('link', { name: 'Settings' }).tap();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(sections.getByRole('link', { name: 'Settings' })).toBeInViewport();
      await expect(page.getByRole('heading', { name: 'Rules' })).toBeVisible();
      await expectFits(page, 'settings (season): league settings');
      const aiTab = page.getByRole('button', { name: 'AI activity' });
      if ((await aiTab.count()) > 0) {
        await aiTab.click();
        await expect(page.getByRole('heading', { name: 'Seat version history' })).toBeVisible();
        await expectFits(page, 'settings (season): AI activity');
      }
      await context.close();
    });

    test('a live matchup fits the screen', async ({ browser }) => {
      const context = await phone(browser, viewport, SEASON_WHO);
      const page = await context.newPage();
      // The seeded clock is before kickoff: play the real matchup as live (as delight.pw.ts does).
      const live = { matchupId: '', home: '', away: '' };
      await page.route(/\/api\/v1\/leagues\/demo-season\/matchup(\?|$)/, async (route) => {
        const response = await route.fetch({
          headers: { ...route.request().headers(), authorization: `Bearer dev:${SEASON_WHO}` }
        });
        const body = (await response.json()) as {
          data: {
            matchup: {
              id: string;
              status: string;
              home: { teamId: string; score: number | null };
              away: { teamId: string; score: number | null };
            };
          };
        };
        live.matchupId = body.data.matchup.id;
        live.home = body.data.matchup.home.teamId;
        live.away = body.data.matchup.away.teamId;
        body.data.matchup.status = 'in_progress';
        body.data.matchup.home.score = 88.4;
        body.data.matchup.away.score = 101.25;
        await route.fulfill({ response, json: body });
      });
      // And the week's NFL games live, with Buffalo (Josh Allen) in the red zone (#132).
      await page.route(/\/api\/v1\/leagues\/demo-season\/nfl-games(\?|$)/, (route) =>
        route.fulfill({
          json: {
            data: {
              season: 2026,
              week: 1,
              games: NFL_GAMES,
              redZone: [{ team: 'BUF', downDistance: '3rd & Goal at MIA 4', fieldPosition: 'MIA 4' }],
              updatedAt: '2026-09-13T18:30:00.000Z'
            },
            league: null,
            warnings: []
          }
        })
      );
      // And a busy scoring log (#162): a long touchdown line with its play (#164), a correction,
      // and the bench.
      await page.route(/\/api\/v1\/leagues\/demo-season\/matchup\/scoring-log/, (route) =>
        route.fulfill({
          json: {
            data: {
              week: 1,
              teamId: live.home,
              matchupId: live.matchupId,
              entries: SCORING_LOG(live.home, live.away),
              nextCursor: 'older'
            },
            league: null,
            warnings: []
          }
        })
      );
      await page.goto('/leagues/demo-season/matchup');
      await expect(
        page.getByRole('region', { name: `${SEASON_WHO}'s Team` }).getByTestId(/^score-/)
      ).toHaveText(/\d+\.\d\d/);
      const plays = page.getByRole('list', { name: 'Scoring plays, newest first' }).getByRole('listitem');
      await expect(plays).toHaveCount(2);
      await page.getByRole('checkbox', { name: 'Include bench' }).check();
      await expect(plays).toHaveCount(3);
      await expect(page.getByText('3rd & Goal at MIA 4').first()).toBeVisible();
      await expect(plays.first().getByTestId('log-play')).toContainText('Josh Allen 12 Yd Run');
      await expectFits(page, 'matchup (live)');
      await context.close();
    });

    test('a busy league dashboard fits the screen', async ({ browser }) => {
      const context = await phone(browser, viewport, SEASON_WHO);
      const page = await context.newPage();
      // The real dashboard, played live and after a busy week of moves (#166): a trade with long
      // names on both sides, a waiver award, an add/drop, and a champion.
      await page.route(/\/api\/v1\/leagues\/demo-season\/dashboard(\?|$)/, async (route) => {
        const response = await route.fetch({
          headers: { ...route.request().headers(), authorization: `Bearer dev:${SEASON_WHO}` }
        });
        const body = (await response.json()) as { data: Record<string, unknown> };
        const data = body.data as {
          matchups: { status: string; home: { score: number | null }; away: { score: number | null } }[];
          standings: { rows: Record<string, unknown>[] };
        };
        data.matchups.forEach((m, i) => {
          m.status = 'in_progress';
          m.home.score = 101.25 + i;
          m.away.score = 88.4;
        });
        const rows = data.standings.rows;
        const side = (row: Record<string, unknown> | undefined, extra: Record<string, unknown>) => ({
          teamId: row?.teamId,
          teamName: row?.teamName,
          ownerName: row?.ownerName,
          manager: row?.manager,
          added: [],
          dropped: [],
          cost: null,
          ...extra
        });
        const longName = {
          id: 'fx-long',
          name: 'Christopher Maximilian Longname-Smithson',
          team: 'JAX',
          position: 'WR'
        };
        const other = { id: 'fx-other', name: 'Amon-Ra St. Brown', team: 'DET', position: 'WR' };
        body.data.moves = [
          {
            id: 'tr-busy',
            type: 'trade',
            at: '2026-09-10T12:00:00.000Z',
            week: 1,
            teams: [
              side(rows[0], { added: [longName, other] }),
              side(rows[1], { added: [other], dropped: [longName] })
            ]
          },
          {
            id: 'w-busy',
            type: 'waiver',
            at: '2026-09-10T11:00:00.000Z',
            week: 1,
            teams: [side(rows[2], { added: [longName], cost: 37 })]
          },
          {
            id: 'a-busy',
            type: 'add',
            at: '2026-09-10T10:00:00.000Z',
            week: 1,
            teams: [side(rows[3], { added: [other], dropped: [longName] })]
          }
        ];
        body.data.hasMoreMoves = true;
        body.data.champion = side(rows[1], {});
        await route.fulfill({ response, json: body });
      });
      await page.goto('/leagues/demo-season/home');
      await expect(page.getByRole('region', { name: 'Champion' })).toBeVisible();
      await expect(page.getByRole('article', { name: /^Trade: / })).toContainText('Longname-Smithson');
      await expect(page.getByRole('button', { name: 'Show more' })).toBeVisible();
      await expectFits(page, 'league home (busy)');
      await context.close();
    });
  });
}
