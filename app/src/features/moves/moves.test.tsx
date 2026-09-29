import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type { LeagueApi } from '../../api/league';
import type { MarketPage, MarketPlayer, PlayerGame, Roster, RosterEntry, WaiverClaim } from '../../api/types';
import { fakeApi, state, team } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';
import {
  canMoveToIr,
  compactCount,
  dropCandidates,
  moveErrorText,
  roleOf,
  rosterNeeds,
  slotPosition,
  standingText,
  trendOf
} from './moves';
import { addedMessage, tradeLink } from './RosterWorkspace';

/** The roster workspace (#205): roster, market, the add flow, drops, IR, and pending claims. */

const ALICE = { sub: 'alice', email: 'alice@example.com', given_name: 'Alice' };
const TEAMS = [
  team(1, { name: "Alice's Team", seatType: 'human', open: false, ownerName: 'Alice', ownerUserId: 'alice' }),
  team(2, { name: "Bob's Team", seatType: 'human', open: false, ownerName: 'Bob', ownerUserId: 'bob' })
];
const ALL_ACTIONS = [
  'claim_waiver',
  'drop_player',
  'set_lineup',
  'update_waiver_claim',
  'cancel_waiver_claim',
  'reorder_waiver_claims',
  'propose_trade'
];
const CLEARS = '2026-09-16T08:00:00.000Z';

const upcoming = (opponent = 'DEN', kickoff = '2026-09-13T17:00:00.000Z'): PlayerGame => ({
  state: 'upcoming',
  opponent,
  home: true,
  kickoff,
  period: null,
  clock: null,
  teamScore: null,
  opponentScore: null,
  possession: false,
  redZone: false,
  progress: null
});
const bye: PlayerGame = { ...upcoming(), state: 'bye', opponent: null, home: null, kickoff: null };

function entry(
  id: string,
  name: string,
  slot: string,
  position: string,
  extra: Partial<RosterEntry> = {}
): RosterEntry {
  return {
    player: { id, name, team: 'KC', position },
    slot,
    status: 'active',
    injuryStatus: null,
    byeWeek: 10,
    onBye: false,
    kickoff: '2026-09-13T17:00:00.000Z',
    opponent: { team: 'DEN', home: true },
    locked: false,
    projectedPoints: 10,
    points: null,
    seasonAverage: { average: 9.5, games: 2 },
    game: upcoming(),
    ...extra
  };
}

function roster(players: RosterEntry[] = PLAYERS): Roster {
  return {
    teamId: 'team-1',
    teamName: "Alice's Team",
    week: 3,
    lineupSaved: true,
    carriedFromWeek: null,
    projectedPoints: 88.4,
    slots: [
      { slot: 'QB', count: 1 },
      { slot: 'RB', count: 2 },
      { slot: 'WR', count: 1 },
      { slot: 'BN', count: 2 },
      { slot: 'IR', count: 1 }
    ],
    players
  };
}

const PLAYERS = [
  entry('qb', 'Josh Allen', 'QB', 'QB', { projectedPoints: 22 }),
  entry('rb1', 'Breece Hall', 'RB', 'RB', { projectedPoints: 14 }),
  entry('rb2', 'Kenneth Walker', 'RB', 'RB', { onBye: true, kickoff: null, opponent: null, game: bye }),
  entry('wr', 'Tyreek Hill', 'WR', 'WR', {
    locked: true,
    game: { ...upcoming(), state: 'live', period: 2, clock: '4:00' }
  }),
  entry('bn1', 'Jaylen Warren', 'BN', 'RB', { projectedPoints: 4, status: 'out', injuryStatus: 'Out' }),
  entry('bn2', 'Rome Odunze', 'BN', 'WR', { projectedPoints: 6, seasonAverage: null })
];

function market(id: string, name: string, extra: Partial<MarketPlayer> = {}): MarketPlayer {
  return {
    player: { id, name, team: 'CHI', position: 'RB' },
    availability: { status: 'free_agent' },
    status: 'active',
    injuryStatus: null,
    byeWeek: 7,
    game: upcoming('GB'),
    projectedPoints: 12.5,
    projectedRos: 150,
    seasonPoints: 40,
    average: 13.3,
    games: 3,
    trend: { adds: 2300, drops: 100 },
    ...extra
  };
}

const MARKET = [
  market('fa', "D'Andre Swift"),
  market('wv', 'Jaylen Wright', {
    availability: { status: 'waivers', clearsAt: CLEARS },
    trend: { adds: 0, drops: 5300 }
  }),
  market('ro', 'CeeDee Lamb', {
    player: { id: 'ro', name: 'CeeDee Lamb', team: 'DAL', position: 'WR' },
    availability: { status: 'rostered', teamId: 'team-2' },
    status: 'questionable',
    injuryStatus: 'Questionable',
    trend: null
  }),
  market('mine', 'Josh Allen', {
    availability: { status: 'rostered', teamId: 'team-1' },
    status: 'out',
    trend: { adds: 5, drops: 5 }
  })
];

function page(players: MarketPlayer[] = MARKET, extra: Partial<MarketPage> = {}): MarketPage {
  return {
    season: 2026,
    week: 3,
    total: players.length,
    nextOffset: null,
    trendHours: 24,
    waiverType: 'faab',
    faabRemaining: 88,
    dropClearsAt: CLEARS,
    players,
    ...extra
  };
}

const CLAIMS: WaiverClaim[] = [
  {
    id: 'c1',
    teamName: "Alice's Team",
    player: { id: 'x1', name: 'Tank Bigsby', team: 'JAX', position: 'RB' },
    drop: { id: 'bn2', name: 'Rome Odunze', team: 'CHI', position: 'WR' },
    bid: 12,
    priority: 1,
    status: 'pending',
    processesAt: CLEARS
  },
  {
    id: 'c2',
    teamName: "Alice's Team",
    player: { id: 'x2', name: 'Jalen McMillan', team: 'TB', position: 'WR' },
    drop: null,
    bid: 3,
    priority: 2,
    status: 'pending',
    processesAt: CLEARS
  }
];

