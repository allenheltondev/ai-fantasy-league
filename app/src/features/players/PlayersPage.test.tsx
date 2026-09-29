import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp, signInAs } from '../../test/render';
import { describeMove, MoveText } from './Transactions';
import { describeError, formatTime, type Claim, type SearchPlayer } from './types';

const ALICE = { sub: 'u1', email: 'alice@example.com', given_name: 'Alice' };
const ref = (id: string, name: string, position = 'RB') => ({ id, name, team: 'ATL', position });

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

/** A stateful fake of the waiver API the page calls. */
function fakeApi(
  options: { allowed?: string[]; fail?: Record<string, { status: number; code: string; fix: string }> } = {}
) {
  const calls: Call[] = [];
  const players: SearchPlayer[] = [
    { ...ref('fx-bijan', 'Bijan Robinson'), availability: { status: 'free_agent' } },
    {
      ...ref('fx-cmc', 'Christian McCaffrey'),
      availability: { status: 'waivers', clearsAt: '2026-09-12T12:00:00.000Z' }
    },
    { ...ref('fx-kelce', 'Travis Kelce', 'TE'), team: null },
    { ...ref('fx-lamb', 'CeeDee Lamb', 'WR'), availability: { status: 'rostered', teamId: 'team-2' } },
    { ...ref('fx-chase', "Ja'Marr Chase", 'WR'), availability: { status: 'rostered', teamId: 'team-9' } }
  ];
  let claims: Claim[] = [
    {
      id: 'c-1',
      teamName: 'Alice FC',
      player: ref('fx-hall', 'Breece Hall'),
      drop: ref('fx-jallen', 'Josh Allen', 'QB'),
      bid: 7,
      priority: 1,
      status: 'pending',
      processesAt: '2026-09-13T08:00:00.000Z'
    }
  ];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const ok = (data: unknown) => json({ data, league: null, warnings: [] });

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, path, query: url.searchParams, body });
    const failure = options.fail?.[`${method} ${path}`];
    if (failure) {
      return json(
        { error: { code: failure.code, message: `${failure.code} happened.`, fix: failure.fix } },
        failure.status
      );
    }
    if (path === '/leagues/L1/state') {
      return ok({
        yourTeam: { id: 'team-1', name: 'Alice FC', faabRemaining: 88 },
        allowedActions: options.allowed ?? ['claim_waiver', 'cancel_waiver_claim'],
        teams: [
          { id: 'team-1', name: 'Alice FC' },
          { id: 'team-2', name: 'Bob Squad' }
        ]
      });
    }
    if (path === '/players') return ok({ players });
    if (path === '/leagues/L1/waivers/preview') {
      const drop = url.searchParams.get('dropPlayerId');
      const full = url.searchParams.get('playerId') === 'fx-cmc' && drop === null;
      return ok({
        wouldSucceed: !full,
        outcome: full
          ? 'blocked'
          : url.searchParams.get('playerId') === 'fx-cmc'
            ? 'claim_pending'
            : 'add_now',
        issues: full ? [{ code: 'ROSTER_FULL', message: 'Your roster is full.', fix: 'Pick a drop.' }] : [],
        processesAt: full
          ? null
          : url.searchParams.get('playerId') === 'fx-cmc'
            ? '2026-09-13T08:00:00.000Z'
            : null,
        currentRoster: [ref('fx-jallen', 'Josh Allen', 'QB'), ref('fx-swift', "D'Andre Swift")],
        resultingRoster: [],
        faabRemaining: 88,
        faabAfter: 88 - Number(url.searchParams.get('bid') ?? 0)
      });
    }
    if (path === '/leagues/L1/waivers/claims' && method === 'GET') return ok({ claims });
    if (path === '/leagues/L1/waivers/claims' && method === 'POST') {
      const b = body as { playerId: string; bid: number; dropPlayerId?: string };
      const player = players.find((p) => p.id === b.playerId) as SearchPlayer;
      if (player.availability?.status !== 'waivers') return ok({ outcome: 'added', player, claim: null });
      const claim: Claim = {
        id: 'c-2',
        teamName: 'Alice FC',
        player,
        drop: null,
        bid: b.bid,
        priority: 2,
        status: 'pending',
        processesAt: '2026-09-13T08:00:00.000Z'
      };
      claims = [...claims, claim];
      return ok({ outcome: 'claim_pending', player, claim });
    }
    if (path.startsWith('/leagues/L1/waivers/claims/') && method === 'DELETE') {
      claims = claims.filter((c) => !path.endsWith(c.id));
      return ok({ claim: {} });
    }
    if (path === '/leagues/L1/transactions') {
      const move = (id: string, extra: object) => ({
        id,
        at: '2026-09-12T08:00:00.000Z',
        week: 2,
        teamId: 'team-1',
        teamName: 'Alice FC',
        added: null,
        dropped: null,
        cost: null,
        ...extra
      });
      return url.searchParams.get('cursor') === 'older'
        ? ok({
            transactions: [move('t3', { type: 'drop', dropped: ref('fx-swift', "D'Andre Swift") })],
            nextCursor: null
          })
        : ok({
            transactions: [
              move('t1', {
                type: 'waiver_claim',
                added: ref('fx-hall', 'Breece Hall'),
                dropped: ref('fx-jallen', 'Josh Allen', 'QB'),
                cost: 7
              }),
              move('t2', { type: 'add', teamName: 'Robots', added: ref('fx-bijan', 'Bijan Robinson') })
            ],
            nextCursor: 'older'
          });
    }
    return json({ error: { code: 'ROUTE_NOT_FOUND', message: path, fix: 'x' } }, 404);
  });
  vi.stubGlobal('fetch', fetchImpl);
  return { calls, fetchImpl };
}

