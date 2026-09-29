import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeagueApiContext, type LeagueApi } from '../../api/league';
import type {
  DashboardMatchup,
  DashboardStanding,
  DashboardTeam,
  LeagueDashboardData,
  Move,
  MyLeague
} from '../../api/types';
import type { EventConnect, LeagueEvent } from '../../realtime/leagueEvents';
import { dashboard, fakeApi } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';
import { compactRows, formatWhen, matchupLeader, STANDINGS_TOP } from './DashboardCards';
import { HOME_LEAGUE_KEY, pickLeague } from './HomeDashboard';
import { DASHBOARD_EVENTS, LeagueDashboard } from './LeagueDashboard';
import { MAX_MOVES, MORE_MOVES, MOVES_PAGE, moveWhen } from './MoveBoard';
import { initials, managerName } from './TeamBadge';
import { MatchupPage } from '../season/MatchupPage';

const person = (slot: number, name: string): DashboardTeam => ({
  teamId: `team-${slot}`,
  teamName: `${name}'s Team`,
  ownerName: name,
  manager: null
});
const ai = (slot: number, name: string): DashboardTeam => ({
  teamId: `team-${slot}`,
  teamName: `Bots ${slot}`,
  ownerName: null,
  manager: { name, avatarSeed: `seed-${slot}`, personality: 'The Spreadsheet' }
});
const ALICE = person(1, 'Alice');
const MARCUS = ai(2, 'Marcus Hale');
const BOB = person(3, 'Bob');
const NOVA = ai(4, 'Nova Park');

function game(
  id: string,
  home: DashboardTeam,
  away: DashboardTeam,
  scores: [number | null, number | null],
  status: DashboardMatchup['status'] = 'in_progress'
): DashboardMatchup {
  return {
    id,
    kind: 'regular',
    status,
    home: { ...home, score: scores[0], record: '2-1' },
    away: { ...away, score: scores[1], record: '1-2' }
  };
}

const standing = (team: DashboardTeam, rank: number): DashboardStanding => ({
  ...team,
  rank,
  record: `${10 - rank}-${rank}`,
  pointsFor: 400 - rank * 10,
  streak: rank === 1 ? 'W3' : null
});

const player = (id: string, name: string, position = 'RB', team: string | null = 'SF') => ({
  id,
  name,
  position,
  team
});

const MOVES: Move[] = [
  {
    id: 'tr-1',
    type: 'trade',
    at: '2026-09-24T15:00:00.000Z',
    week: 3,
    teams: [
      { ...ALICE, added: [player('p1', 'Bijan Robinson')], dropped: [], cost: null },
      {
        ...MARCUS,
        added: [player('p2', 'Christian McCaffrey'), player('p3', 'Jake Moody', 'K', null)],
        dropped: [player('p4', 'Zach Charbonnet')],
        cost: null
      }
    ]
  },
  {
    id: 'w-1',
    type: 'waiver',
    at: '2026-09-23T09:00:00.000Z',
    week: 3,
    teams: [{ ...NOVA, added: [player('p5', 'Puka Nacua', 'WR', 'LAR')], dropped: [], cost: 17 }]
  },
  {
    id: 'a-1',
    type: 'add',
    at: '2026-09-22T12:00:00.000Z',
    week: 3,
    teams: [
      {
        ...BOB,
        added: [player('p6', 'Tank Dell', 'WR', 'HOU')],
        dropped: [player('p7', 'Old Guy')],
        cost: null
      }
    ]
  },
  {
    id: 'd-1',
    type: 'drop',
    at: '2026-09-21T12:00:00.000Z',
    week: 3,
    teams: [{ ...BOB, added: [], dropped: [player('p8', 'Cut Man')], cost: null }]
  }
];

function inSeason(overrides: Partial<LeagueDashboardData> = {}): LeagueDashboardData {
  return dashboard({
    phase: 'regular_season',
    week: 3,
    draft: null,
    matchups: [game('W03-M1', BOB, NOVA, [88.5, 70]), game('W03-M2', MARCUS, ALICE, [101.25, 110.5])],
    standings: {
      throughWeek: 2,
      rows: [standing(BOB, 1), standing(MARCUS, 2), standing(ALICE, 3), standing(NOVA, 4)]
    },
    moves: MOVES,
    hasMoreMoves: true,
    ...overrides
  });
}