const conflict = (code: string, details?: unknown) =>
  new ApiError(409, { code, message: `${code} happened.`, fix: 'Do the other thing.', details });

function stubWide(wide: boolean) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width') ? wide : false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

function open(path = '/leagues/L1/team/moves', overrides: Partial<LeagueApi> = {}, allowed = ALL_ACTIONS) {
  const api = fakeApi({
    getLeagueState: vi.fn(async () =>
      state({ phase: 'regular_season', week: 3, allowedActions: allowed, teams: TEAMS, yourTeam: TEAMS[0] })
    ),
    getRoster: vi.fn(async () => roster()),
    listLeaguePlayers: vi.fn(async () => page()),
    listClaims: vi.fn(async () => CLAIMS),
    ...overrides
  });
  renderApp(path, undefined, api);
  return api;
}

let restore: () => void = () => undefined;
beforeEach(() => {
  signInAs(ALICE);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      // The transaction log, and the shared player card (#203), read through fetch.
      const url = new URL(String(input), 'http://localhost');
      const data = url.pathname.endsWith('/players/card')
        ? {
            player: { id: url.searchParams.get('playerId'), name: 'Card', team: null, position: 'RB' },
            scoring: { source: 'league' },
            bye: null,
            injuryStatus: null,
            lastSeason: null,
            projection: null,
            news: []
          }
        : { transactions: [], nextCursor: null };
      return new Response(JSON.stringify({ data, league: null, warnings: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    })
  );
});
afterEach(() => {
  restore();
  restore = () => undefined;
  vi.unstubAllGlobals();
});

describe('roster rules and words', () => {
  it('counts and trends', () => {
    expect(compactCount(950)).toBe('950');
    expect(compactCount(2000)).toBe('2k');
    expect(compactCount(2340)).toBe('2.3k');
    expect(trendOf(null)).toBeNull();
    expect(trendOf({ adds: 3, drops: 3 })).toBeNull();
    expect(trendOf({ adds: 2400, drops: 100 })).toEqual({ up: true, text: '2.3k adds' });
    expect(trendOf({ adds: 0, drops: 40 })).toEqual({ up: false, text: '40 drops' });
  });

  it('names where a player stands', () => {
    const name = (id: string) => `Team ${id}`;
    expect(standingText({ status: 'free_agent' }, name)).toBe('Free agent');
    expect(standingText({ status: 'waivers' }, name)).toBe('Waivers');
    expect(standingText({ status: 'waivers', clearsAt: CLEARS }, name)).toMatch(/^Waivers · clears \w{3} /);
    expect(standingText({ status: 'rostered', teamId: 't2' }, name)).toBe('Team t2');
    expect(standingText({ status: 'rostered' }, name)).toBe('Team ');
  });

  it('maps slots to market filters', () => {
    expect(slotPosition('RB')).toBe('RB');
    expect(slotPosition('W/R/T')).toBe('FLEX');
    expect(slotPosition('Q/W/R/T')).toBe('');
  });

  it('finds what the roster needs: empty slots, starters who will not play, and IR moves', () => {
    const out = entry('rbo', 'Out Starter', 'RB', 'RB', { status: 'out', injuryStatus: 'Out' });
    const lockedOut = entry('lo', 'Locked Out', 'QB', 'QB', {
      status: 'out',
      injuryStatus: 'Out',
      locked: true
    });
    const data = roster([lockedOut, PLAYERS[2] as RosterEntry, out, PLAYERS[4] as RosterEntry]);
    data.slots = [...data.slots, { slot: 'W/R/T', count: 1 }, { slot: 'Q/W/R/T', count: 1 }];
    const needs = rosterNeeds(data);
    expect(needs.map((n) => n.text)).toEqual([
      'RB1 Kenneth Walker is on bye: find a replacement',
      'RB2 Out Starter is Out: find a replacement',
      'WR is empty: find a starter',
      'W/R/T is empty: find a starter',
      'Q/W/R/T is empty: find a starter',
      'Out Starter can move to IR to free a spot',
      'Jaylen Warren can move to IR to free a spot'
    ]);
    expect(needs.map((n) => n.find)).toEqual(['RB', 'RB', 'WR', 'FLEX', '', undefined, undefined]);
    // A locked starter and a full IR need nothing.
    const full = roster([...PLAYERS, entry('ir', 'On IR', 'IR', 'TE', { status: 'ir' })]);
    expect(rosterNeeds(full).some((n) => n.toIr !== undefined)).toBe(false);
    expect(canMoveToIr(roster(), PLAYERS[4] as RosterEntry)).toBe(true);
    expect(canMoveToIr(roster(), PLAYERS[0] as RosterEntry)).toBe(false);
  });

  it('offers drops lowest value first, never IR players', () => {
    const ir = entry('ir', 'On IR', 'IR', 'TE', { status: 'ir' });
    const tie = entry('tie', 'Aaron Tie', 'BN', 'WR', { projectedPoints: 6, seasonAverage: null });
    const unprojected = entry('np', 'No Projection', 'BN', 'TE', {
      projectedPoints: null,
      seasonAverage: null
    });
    const order = dropCandidates(roster([...PLAYERS, ir, tie, unprojected])).map((e) => e.player.id);
    // Warren is out and Walker on bye: worth 0 this week like the unprojected, then by average and name.
    expect(order).toEqual(['np', 'bn1', 'rb2', 'tie', 'bn2', 'wr', 'rb1', 'qb']);
    expect(roleOf(PLAYERS[0] as RosterEntry)).toBe('Starting QB');
    expect(roleOf(PLAYERS[4] as RosterEntry)).toBe('Bench');
  });

  it('words every refusal the add flow can hit', () => {
    const names = { player: 'Swift', drop: 'Hill' };
    expect(moveErrorText(conflict('PLAYER_LOCKED'), names)).toBe(
      'Your game-day lock hit Hill; pick another drop.'
    );
    expect(moveErrorText(conflict('PLAYER_LOCKED'), { ...names, drop: null })).toBe(
      'A game-day lock hit this move; pick another player.'
    );
    expect(moveErrorText(conflict('ROSTER_FULL'), names)).toBe('Your roster is full: pick a player to drop.');
    expect(moveErrorText(conflict('INSUFFICIENT_FAAB', { faabRemaining: 8 }), names)).toBe(
      'You have $8 FAAB left; lower your bid.'
    );
    expect(moveErrorText(conflict('INSUFFICIENT_FAAB'), names)).toBe('That bid is more than your FAAB left.');
    expect(moveErrorText(conflict('ZERO_BID_NOT_ALLOWED'), names)).toBe(
      'This league needs a bid of at least $1.'
    );
    expect(moveErrorText(conflict('PLAYER_NOT_AVAILABLE'), names)).toBe(
      'Swift is no longer available: another team has him.'
    );
    expect(moveErrorText(conflict('DUPLICATE_WAIVER_CLAIM'), names)).toMatch(/already have a claim on Swift/);
    expect(moveErrorText(conflict('ACQUISITION_LIMIT_REACHED'), names)).toBe(
      'You have used all your adds this week.'
    );
    expect(moveErrorText(conflict('PLAYER_IN_TRADE'), names)).toMatch(/^Hill is in a trade/);
    expect(moveErrorText(conflict('PLAYER_IN_TRADE'), { ...names, drop: null })).toMatch(
      /^Swift is in a trade/
    );
    expect(moveErrorText(conflict('SOMETHING_ELSE'), names)).toBe(
      'SOMETHING_ELSE happened. Do the other thing.'
    );
    expect(moveErrorText(new ApiError(500, { code: 'X', message: 'Broke.' }), names)).toBe('Broke.');
    expect(moveErrorText(new Error('Offline.'), names)).toBe('Offline.');
    expect(moveErrorText('nope', names)).toBe('Something went wrong.');
  });

  it('links trades and words a finished add', () => {
    expect(tradeLink('L1', { playerId: 'p1' })).toBe('/leagues/L1/team/trades?send=p1');
    expect(tradeLink('L1', { playerId: 'p2', teamId: 'team-2' })).toBe(
      '/leagues/L1/team/trades?with=team-2&receive=p2'
    );
    const player = { id: 'p', name: 'Swift', team: 'CHI', position: 'RB' };
    expect(addedMessage({ outcome: 'added', player, dropped: null, claim: null }, null)).toBe('Added Swift.');
    expect(addedMessage({ outcome: 'added', player, dropped: null, claim: null }, 'Hill')).toBe(
      'Added Swift, dropped Hill.'
    );
    expect(
      addedMessage(
        { outcome: 'claim_pending', player, dropped: null, claim: { ...(CLAIMS[0] as WaiverClaim) } },
        null
      )
    ).toMatch(/^Claim placed for Swift: processes /);
  });
});