beforeEach(() => signInAs(ALICE));
afterEach(() => vi.unstubAllGlobals());

/** A list item by its whole text: player names in it are separate (clickable) elements. */
const item = (text: string | RegExp) => (_: string, el: Element | null) =>
  el?.tagName === 'LI' &&
  (typeof text === 'string' ? el.textContent === text : text.test(el.textContent ?? ''));

async function openPage() {
  renderApp('/leagues/L1/players');
  // The name shows in the pool and in the transaction log: the pool's comes first.
  return (await screen.findAllByText('Bijan Robinson'))[0];
}

describe('players page', () => {
  it('lists players with their league status and filters to available ones', async () => {
    const api = fakeApi();
    await openPage();
    expect(screen.getByText('Alice FC: $88 FAAB left')).toBeInTheDocument();
    expect(screen.getByText('Waivers until 2026-09-12 12:00 UTC')).toBeInTheDocument();
    expect(screen.getAllByText('Free agent')).toHaveLength(2);
    expect(screen.queryByText('CeeDee Lamb')).not.toBeInTheDocument();
    expect(screen.getByText('FA')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Available only'));
    expect(screen.getByText('Bob Squad')).toBeInTheDocument();
    expect(screen.getByText('Rostered')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add CeeDee Lamb' })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Search players'), ' robinson ');
    await user.selectOptions(screen.getByLabelText('Position'), 'RB');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/players')).toHaveLength(2));
    const search = api.calls.filter((c) => c.path === '/players').at(-1) as Call;
    expect(search.query.get('q')).toBe('robinson');
    expect(search.query.get('position')).toBe('RB');
    expect(search.query.get('leagueId')).toBe('L1');
  });

  it('adds a free agent right away', async () => {
    const api = fakeApi();
    await openPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add Bijan Robinson' }));
    const panel = await screen.findByRole('region', { name: 'Add Bijan Robinson' });
    expect(within(panel).queryByLabelText('FAAB bid')).not.toBeInTheDocument();
    const add = within(panel).getByRole('button', { name: 'Add player' });
    await waitFor(() => expect(add).toBeEnabled());
    await user.click(add);
    expect(await screen.findByText('Added Bijan Robinson.')).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({ playerId: 'fx-bijan', bid: 0 });
    expect(screen.queryByRole('region', { name: 'Add Bijan Robinson' })).not.toBeInTheDocument();
  });

  it('claims a player on waivers with a drop and a FAAB bid', async () => {
    const api = fakeApi();
    await openPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Claim Christian McCaffrey' }));
    const panel = await screen.findByRole('region', { name: 'Claim Christian McCaffrey' });
    expect(await within(panel).findByText('Your roster is full. Pick a drop.')).toBeInTheDocument();
    const submit = within(panel).getByRole('button', { name: 'Submit claim' });
    expect(submit).toBeDisabled();

    await user.selectOptions(within(panel).getByLabelText('Drop player'), 'fx-swift');
    await user.clear(within(panel).getByLabelText('FAAB bid'));
    await user.type(within(panel).getByLabelText('FAAB bid'), '12');
    expect(await within(panel).findByText('You have $88; $76 left if it wins.')).toBeInTheDocument();
    expect(within(panel).getByText('Processes 2026-09-13 08:00 UTC.')).toBeInTheDocument();
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(
      await screen.findByText('Claim for Christian McCaffrey ($12) queued; it runs 2026-09-13 08:00 UTC.')
    ).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
      playerId: 'fx-cmc',
      bid: 12,
      dropPlayerId: 'fx-swift'
    });
    const claims = screen.getByRole('region', { name: 'My claims' });
    expect(await within(claims).findByText(item(/Christian McCaffrey for \$12/))).toBeInTheDocument();
  });

  it('shows pending claims and cancels one', async () => {
    const api = fakeApi();
    await openPage();
    const claims = screen.getByRole('region', { name: 'My claims' });
    expect(
      await within(claims).findByText(item(/1\. Breece Hall for \$7, dropping Josh Allen/))
    ).toBeInTheDocument();
    await userEvent
      .setup()
      .click(within(claims).getByRole('button', { name: 'Cancel claim for Breece Hall' }));
    expect(await within(claims).findByText('No pending claims.')).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === 'DELETE')?.path).toBe('/leagues/L1/waivers/claims/c-1');
  });

  it('disables adds when claims are closed', async () => {
    fakeApi({ allowed: [] });
    await openPage();
    expect(await screen.findByText(/Adds and claims are closed right now/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Bijan Robinson' })).toBeDisabled();
  });

  it('closes the claim panel on cancel', async () => {
    fakeApi();
    await openPage();
    const user = userEvent.setup();
    const add = screen.getByRole('button', { name: 'Add Travis Kelce' });
    await waitFor(() => expect(add).toBeEnabled());
    await user.click(add);
    const panel = await screen.findByRole('region', { name: 'Add Travis Kelce' });
    await user.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Add Travis Kelce' })).not.toBeInTheDocument();
  });

  it('shows errors with their fixes', async () => {
    fakeApi({
      fail: {
        'GET /leagues/L1/state': { status: 403, code: 'FORBIDDEN', fix: 'Join first.' },
        'POST /leagues/L1/waivers/claims': {
          status: 409,
          code: 'PLAYER_NOT_AVAILABLE',
          fix: 'Pick another.'
        },
        'DELETE /leagues/L1/waivers/claims/c-1': {
          status: 409,
          code: 'WAIVER_CLAIM_NOT_PENDING',
          fix: 'Too late.'
        }
      }
    });
    await openPage();
    expect(await screen.findByText('FORBIDDEN happened. Join first.')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Cancel claim for Breece Hall' }));
    expect(await screen.findByText('WAIVER_CLAIM_NOT_PENDING happened. Too late.')).toBeInTheDocument();
  });

  it('reports failed claims, searches, and claim lists', async () => {
    fakeApi({
      fail: {
        'POST /leagues/L1/waivers/claims': { status: 409, code: 'PLAYER_NOT_AVAILABLE', fix: 'Pick another.' }
      }
    });
    await openPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add Bijan Robinson' }));
    const panel = await screen.findByRole('region', { name: 'Add Bijan Robinson' });
    const add = within(panel).getByRole('button', { name: 'Add player' });
    await waitFor(() => expect(add).toBeEnabled());
    await user.click(add);
    expect(
      await within(panel).findByText('PLAYER_NOT_AVAILABLE happened. Pick another.')
    ).toBeInTheDocument();

    vi.unstubAllGlobals();
    fakeApi({
      fail: {
        'GET /players': { status: 500, code: 'INTERNAL', fix: 'Retry.' },
        'GET /leagues/L1/waivers/claims': { status: 403, code: 'FORBIDDEN', fix: 'Join.' }
      }
    });
    renderApp('/leagues/L1/players');
    expect(await screen.findByText('INTERNAL happened. Retry.')).toBeInTheDocument();
    expect(await screen.findByText('FORBIDDEN happened. Join.')).toBeInTheDocument();
  });

  it('reports a failed preview', async () => {
    fakeApi({
      fail: { 'GET /leagues/L1/waivers/preview': { status: 404, code: 'PLAYER_NOT_FOUND', fix: 'Search.' } }
    });
    await openPage();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add Bijan Robinson' }));
    expect(await screen.findByText('PLAYER_NOT_FOUND happened. Search.')).toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    const api = fakeApi();
    api.fetchImpl.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).includes('/players?')
        ? new Response(JSON.stringify({ data: { players: [] }, league: null, warnings: [] }), { status: 200 })
        : new Response(
            JSON.stringify({ data: { claims: [], allowedActions: [], teams: [], yourTeam: null } }),
            {
              status: 200
            }
          )
    );
    renderApp('/leagues/L1/players');
    expect(await screen.findByText('No players match.')).toBeInTheDocument();
  });
});