const REALTIME_ON = {
  enabled: true,
  token: 't',
  endpoint: null,
  cacheName: 'c',
  topics: { league: 'fantasy.league.L1', global: 'fantasy.global' },
  expiresAt: null,
  pollIntervalSeconds: 30
};

function mount(overrides: Partial<LeagueApi> = {}) {
  let push: (event: LeagueEvent) => void = () => undefined;
  const connect: EventConnect = async (_target, handlers) => {
    push = handlers.onEvent;
    return () => undefined;
  };
  const api = fakeApi({ getLeagueDashboard: vi.fn(async () => inSeason()), ...overrides });
  render(
    <LeagueApiContext.Provider value={api}>
      <MemoryRouter initialEntries={['/leagues/L1/home']}>
        <Routes>
          <Route
            path="/leagues/:leagueId/home"
            element={<LeagueDashboard leagueId="L1" connect={connect} />}
          />
        </Routes>
      </MemoryRouter>
    </LeagueApiContext.Provider>
  );
  return { api, push: (event: LeagueEvent) => act(() => push(event)) };
}

afterEach(() => vi.restoreAllMocks());

describe('helpers', () => {
  it('names managers and draws initials', () => {
    expect(managerName(ALICE)).toBe('Alice');
    expect(managerName(MARCUS)).toBe('Marcus Hale');
    expect(managerName({ ...ALICE, ownerName: null })).toBe('Open seat');
    expect(initials('Alice Smith Jones')).toBe('AS');
    expect(initials('bob')).toBe('B');
    expect(initials(' — ')).toBe('?');
  });

  it('finds the leader, keeps your row in the compact standings, and dates moves', () => {
    expect(matchupLeader(game('m', ALICE, BOB, [10, 12]))).toBe('team-3');
    expect(matchupLeader(game('m', ALICE, BOB, [12, 10]))).toBe('team-1');
    expect(matchupLeader(game('m', ALICE, BOB, [10, 10]))).toBeNull();
    expect(matchupLeader(game('m', ALICE, BOB, [null, null], 'scheduled'))).toBeNull();
    const rows = Array.from({ length: 10 }, (_, i) => standing(person(i + 1, `P${i + 1}`), i + 1));
    expect(compactRows(rows, 'team-9').map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 9]);
    expect(compactRows(rows, 'team-2')).toHaveLength(STANDINGS_TOP);
    expect(compactRows(rows, null)).toHaveLength(STANDINGS_TOP);
    expect(moveWhen({ at: '2026-09-24T15:00:00.000Z', week: 3 })).toMatch(/^Week 3 · /);
    expect(formatWhen('2026-09-12T00:00:00.000Z')).toBe(
      new Date('2026-09-12T00:00:00.000Z').toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
    );
  });

  it('picks the remembered league, else the liveliest one', () => {
    const league = (id: string, phase: MyLeague['phase']) => ({ id, phase }) as MyLeague;
    const leagues = [league('a', 'setup'), league('b', 'complete'), league('c', 'playoffs')];
    expect(pickLeague(leagues, 'b')?.id).toBe('b');
    expect(pickLeague(leagues, 'gone')?.id).toBe('c');
    expect(pickLeague([league('a', 'setup'), league('d', 'drafting')], null)?.id).toBe('d');
    expect(pickLeague([], null)).toBeNull();
  });
});