describe('the roster workspace on a phone', () => {
  it('shows the roster grouped, with needs, claims inline, and the market in a sheet', async () => {
    const user = userEvent.setup();
    const api = open();
    const starters = await screen.findByRole('list', { name: 'Starters' });
    expect(within(starters).getByText('Josh Allen')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Bench' })).toHaveTextContent('Jaylen Warren');
    expect(screen.getByRole('list', { name: 'IR' })).toHaveTextContent('Out or IR players can rest here');
    expect(screen.getByTestId('roster-row-wr')).toHaveTextContent('Locked');
    expect(screen.getByTestId('roster-row-wr').querySelector('img[loading="lazy"]')).not.toBeNull();
    expect(screen.getByTestId('roster-row-bn2')).toHaveTextContent('Season average –');
    const needs = screen.getByRole('region', { name: 'Roster needs' });
    expect(within(needs).getByText('RB2 Kenneth Walker is on bye: find a replacement')).toBeInTheDocument();
    expect(within(screen.getByTestId('pending-claims')).getByText('Pending claims (2)')).toBeInTheDocument();
    expect(within(screen.getByTestId('claim-c1')).getByText(/Claiming/, { selector: 'p' })).toHaveTextContent(
      /Claiming Tank Bigsby, dropping Rome Odunze · \$12 bid · processes/
    );
    expect(await screen.findByTestId('moves-summary')).toHaveTextContent('$88 FAAB left');
    // The phone reads one row for the FAAB context; the market waits in its sheet.
    expect(api.listLeaguePlayers).toHaveBeenCalledWith('L1', { limit: 1 });

    await user.click(screen.getByRole('button', { name: 'Add players' }));
    const sheet = await screen.findByRole('list', { name: 'Available players' });
    expect(within(sheet).getByText("D'Andre Swift")).toBeInTheDocument();
    await waitFor(() =>
      expect(api.listLeaguePlayers).toHaveBeenLastCalledWith('L1', {
        availability: 'available',
        sort: 'projected_week',
        limit: 25
      })
    );
  });

  it('adds a free agent with a drop from the full roster, comparing the two', async () => {
    const user = userEvent.setup();
    const previewClaim = vi.fn(async (_id: string, q: { playerId: string; dropPlayerId?: string }) => ({
      wouldSucceed: q.dropPlayerId !== undefined,
      outcome: q.dropPlayerId === undefined ? ('blocked' as const) : ('add_now' as const),
      issues:
        q.dropPlayerId === undefined ? [{ code: 'ROSTER_FULL', message: 'Full.', fix: 'Drop someone.' }] : [],
      processesAt: null,
      faabRemaining: 88,
      faabAfter: 88
    }));
    const claimPlayer = vi.fn(async () => ({
      outcome: 'added' as const,
      player: MARKET[0]!.player,
      dropped: PLAYERS[4]!.player,
      claim: null
    }));
    const api = open('/leagues/L1/team/moves?market=RB', { previewClaim, claimPlayer });
    const sheet = await screen.findByRole('list', { name: 'Available players' });
    await waitFor(() =>
      expect(api.listLeaguePlayers).toHaveBeenLastCalledWith(
        'L1',
        expect.objectContaining({ position: 'RB' })
      )
    );
    await user.click(within(sheet).getByRole('button', { name: "Add D'Andre Swift" }));
    const dialog = await screen.findByTestId('add-sheet');
    expect(await within(dialog).findByText('Your roster is full: pick who to drop')).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Add player' });
    expect(confirm).toBeDisabled();
    // Locked players cannot be picked; the list runs lowest projection first.
    expect(within(dialog).getByRole('radio', { name: /Tyreek Hill/ })).toBeDisabled();
    const radios = within(dialog).getAllByRole('radio');
    expect(radios[0]).toHaveAccessibleName(/Jaylen Warren/);
    await user.click(within(dialog).getByRole('radio', { name: /Jaylen Warren/ }));
    const compare = await within(dialog).findByTestId('compare');
    expect(compare).toHaveTextContent("+ D'Andre Swift");
    expect(compare).toHaveTextContent('− Jaylen Warren');
    await user.click(await within(dialog).findByRole('button', { name: 'Add, drop Jaylen Warren' }));
    await waitFor(() =>
      expect(claimPlayer).toHaveBeenCalledWith('L1', { playerId: 'fa', dropPlayerId: 'bn1' })
    );
    expect(await screen.findByText("Added D'Andre Swift, dropped Jaylen Warren.")).toBeInTheDocument();
    await waitFor(() => expect(api.getRoster).toHaveBeenCalledTimes(2));
  });

  it('claims a waiver player with a bid, and words a lock that hits the drop', async () => {
    const user = userEvent.setup();
    const claimPlayer = vi.fn(async () => {
      throw conflict('PLAYER_LOCKED');
    });
    const previewClaim = vi.fn(async (_id: string, q: { bid?: number }) => ({
      wouldSucceed: true,
      outcome: 'claim_pending' as const,
      issues: q.bid === 99 ? [{ code: 'INSUFFICIENT_FAAB', message: 'Too much.', fix: 'Bid less.' }] : [],
      processesAt: CLEARS,
      faabRemaining: 88,
      faabAfter: 88 - (q.bid ?? 0)
    }));
    open('/leagues/L1/team/moves?market=', { claimPlayer, previewClaim });
    const sheet = await screen.findByRole('list', { name: 'Available players' });
    await user.click(within(sheet).getByRole('button', { name: 'Claim Jaylen Wright' }));
    const dialog = await screen.findByTestId('add-sheet');
    expect(within(dialog).getByText(/On waivers: your claim is processed/)).toBeInTheDocument();
    // Room on the roster: no drop needed, but one can be added.
    await user.click(within(dialog).getByRole('button', { name: 'Drop someone too' }));
    expect(within(dialog).getByRole('radio', { name: /Nobody/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Jaylen Warren/ })).toBeChecked();
    const bid = within(dialog).getByLabelText('FAAB bid ($)');
    await user.clear(bid);
    await user.type(bid, '99');
    expect(await within(dialog).findByText('Too much. Bid less.')).toBeInTheDocument();
    await user.clear(bid);
    await user.type(bid, '14');
    expect(await within(dialog).findByText('$88 left; $74 if this claim wins.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Place claim ($14)' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Your game-day lock hit Jaylen Warren; pick another drop.'
    );
    expect(claimPlayer).toHaveBeenCalledWith('L1', { playerId: 'wv', dropPlayerId: 'bn1', bid: 14 });
    await user.click(within(dialog).getByRole('radio', { name: /Nobody/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('add-sheet')).not.toBeInTheDocument());
  });

  it('places a rolling-waiver claim without a bid, and shows a failed preview', async () => {
    const user = userEvent.setup();
    const claimPlayer = vi.fn(async () => ({
      outcome: 'claim_pending' as const,
      player: MARKET[1]!.player,
      dropped: null,
      claim: CLAIMS[1]!
    }));
    let calls = 0;
    const previewClaim = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw conflict('PLAYER_NOT_AVAILABLE');
      return {
        wouldSucceed: true,
        outcome: 'claim_pending' as const,
        issues: [],
        processesAt: null,
        faabRemaining: 0,
        faabAfter: 0
      };
    });
    const rolling = page(MARKET, { waiverType: 'rolling', faabRemaining: 0 });
    open('/leagues/L1/team/moves?market=', {
      claimPlayer,
      previewClaim,
      listLeaguePlayers: vi.fn(async () => rolling),
      getRoster: vi.fn(async () => roster(PLAYERS.slice(0, 4)))
    });
    expect(await screen.findByTestId('moves-summary')).toHaveTextContent('Rolling waivers');
    const sheet = await screen.findByRole('list', { name: 'Available players' });
    await user.click(within(sheet).getByRole('button', { name: 'Claim Jaylen Wright' }));
    const dialog = await screen.findByTestId('add-sheet');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Jaylen Wright is no longer available'
    );
    expect(
      within(dialog).getByText('Rolling waivers: claims go by waiver priority, no bid.')
    ).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('FAAB bid ($)')).not.toBeInTheDocument();
    // A different drop reruns the preview, which now passes.
    await user.click(within(dialog).getByRole('button', { name: 'Drop someone too' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Place claim' }));
    await waitFor(() =>
      expect(claimPlayer).toHaveBeenCalledWith('L1', { playerId: 'wv', dropPlayerId: 'rb2' })
    );
    expect(await screen.findByText(/Claim placed for Jaylen Wright/)).toBeInTheDocument();
  });

  it('closes the market sheet, and says when adds are closed', async () => {
    const user = userEvent.setup();
    open('/leagues/L1/team/moves?market=', {}, ['drop_player']);
    expect(await screen.findByTestId('moves-summary')).toHaveTextContent(
      '$88 FAAB left · Adds and claims are closed right now.'
    );
    const sheet = await screen.findByRole('list', { name: 'Available players' });
    expect(within(sheet).getByRole('button', { name: "Add D'Andre Swift" })).toBeDisabled();
    // Trading is closed too: no trade link for another team's player.
    expect(within(sheet).queryByRole('link', { name: /Propose a trade/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /close/i }));
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Available players' })).not.toBeInTheDocument()
    );
    // Claims cannot be edited either.
    expect(
      within(screen.getByTestId('pending-claims')).queryByRole('button', { name: 'Edit' })
    ).not.toBeInTheDocument();
  });
});

describe('the roster workspace on a desktop', () => {
  beforeEach(() => {
    restore = stubWide(true);
  });

  it('shows the market beside the roster, and a need opens it filtered', async () => {
    const user = userEvent.setup();
    const api = open('/leagues/L1/team/moves', {
      getRoster: vi.fn(async () => roster(PLAYERS.filter((p) => p.player.id !== 'wr')))
    });
    const list = await screen.findByRole('list', { name: 'Available players' });
    expect(screen.queryByRole('button', { name: 'Add players' })).not.toBeInTheDocument();
    expect(within(list).getByTestId('market-row-wv')).toHaveTextContent(/Waivers · clears/);
    expect(within(list).getByTestId('market-row-ro')).toHaveTextContent("Bob's Team");
    expect(within(list).getByTestId('market-row-ro')).toHaveTextContent('Questionable');
    expect(within(list).getByTestId('market-row-mine')).toHaveTextContent('Your team');
    expect(within(list).getByTestId('market-row-mine')).toHaveTextContent('OUT');
    // Sleeper CDN pictures (#222): a lazy headshot in each row, and the team's logo.
    const pics = within(list).getByTestId('market-row-ro').querySelectorAll('img');
    expect([...pics].every((img) => img.getAttribute('loading') === 'lazy')).toBe(true);
    expect(pics.length).toBeGreaterThanOrEqual(1);
    expect(
      within(list).getByTestId('market-row-fa').querySelector('[data-testid="market-trend"]')
    ).toHaveTextContent('2.2k adds');
    expect(within(list).getByTestId('market-row-wv')).toHaveTextContent('5.3k drops');
    expect(within(list).getByRole('link', { name: 'Propose a trade for CeeDee Lamb' })).toHaveAttribute(
      'href',
      '/leagues/L1/team/trades?with=team-2&receive=ro'
    );
    const needs = screen.getByRole('region', { name: 'Roster needs' });
    await user.click(within(needs).getByRole('button', { name: 'Find WR' }));
    await waitFor(() =>
      expect(api.listLeaguePlayers).toHaveBeenLastCalledWith(
        'L1',
        expect.objectContaining({ position: 'WR' })
      )
    );
    // Empty seats in the roster open it too.
    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.click(screen.getByRole('button', { name: 'Empty WR: find a player' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'WR' })).toHaveAttribute('aria-pressed', 'true')
    );
    // Picking a player keeps the market open beside the add flow.
    await user.click(within(list).getByRole('button', { name: "Add D'Andre Swift" }));
    expect(await screen.findByTestId('add-sheet')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Available players' })).toBeInTheDocument();
  });

  it('sorts, filters, searches, and pages the market', async () => {
    const user = userEvent.setup();
    const listLeaguePlayers = vi.fn(async (_id: string, q: { offset?: number }) =>
      q.offset === 25
        ? page([market('p2', 'Second Page')], { total: 5, nextOffset: null })
        : page(MARKET, { total: 5, nextOffset: 25 })
    );
    open('/leagues/L1/team/moves', { listLeaguePlayers });
    const list = await screen.findByRole('list', { name: 'Available players' });
    expect(screen.getByTestId('market-count')).toHaveTextContent('5 players · week 3');
    await user.selectOptions(screen.getByLabelText('Sort by'), 'trending');
    await user.click(screen.getByRole('button', { name: 'FLEX' }));
    expect(screen.getByRole('button', { name: 'FLEX' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByLabelText('Healthy only'));
    await user.click(screen.getByLabelText('Available only'));
    await user.type(screen.getByLabelText('Player name'), '  swift ');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(listLeaguePlayers).toHaveBeenLastCalledWith('L1', {
        q: 'swift',
        position: 'FLEX',
        availability: 'all',
        healthy: true,
        sort: 'trending',
        limit: 25
      })
    );
    await user.clear(screen.getByLabelText('Player name'));
    await waitFor(() =>
      expect(listLeaguePlayers).toHaveBeenLastCalledWith('L1', expect.not.objectContaining({ q: 'swift' }))
    );
    await user.click(await screen.findByRole('button', { name: 'Show more (1 more)' }));
    expect(await within(list).findByText('Second Page')).toBeInTheDocument();
    expect(listLeaguePlayers).toHaveBeenLastCalledWith('L1', expect.objectContaining({ offset: 25 }));
    expect(screen.queryByRole('button', { name: /Show more/ })).not.toBeInTheDocument();
  });

  it('says when nothing matches, and when the market fails', async () => {
    const user = userEvent.setup();
    let fail = false;
    const listLeaguePlayers = vi.fn(async (_id: string, q: { offset?: number; position?: string }) => {
      if (fail) throw conflict('BROKEN');
      if (q.position === 'K') return page([]);
      return page(MARKET, { nextOffset: 25 });
    });
    open('/leagues/L1/team/moves', { listLeaguePlayers });
    await screen.findByRole('list', { name: 'Available players' });
    await user.click(screen.getByRole('button', { name: 'K' }));
    expect(await screen.findByText(/No players match/)).toBeInTheDocument();
    fail = true;
    await user.click(screen.getByRole('button', { name: 'DEF' }));
    expect(await screen.findByText('BROKEN happened.')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.click(await screen.findByRole('button', { name: /Show more/ }));
    fail = true;
    await user.click(screen.getByRole('button', { name: /Show more/ }));
    expect(await screen.findByText('BROKEN happened.')).toBeInTheDocument();
  });

  it('drops a player in place, saying when he clears waivers', async () => {
    const user = userEvent.setup();
    let fail = true;
    const dropPlayer = vi.fn(async () => {
      if (fail) throw conflict('PLAYER_LOCKED');
      return { dropped: PLAYERS[5]!.player, clearsAt: CLEARS };
    });
    const api = open('/leagues/L1/team/moves', { dropPlayer });
    await user.click(await screen.findByRole('button', { name: 'Rome Odunze, BN: moves' }));
    await user.click(screen.getByRole('button', { name: 'Drop' }));
    const confirm = screen.getByRole('group', { name: 'Drop Rome Odunze?' });
    expect(confirm).toHaveTextContent(/He goes to waivers until \w{3} /);
    await user.click(within(confirm).getByRole('button', { name: 'Keep him' }));
    expect(screen.queryByRole('group', { name: 'Drop Rome Odunze?' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Drop' }));
    await user.click(screen.getByRole('button', { name: 'Drop Rome Odunze' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your game-day lock hit Rome Odunze; pick another drop.'
    );
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Drop Rome Odunze' }));
    expect(await screen.findByText(/^Dropped Rome Odunze\. He goes to waivers until/)).toBeInTheDocument();
    expect(dropPlayer).toHaveBeenCalledWith('L1', 'bn2');
    await waitFor(() => expect(api.listClaims).toHaveBeenCalledTimes(2));
  });

  it('keeps locked players, and moves hurt players to and from IR', async () => {
    const user = userEvent.setup();
    const setLineup = vi.fn(async () => ({ roster: roster(), warnings: [] }));
    const withIr = roster([...PLAYERS, entry('ir', 'Nick Chubb', 'IR', 'RB', { status: 'ir' })]);
    withIr.slots = withIr.slots.map((s) => (s.slot === 'IR' ? { slot: 'IR', count: 2 } : s));
    open('/leagues/L1/team/moves', { setLineup, getRoster: vi.fn(async () => withIr) });
    await user.click(await screen.findByRole('button', { name: 'Tyreek Hill, WR, locked: moves' }));
    const locked = screen.getByTestId('moves-wr');
    expect(locked).toHaveTextContent('he is locked until the week rolls over');
    expect(within(locked).queryByRole('button', { name: 'Drop' })).not.toBeInTheDocument();
    expect(within(locked).getByRole('link', { name: 'Trade Tyreek' })).toHaveAttribute(
      'href',
      '/leagues/L1/team/trades?send=wr'
    );
    await user.click(screen.getByRole('button', { name: 'Jaylen Warren, BN: moves' }));
    await user.click(within(screen.getByTestId('moves-bn1')).getByRole('button', { name: 'Move to IR' }));
    await waitFor(() =>
      expect(setLineup).toHaveBeenCalledWith('L1', 'team-1', 3, [{ playerId: 'bn1', slot: 'IR' }])
    );
    expect(await screen.findByText('Moved Jaylen Warren to IR.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Nick Chubb, IR: moves' }));
    await user.click(within(screen.getByTestId('moves-ir')).getByRole('button', { name: 'Activate' }));
    await waitFor(() =>
      expect(setLineup).toHaveBeenCalledWith('L1', 'team-1', 3, [{ playerId: 'ir', slot: 'BN' }])
    );
    // The needs strip moves him to IR in one tap, and says when that fails.
    setLineup.mockRejectedValueOnce(conflict('INVALID_LINEUP'));
    const needs = screen.getByRole('region', { name: 'Roster needs' });
    await user.click(within(needs).getByRole('button', { name: 'Move to IR' }));
    expect(await screen.findByText('INVALID_LINEUP happened.')).toBeInTheDocument();
  });

  it('edits, reorders, and cancels pending claims', async () => {
    const user = userEvent.setup();
    const updateClaim = vi.fn(async () => CLAIMS[0]!);
    const reorderClaims = vi.fn(async () => CLAIMS);
    const api = open('/leagues/L1/team/moves', { updateClaim, reorderClaims });
    const claims = await screen.findByTestId('pending-claims');
    expect(within(claims).getByRole('button', { name: 'Move Tank Bigsby up' })).toBeDisabled();
    await user.click(within(claims).getByRole('button', { name: 'Move Tank Bigsby down' }));
    await waitFor(() => expect(reorderClaims).toHaveBeenCalledWith('L1', ['c2', 'c1']));
    await user.click(within(claims).getByRole('button', { name: 'Move Jalen McMillan up' }));
    await waitFor(() => expect(reorderClaims).toHaveBeenLastCalledWith('L1', ['c2', 'c1']));

    await user.click(within(screen.getByTestId('claim-c1')).getByRole('button', { name: 'Edit' }));
    const editor = screen.getByRole('group', { name: 'Edit claim for Tank Bigsby' });
    expect(within(editor).getByRole('option', { name: 'Tyreek Hill (WR) · locked' })).toBeDisabled();
    await user.clear(within(editor).getByLabelText('Bid ($)'));
    await user.type(within(editor).getByLabelText('Bid ($)'), '20');
    await user.selectOptions(within(editor).getByLabelText('Drop'), 'bn1');
    await user.click(within(editor).getByRole('button', { name: 'Save claim' }));
    await waitFor(() =>
      expect(updateClaim).toHaveBeenCalledWith('L1', 'c1', { bid: 20, dropPlayerId: 'bn1' })
    );
    expect(await screen.findByText('Claim for Tank Bigsby updated.')).toBeInTheDocument();

    updateClaim.mockRejectedValueOnce(conflict('ROSTER_FULL'));
    await user.click(within(screen.getByTestId('claim-c2')).getByRole('button', { name: 'Edit' }));
    const second = screen.getByRole('group', { name: 'Edit claim for Jalen McMillan' });
    await user.click(within(second).getByRole('button', { name: 'Save claim' }));
    expect(updateClaim).toHaveBeenLastCalledWith('L1', 'c2', { bid: 3, clearDrop: true });
    expect(await within(claims).findByRole('alert')).toHaveTextContent(
      'Your roster is full: pick a player to drop.'
    );
    await user.click(within(second).getByRole('button', { name: 'Keep as is' }));

    await user.click(within(claims).getByRole('button', { name: 'Cancel claim for Jalen McMillan' }));
    await waitFor(() => expect(api.cancelClaim).toHaveBeenCalledWith('L1', 'c2'));
    expect(await screen.findByText('Claim for Jalen McMillan cancelled.')).toBeInTheDocument();
  });

  it('edits a rolling claim without a bid, and hides claim order for one claim', async () => {
    const user = userEvent.setup();
    const updateClaim = vi.fn(async () => CLAIMS[1]!);
    open('/leagues/L1/team/moves', {
      updateClaim,
      listClaims: vi.fn(async () => [CLAIMS[1]!]),
      listLeaguePlayers: vi.fn(async () => page(MARKET, { waiverType: 'rolling' }))
    });
    const claims = await screen.findByTestId('pending-claims');
    expect(
      await within(claims).findByText('Claims go by waiver priority, tried top to bottom.')
    ).toBeInTheDocument();
    expect(within(claims).queryByRole('button', { name: /Move .* up/ })).not.toBeInTheDocument();
    expect(within(claims).getByText(/Claiming/, { selector: 'p' })).not.toHaveTextContent('bid');
    await user.click(within(claims).getByRole('button', { name: 'Edit' }));
    expect(screen.queryByLabelText('Bid ($)')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Drop'), 'bn2');
    await user.click(screen.getByRole('button', { name: 'Save claim' }));
    await waitFor(() => expect(updateClaim).toHaveBeenCalledWith('L1', 'c2', { dropPlayerId: 'bn2' }));
  });
});

describe('the roster workspace without a roster', () => {
  it('waits for the league, and says when you have no team or the roster fails', async () => {
    open('/leagues/L1/team/moves', {
      getLeagueState: vi.fn(async () =>
        state({ phase: 'regular_season', week: 3, teams: TEAMS, yourTeam: null })
      )
    });
    expect(await screen.findByText('You do not manage a team in this league.')).toBeInTheDocument();
  });

  it('reports a roster that fails to load, and an empty bench', async () => {
    open('/leagues/L1/team/moves', { getRoster: vi.fn(async () => Promise.reject(conflict('NO_ROSTER'))) });
    expect(await screen.findByText('NO_ROSTER happened.')).toBeInTheDocument();
  });

  it('shows an empty bench and no needs when the roster is set', async () => {
    const set = roster([
      PLAYERS[0]!,
      PLAYERS[1]!,
      { ...PLAYERS[1]!, player: { ...PLAYERS[1]!.player, id: 'rb3' } },
      { ...PLAYERS[3]!, locked: false }
    ]);
    set.slots = set.slots.filter((s) => s.slot !== 'IR');
    set.projectedPoints = undefined;
    open('/leagues/L1/team/moves', { getRoster: vi.fn(async () => set), listClaims: vi.fn(async () => []) });
    expect(await screen.findByText('Nobody on the bench.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Roster needs' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'IR' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('pending-claims')).not.toBeInTheDocument();
  });
});

describe('League › Players', () => {
  beforeEach(() => {
    restore = stubWide(true);
  });

  it('lists every player with the same columns, and adds through the same sheet', async () => {
    const user = userEvent.setup();
    const claimPlayer = vi.fn(async () => ({
      outcome: 'added' as const,
      player: MARKET[0]!.player,
      dropped: null,
      claim: null
    }));
    const api = open('/leagues/L1/league/players', { claimPlayer });
    const list = await screen.findByRole('list', { name: 'All players' });
    expect(api.listLeaguePlayers).toHaveBeenCalledWith(
      'L1',
      expect.objectContaining({ availability: 'all' })
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Players' })).toBeInTheDocument();
    expect(await screen.findByText('$88 FAAB left')).toBeInTheDocument();
    await user.click(await within(list).findByRole('button', { name: "Add D'Andre Swift" }));
    await user.click(await screen.findByRole('button', { name: 'Add player' }));
    expect(await screen.findByText("Added D'Andre Swift.")).toBeInTheDocument();
    await waitFor(() => expect(api.getRoster).toHaveBeenCalledTimes(2));
  });

  it('closes adds for someone without a team, and says rolling waivers', async () => {
    const user = userEvent.setup();
    open(
      '/leagues/L1/league/players',
      {
        getLeagueState: vi.fn(async () =>
          state({ phase: 'regular_season', week: 3, teams: TEAMS, yourTeam: null })
        ),
        listLeaguePlayers: vi.fn(async () => page(MARKET, { waiverType: 'rolling', faabRemaining: 0 }))
      },
      []
    );
    const list = await screen.findByRole('list', { name: 'All players' });
    expect(within(list).getByRole('button', { name: "Add D'Andre Swift" })).toBeDisabled();
    expect(
      await screen.findByText('Rolling waivers · Adds and claims are closed right now.')
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'RB' }));
  });
});

describe('the roster workspace, edges', () => {
  beforeEach(() => {
    restore = stubWide(true);
  });

  it('words players without a team or a known owner, and a single match', async () => {
    const odd = [
      market('nt', 'No Team', { player: { id: 'nt', name: 'No Team', team: null, position: 'K' } }),
      market('gone', 'Gone Guy', { availability: { status: 'rostered', teamId: 'team-9' } })
    ];
    const withQflex = roster([
      ...PLAYERS,
      entry('solo', 'Solo Guy', 'BN', 'QB', {
        player: { id: 'solo', name: 'Solo Guy', team: null, position: 'QB' }
      })
    ]);
    withQflex.slots = [...withQflex.slots, { slot: 'Q/W/R/T', count: 1 }];
    open('/leagues/L1/team/moves', {
      listLeaguePlayers: vi.fn(async () => page(odd, { total: 1, dropClearsAt: null })),
      getRoster: vi.fn(async () => withQflex),
      listClaims: vi.fn(async () => Promise.reject(conflict('NO_CLAIMS')))
    });
    const list = await screen.findByRole('list', { name: 'Available players' });
    expect(screen.getByTestId('market-count')).toHaveTextContent('1 player · week 3');
    expect(within(list).getByTestId('market-row-nt')).toHaveTextContent('K · FA');
    expect(within(list).getByTestId('market-row-gone')).toHaveTextContent('Another team');
    expect(screen.getByTestId('roster-row-solo')).toHaveTextContent('QB · FA');
    // A failed claims read leaves no claims section.
    expect(screen.queryByTestId('pending-claims')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(
      within(screen.getByRole('region', { name: 'Roster needs' })).getByRole('button', {
        name: 'Find a player'
      })
    );
    // A row opens and closes its moves; with no waiver period a drop is a free agent at once.
    const row = screen.getByRole('button', { name: 'Rome Odunze, BN: moves' });
    await user.click(row);
    await user.click(screen.getByRole('button', { name: 'Drop' }));
    expect(screen.getByRole('group', { name: 'Drop Rome Odunze?' })).toHaveTextContent(
      'He becomes a free agent right away.'
    );
    await user.click(screen.getByRole('button', { name: 'Keep him' }));
    await user.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  it('says why a move to IR failed, and saves a cleared bid as $0', async () => {
    const user = userEvent.setup();
    const setLineup = vi.fn(async () => Promise.reject(conflict('INVALID_LINEUP')));
    const updateClaim = vi.fn(async () => CLAIMS[1]!);
    open('/leagues/L1/team/moves', { setLineup, updateClaim });
    await user.click(await screen.findByRole('button', { name: 'Jaylen Warren, BN: moves' }));
    await user.click(within(screen.getByTestId('moves-bn1')).getByRole('button', { name: 'Move to IR' }));
    expect(await within(screen.getByTestId('moves-bn1')).findByRole('alert')).toHaveTextContent(
      'INVALID_LINEUP happened.'
    );
    await user.click(within(screen.getByTestId('claim-c2')).getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Bid ($)'));
    await user.click(screen.getByRole('button', { name: 'Save claim' }));
    await waitFor(() => expect(updateClaim).toHaveBeenCalledWith('L1', 'c2', { bid: 0, clearDrop: true }));
  });

  it('ignores answers that arrive after the market or the add flow moved on', async () => {
    const user = userEvent.setup();
    let release: (value: MarketPage) => void = () => undefined;
    let first = true;
    const listLeaguePlayers = vi.fn(async (_id: string, q: { position?: string }) => {
      if (first && q.position === 'QB') {
        first = false;
        return new Promise<MarketPage>((resolve) => {
          release = resolve;
        });
      }
      return page();
    });
    let answer: (value: Awaited<ReturnType<LeagueApi['previewClaim']>>) => void = () => undefined;
    const previewClaim = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<LeagueApi['previewClaim']>>>((resolve) => {
          answer = resolve;
        })
    );
    open('/leagues/L1/team/moves', {
      listLeaguePlayers,
      previewClaim,
      getRoster: vi.fn(async () => roster([]))
    });
    const list = await screen.findByRole('list', { name: 'Available players' });
    await user.click(screen.getByRole('button', { name: 'QB' }));
    await user.click(screen.getByRole('button', { name: 'RB' }));
    release(page([market('late', 'Late Answer')]));
    await waitFor(() =>
      expect(listLeaguePlayers).toHaveBeenLastCalledWith('L1', expect.objectContaining({ position: 'RB' }))
    );
    expect(within(list).queryByText('Late Answer')).not.toBeInTheDocument();
    // An empty roster has nobody to drop; closing the flow drops its pending preview.
    await user.click(within(list).getByRole('button', { name: "Add D'Andre Swift" }));
    const dialog = await screen.findByTestId('add-sheet');
    expect(within(dialog).queryByRole('button', { name: 'Drop someone too' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    answer({
      wouldSucceed: true,
      outcome: 'add_now',
      issues: [],
      processesAt: null,
      faabRemaining: 1,
      faabAfter: 1
    });
    await waitFor(() => expect(screen.queryByTestId('add-sheet')).not.toBeInTheDocument());
  });
});

describe('player cards from the workspace', () => {
  beforeEach(() => {
    restore = stubWide(true);
  });

  it('opens the shared player card from a market row, a roster row, and a claim', async () => {
    const user = userEvent.setup();
    open();
    const list = await screen.findByRole('list', { name: 'Available players' });
    await user.click(within(list).getByRole('button', { name: /^D'Andre Swift/ }));
    expect(await screen.findByLabelText("D'Andre Swift player card")).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Josh Allen, QB: moves' }));
    await user.click(within(screen.getByTestId('moves-qb')).getByRole('button', { name: 'Player card' }));
    expect(await screen.findByLabelText('Josh Allen player card')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(within(screen.getByTestId('claim-c1')).getByRole('button', { name: 'Tank Bigsby' }));
    expect(await screen.findByLabelText('Tank Bigsby player card')).toBeInTheDocument();
  });
});