describe('helpers', () => {
  it('shows the league transaction log with older pages', async () => {
    const api = fakeApi();
    await openPage();
    const log = within(await screen.findByRole('list', { name: 'League transactions' }));
    expect(
      await log.findByText(item(/claimed Breece Hall for \$7, dropping Josh Allen/))
    ).toBeInTheDocument();
    expect(log.getByText(item(/added Bijan Robinson/))).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show older moves' }));
    expect(await log.findByText(item(/dropped D'Andre Swift/))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show older moves' })).not.toBeInTheDocument();
    const last = api.calls.filter((c) => c.path === '/leagues/L1/transactions').at(-1);
    expect(last?.query.get('cursor')).toBe('older');
  });

  it('reports a failed transaction log', async () => {
    fakeApi({
      fail: { 'GET /leagues/L1/transactions': { status: 403, code: 'FORBIDDEN', fix: 'Join the league.' } }
    });
    await openPage();
    expect(await screen.findByText('FORBIDDEN happened. Join the league.')).toBeInTheDocument();
  });

  it('describes every kind of move', () => {
    const base = {
      id: 't',
      at: '2026-09-12T08:00:00.000Z',
      week: 1,
      teamId: 'team-1',
      teamName: 'A',
      added: null,
      dropped: null,
      cost: null
    };
    expect(describeMove({ ...base, type: 'waiver_claim' })).toBe('claimed a player for $0');
    expect(describeMove({ ...base, type: 'add' })).toBe('added a player');
    expect(describeMove({ ...base, type: 'drop' })).toBe('dropped a player');
    // The on-screen line (clickable names) reads the same.
    for (const type of ['waiver_claim', 'add', 'drop'] as const) {
      const { container, unmount } = render(<MoveText t={{ ...base, type }} />);
      expect(container).toHaveTextContent(describeMove({ ...base, type }));
      unmount();
    }
  });

  it('formats times and errors', () => {
    expect(formatTime('2026-09-13T08:00:00.000Z')).toBe('2026-09-13 08:00 UTC');
    expect(describeError(new Error('Plain.'))).toBe('Plain.');
    expect(describeError('nope')).toBe('Something went wrong.');
  });
});