describe('the league dashboard', () => {
  it('shows your matchup first and highlighted, with live scores and managers', async () => {
    mount();
    const matchups = await screen.findByRole('region', { name: 'Matchups' });
    expect(within(matchups).getByRole('heading', { name: 'Week 3 matchups' })).toBeInTheDocument();
    const tiles = within(matchups).getAllByRole('link');
    expect(tiles[0]).toHaveAttribute('data-yours', 'true');
    expect(tiles[0]).toHaveAttribute('href', '/leagues/L1/team/matchup');
    expect(tiles[0]).toHaveTextContent('Your matchup');
    expect(tiles[0]).toHaveTextContent("Alice's Team (you)");
    expect(tiles[0]).toHaveTextContent('Marcus Hale · 2-1');
    expect(within(tiles[0]!).getByRole('img', { name: 'Marcus Hale avatar' })).toBeInTheDocument();
    expect(tiles[1]).not.toHaveAttribute('data-yours');
    expect(tiles[1]).toHaveAttribute('href', '/leagues/L1/team/matchup?team=team-3');
    expect(within(matchups).getAllByText('Live').length).toBeGreaterThan(1);
    await waitFor(() => expect(screen.getByTestId('dashboard-score-team-1')).toHaveTextContent('110.50'));
  });

  it('shows results, upcoming games, and a week with no games', async () => {
    mount({
      getLeagueDashboard: vi.fn(async () =>
        inSeason({
          matchups: [
            game('W03-M1', BOB, NOVA, [null, null], 'final'),
            game('W03-M2', MARCUS, ALICE, [90, 80], 'final')
          ]
        })
      )
    });
    const matchups = await screen.findByRole('region', { name: 'Matchups' });
    expect(within(matchups).getByRole('heading', { name: 'Week 3 results' })).toBeInTheDocument();
    expect(within(matchups).getAllByText('Final')).toHaveLength(2);
    expect(within(matchups).getAllByText('–')).toHaveLength(2);
  });

  it('labels playoff games, and an open seat by its team', async () => {
    const open = { ...person(5, 'x'), ownerName: null, teamName: 'Zed Squad' };
    mount({
      getLeagueDashboard: vi.fn(async () =>
        inSeason({ matchups: [{ ...game('P-1', BOB, open, [1, 2]), kind: 'playoff' }] })
      )
    });
    const matchups = await screen.findByRole('region', { name: 'Matchups' });
    expect(within(matchups).getByText('Playoffs')).toBeInTheDocument();
    expect(within(matchups).getByText('Open seat · 1-2')).toBeInTheDocument();
    expect(
      within(matchups)
        .getAllByTestId('initials-avatar')
        .map((a) => a.textContent)
    ).toEqual(['ZS', 'B']);
  });

  it('says when there are no games this week', async () => {
    mount({ getLeagueDashboard: vi.fn(async () => inSeason({ matchups: [], week: null })) });
    const matchups = await screen.findByRole('region', { name: 'Matchups' });
    expect(within(matchups).getByRole('heading', { name: 'Matchups' })).toBeInTheDocument();
    expect(within(matchups).getByText('No games this week.')).toBeInTheDocument();
  });

  it('shows compact standings with your row highlighted and a link to the full table', async () => {
    mount();
    const standings = await screen.findByRole('region', { name: 'Standings' });
    expect(within(standings).getByText('Through week 2')).toBeInTheDocument();
    const rows = within(standings).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[2]).toHaveAttribute('aria-current', 'true');
    expect(rows[2]).toHaveTextContent("Alice's Team (you)");
    expect(rows[0]).toHaveTextContent('W3');
    expect(rows[1]).toHaveTextContent('Marcus Hale');
    expect(within(standings).getByRole('link', { name: 'Full standings' })).toHaveAttribute(
      'href',
      '/leagues/L1/league/standings'
    );
  });

  it('marks the gap before your row when you are outside the top rows', async () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      standing(i === 7 ? ALICE : person(i + 10, `P${i}`), i + 1)
    );
    mount({
      getLeagueDashboard: vi.fn(async () => inSeason({ standings: { throughWeek: null, rows } }))
    });
    const standings = await screen.findByRole('region', { name: 'Standings' });
    expect(within(standings).getByText('No games final yet')).toBeInTheDocument();
    const shown = within(standings).getAllByRole('listitem');
    expect(shown).toHaveLength(STANDINGS_TOP + 1);
    expect(shown.at(-1)).toHaveAttribute('aria-current', 'true');
    expect(shown.at(-1)?.className).toContain('border-dashed');
  });

  it('reads the move board as a feed: a trade, a waiver award, an add/drop, and a drop', async () => {
    mount();
    const board = await screen.findByRole('region', { name: 'Move board' });
    const feed = within(board).getByRole('list', { name: 'Latest moves' });
    const trade = within(feed).getByRole('article', { name: "Trade: Alice's Team and Bots 2" });
    expect(within(trade).getByRole('list', { name: "Alice's Team gets" })).toHaveTextContent(
      'In: Bijan RobinsonRB · SF'
    );
    expect(within(trade).getByRole('list', { name: 'Bots 2 gets' })).toHaveTextContent('Jake MoodyK');
    expect(within(trade).getByRole('list', { name: 'Bots 2 drops' })).toHaveTextContent(
      'Out: Zach Charbonnet'
    );
    expect(trade).toHaveTextContent('(you)');
    expect(trade.className).toContain('border-primary-200');
    const waiver = within(feed).getByRole('article', { name: 'Waiver claim: Bots 4' });
    expect(waiver).toHaveTextContent('$17 FAAB');
    expect(within(waiver).getByRole('list', { name: 'Bots 4 wins' })).toHaveTextContent('Puka Nacua');
    const add = within(feed).getByRole('article', { name: "Free-agent add: Bob's Team" });
    expect(within(add).getByRole('list', { name: "Bob's Team adds" })).toHaveTextContent('Tank Dell');
    expect(within(add).getByRole('list', { name: "Bob's Team drops" })).toHaveTextContent('Old Guy');
    expect(within(add).getAllByTestId('initials-avatar')[0]).toHaveTextContent('B');
    expect(within(feed).getByRole('article', { name: "Drop: Bob's Team" })).toHaveTextContent('Cut Man');
  });

  it('shows an AI manager renaming its team on the move board (#194)', async () => {
    const rename: Move = {
      id: 'rename:team-2:2026-09-25T10:00:00.000Z',
      type: 'team_renamed',
      at: '2026-09-25T10:00:00.000Z',
      week: 3,
      teams: [{ ...MARCUS, teamName: 'Regression to the Mean', added: [], dropped: [], cost: null }],
      rename: { from: 'Bots 2', to: 'Regression to the Mean', by: 'agent' }
    };
    mount({ getLeagueDashboard: vi.fn(async () => inSeason({ moves: [rename, ...MOVES] })) });
    const board = await screen.findByRole('region', { name: 'Move board' });
    const card = within(board).getByRole('article', {
      name: 'New team name: Bots 2 is now Regression to the Mean'
    });
    expect(card).toHaveAttribute('data-testid', 'move-team_renamed');
    expect(card).toHaveTextContent('Regression to the Mean');
    expect(within(card).getByTestId('renamed-from')).toHaveTextContent(
      'Renamed from Bots 2 by its AI manager'
    );
    expect(card).toHaveTextContent('Week 3');
  });

  it('marks your own rename, by you, as yours (#194)', async () => {
    const rename: Move = {
      id: 'rename:team-1:2026-09-25T11:00:00.000Z',
      type: 'team_renamed',
      at: '2026-09-25T11:00:00.000Z',
      week: 3,
      teams: [{ ...ALICE, teamName: 'Gridiron Gang', added: [], dropped: [], cost: null }],
      rename: { from: "Alice's Team", to: 'Gridiron Gang', by: 'owner' }
    };
    mount({ getLeagueDashboard: vi.fn(async () => inSeason({ moves: [rename] })) });
    const card = await screen.findByRole('article', {
      name: "New team name: Alice's Team is now Gridiron Gang"
    });
    expect(card).toHaveTextContent('(you)');
    expect(within(card).getByTestId('renamed-from')).toHaveTextContent(
      "Renamed from Alice's Team by its manager"
    );
  });

  it('shows more moves on demand, then links to every transaction', async () => {
    const user = userEvent.setup();
    const getLeagueDashboard = vi.fn(async (_id: string, query: { moves?: number } = {}) =>
      inSeason({ hasMoreMoves: true, moves: (query.moves ?? 0) >= MAX_MOVES ? manyMoves(MAX_MOVES) : MOVES })
    );
    mount({ getLeagueDashboard });
    const board = await screen.findByRole('region', { name: 'Move board' });
    expect(getLeagueDashboard).toHaveBeenLastCalledWith('L1', { moves: MOVES_PAGE });
    await user.click(within(board).getByRole('button', { name: 'Show more' }));
    await waitFor(() =>
      expect(getLeagueDashboard).toHaveBeenLastCalledWith('L1', { moves: MOVES_PAGE + MORE_MOVES })
    );
    for (let i = 0; i < 4; i++) await user.click(within(board).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(getLeagueDashboard).toHaveBeenLastCalledWith('L1', { moves: MAX_MOVES }));
    expect(await within(board).findByRole('link', { name: 'See every transaction' })).toHaveAttribute(
      'href',
      '/leagues/L1/league/transactions'
    );
  });

  it('says so when nothing has happened yet', async () => {
    mount({ getLeagueDashboard: vi.fn(async () => inSeason({ moves: [], hasMoreMoves: false })) });
    const board = await screen.findByRole('region', { name: 'Move board' });
    expect(board).toHaveTextContent('No moves yet.');
    expect(within(board).queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('refreshes on live league events, and a new move pops in', async () => {
    let moves = MOVES.slice(1);
    const getLeagueDashboard = vi.fn(async () => inSeason({ moves }));
    const { push } = mount({ getLeagueDashboard, getRealtime: vi.fn(async () => REALTIME_ON) });
    const board = await screen.findByRole('region', { name: 'Move board' });
    await waitFor(() => expect(getLeagueDashboard).toHaveBeenCalledTimes(1));
    moves = MOVES;
    await waitFor(() => push({ detailType: 'Trade Processed', leagueId: 'L1' }));
    const trade = await within(board).findByRole('article', { name: "Trade: Alice's Team and Bots 2" });
    expect(trade.parentElement).toHaveClass('motion-pop');
    expect(
      within(board).getByRole('article', { name: 'Waiver claim: Bots 4' }).parentElement
    ).not.toHaveClass('motion-pop');
    expect(DASHBOARD_EVENTS).toContain('Scores Updated');
  });

  it('shows an error', async () => {
    mount({ getLeagueDashboard: vi.fn(async () => Promise.reject(new Error('offline'))) });
    expect(await screen.findByText('offline')).toBeInTheDocument();
  });
});

describe('before and after the season', () => {
  const draft = (overrides: Partial<NonNullable<LeagueDashboardData['draft']>>) =>
    dashboard({ phase: 'drafting', draft: { ...dashboard().draft!, ...overrides } });

  it('shows when the draft starts and how many seats are filled', async () => {
    mount({
      getLeagueDashboard: vi.fn(async () =>
        dashboard({ draft: { ...dashboard().draft!, scheduledAt: '2026-09-12T00:00:00.000Z' } })
      )
    });
    const card = await screen.findByRole('region', { name: 'Draft' });
    expect(card).toHaveTextContent(`Starts ${formatWhen('2026-09-12T00:00:00.000Z')}`);
    expect(card).toHaveTextContent('3 of 4 seats filled · 1 open');
    expect(within(card).getByRole('progressbar', { name: 'Seats filled' })).toHaveAttribute(
      'aria-valuenow',
      '3'
    );
    expect(within(card).getByRole('link', { name: 'Open the draft lobby' })).toHaveAttribute(
      'href',
      '/leagues/L1/draft'
    );
    expect(screen.queryByRole('region', { name: 'Matchups' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Move board' })).toBeNull();
  });

  it('shows a draft the commissioner starts by hand, with every seat filled', async () => {
    mount({
      getLeagueDashboard: vi.fn(async () =>
        dashboard({ draft: { ...dashboard().draft!, seatsFilled: 4, seats: 4 } })
      )
    });
    const card = await screen.findByRole('region', { name: 'Draft' });
    expect(card).toHaveTextContent('The commissioner starts the draft.');
    expect(card).toHaveTextContent('4 of 4 seats filled');
    expect(card).not.toHaveTextContent('open');
  });

  it('shows who is on the clock and when you pick', async () => {
    const clock = { ...MARCUS, overall: 5, round: 2 };
    const getLeagueDashboard = vi
      .fn()
      .mockResolvedValueOnce(
        draft({ status: 'in_progress', picksMade: 4, totalPicks: 60, onTheClock: clock, yourPickIn: 0 })
      )
      .mockResolvedValue(
        draft({ status: 'paused', picksMade: 4, totalPicks: 60, onTheClock: clock, yourPickIn: 3 })
      );
    const { push } = mount({ getLeagueDashboard, getRealtime: vi.fn(async () => REALTIME_ON) });
    const card = await screen.findByRole('region', { name: 'Draft' });
    expect(card).toHaveTextContent('The draft is live');
    expect(card).toHaveTextContent('4 of 60 picks made');
    expect(card).toHaveTextContent('On the clock · Round 2, pick 5');
    expect(card).toHaveTextContent('Bots 2');
    expect(within(card).getByText("You're on the clock!")).toHaveClass('motion-attention');
    expect(within(card).getByRole('link', { name: 'Go to the draft room' })).toHaveAttribute(
      'href',
      '/leagues/L1/draft'
    );
    await waitFor(() => push({ detailType: 'Draft Paused', leagueId: 'L1' }));
    expect(await within(card).findByText('Paused')).toBeInTheDocument();
    expect(card).toHaveTextContent('Your pick is 3 picks away.');
  });

  it('counts one pick away, and a finished draft', async () => {
    mount({
      getLeagueDashboard: vi
        .fn()
        .mockResolvedValue(draft({ status: 'complete', picksMade: 60, totalPicks: 60, yourPickIn: 1 }))
    });
    const card = await screen.findByRole('region', { name: 'Draft' });
    expect(card).toHaveTextContent('The draft is done');
    expect(card).toHaveTextContent('Your pick is 1 pick away.');
  });

  it('crowns the champion', async () => {
    mount({ getLeagueDashboard: vi.fn(async () => inSeason({ phase: 'complete', champion: MARCUS })) });
    const banner = await screen.findByRole('region', { name: 'Champion' });
    expect(banner).toHaveTextContent('2026 champion');
    expect(banner).toHaveTextContent('Bots 2');
    expect(banner).toHaveTextContent('Marcus Hale');
  });

  it('congratulates you on your own title', async () => {
    mount({ getLeagueDashboard: vi.fn(async () => inSeason({ phase: 'complete', champion: ALICE })) });
    const banner = await screen.findByRole('region', { name: 'Champion' });
    expect(banner).toHaveTextContent('That’s you. Congratulations!');
    await waitFor(() => expect(banner.querySelector('canvas')).not.toBeNull());
  });
});

describe('home pages', () => {
  beforeEach(() => {
    localStorage.removeItem(HOME_LEAGUE_KEY);
    signInAs({ sub: 'alice', given_name: 'Alice' });
  });

  const myLeague = (id: string, name: string, phase: MyLeague['phase']): MyLeague => ({
    id,
    name,
    season: 2026,
    phase,
    week: phase === 'setup' ? null : 3,
    teamCount: 4,
    startWeek: 1,
    commissionerName: 'Alice',
    youAreCommissioner: true,
    yourTeamId: 'team-1',
    record: null
  });

  it('shows your only league’s dashboard on the home page', async () => {
    const getLeagueDashboard = vi.fn(async () => inSeason());
    renderApp(
      '/',
      undefined,
      fakeApi({
        listMyLeagues: vi.fn(async () => [myLeague('L1', 'Sunday Funday', 'regular_season')]),
        getLeagueDashboard
      })
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'Sunday Funday' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Matchups' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Choose a league' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'All leagues' })).toBeInTheDocument();
    expect(getLeagueDashboard).toHaveBeenCalledWith('L1', { moves: MOVES_PAGE });
  });

  it('picks between several leagues and remembers the choice', async () => {
    const user = userEvent.setup();
    const getLeagueDashboard = vi.fn(async (id: string) => inSeason({ leagueId: id }));
    const api = fakeApi({
      listMyLeagues: vi.fn(async () => [
        myLeague('L1', 'Sunday Funday', 'setup'),
        myLeague('L2', 'Work League', 'regular_season')
      ]),
      getLeagueDashboard
    });
    const { unmount } = renderApp('/', undefined, api);
    const picker = await screen.findByRole('tablist', { name: 'Choose a league' });
    expect(within(picker).getByRole('tab', { name: 'Work League' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 2, name: 'Work League' })).toBeInTheDocument();
    await waitFor(() => expect(getLeagueDashboard).toHaveBeenCalledWith('L2', { moves: MOVES_PAGE }));
    await user.click(within(picker).getByRole('tab', { name: 'Sunday Funday' }));
    expect(within(picker).getByRole('tab', { name: 'Sunday Funday' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await waitFor(() => expect(getLeagueDashboard).toHaveBeenCalledWith('L1', { moves: MOVES_PAGE }));
    expect(screen.getByRole('tabpanel', { name: 'Sunday Funday' })).toBeInTheDocument();
    expect(localStorage.getItem(HOME_LEAGUE_KEY)).toBe('L1');
    unmount();

    renderApp('/', undefined, api);
    expect(
      within(await screen.findByRole('tablist', { name: 'Choose a league' })).getByRole('tab', {
        name: 'Sunday Funday'
      })
    ).toHaveAttribute('aria-selected', 'true');
  });

  it('still works when storage is blocked', async () => {
    const user = userEvent.setup();
    const getItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key === HOME_LEAGUE_KEY) throw new Error('blocked');
      return getItem.call(this, key);
    });
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === HOME_LEAGUE_KEY) throw new Error('blocked');
      setItem.call(this, key, value);
    });
    renderApp(
      '/',
      undefined,
      fakeApi({
        listMyLeagues: vi.fn(async () => [
          myLeague('L1', 'Sunday Funday', 'drafting'),
          myLeague('L2', 'Work League', 'complete')
        ])
      })
    );
    const picker = await screen.findByRole('tablist', { name: 'Choose a league' });
    expect(within(picker).getByRole('tab', { name: 'Sunday Funday' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await user.click(within(picker).getByRole('tab', { name: 'Work League' }));
    expect(within(picker).getByRole('tab', { name: 'Work League' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe("another team's matchup", () => {
  it('opens from the dashboard with ?team=, without your outlook or celebration', async () => {
    const getMatchup = vi.fn(async () => ({
      week: 3,
      teamId: 'team-3',
      matchup: {
        id: 'W03-M1',
        status: 'final' as const,
        home: { teamId: 'team-3', teamName: "Bob's Team", score: 90, manager: null },
        away: { teamId: 'team-4', teamName: 'Bots 4', score: 80, manager: null }
      },
      lineups: {
        home: { teamId: 'team-3', points: 90, players: [] },
        away: { teamId: 'team-4', points: 80, players: [] }
      }
    }));
    const getScoringLog = vi.fn(async () => ({
      week: 3,
      teamId: 'team-3',
      matchupId: 'W03-M1',
      entries: [],
      nextCursor: null
    }));
    const api = fakeApi({ getMatchup, getScoringLog });
    render(
      <LeagueApiContext.Provider value={api}>
        <MemoryRouter initialEntries={['/leagues/L1/matchup?team=team-3']}>
          <Routes>
            <Route path="/leagues/:leagueId/matchup" element={<MatchupPage />} />
          </Routes>
        </MemoryRouter>
      </LeagueApiContext.Provider>
    );
    expect(await screen.findByRole('region', { name: "Bob's Team" })).toBeInTheDocument();
    expect(getMatchup).toHaveBeenCalledWith('L1', 'team-3');
    await waitFor(() =>
      expect(getScoringLog).toHaveBeenCalledWith('L1', expect.objectContaining({ teamId: 'team-3' }))
    );
    expect(screen.getByRole('link', { name: 'Back to your matchup' })).toHaveAttribute(
      'href',
      '/leagues/L1/matchup'
    );
    expect(api.getMatchupOutlook).not.toHaveBeenCalled();
    expect(screen.queryByText('You won week 3!')).toBeNull();
  });
});

function manyMoves(n: number): Move[] {
  return Array.from({ length: n }, (_, i) => ({ ...MOVES[3]!, id: `d-${i}` }));
}
