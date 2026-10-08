import type { Page, Route } from '@playwright/test';

/**
 * A busy Sunday afternoon for the live matchup (#193), served with `page.route` in the shape of
 * get_matchup / get_nfl_games / get_matchup_outlook (packages/server/openapi.json): 1pm games final
 * or in the fourth quarter, 4:25 games just under way (one not read yet), the night games to come,
 * and Seattle on bye. Players carry the server's per-player `game`, box score, and expected points.
 */

/** 4:40 PM Eastern, Sunday of week 4. */
export const NOW = '2026-10-04T20:40:00.000Z';

type State = 'pre' | 'in' | 'post';
interface Game {
  away: string;
  home: string;
  kickoff: string;
  state: State;
  awayScore: number | null;
  homeScore: number | null;
  period: number | null;
  clock: string | null;
  possession: string | null;
  redZone: boolean;
  downDistance: string | null;
  status: string | null;
}

const game = (away: string, home: string, kickoff: string, extra: Partial<Game> = {}): Game => ({
  away,
  home,
  kickoff,
  state: 'pre',
  awayScore: null,
  homeScore: null,
  period: null,
  clock: null,
  possession: null,
  redZone: false,
  downDistance: null,
  status: null,
  ...extra
});

const ONE = '2026-10-04T17:00:00.000Z';
const LATE = '2026-10-04T20:25:00.000Z';
export const SNF = '2026-10-05T00:20:00.000Z';
export const MNF = '2026-10-06T00:15:00.000Z';

export const GAMES: Game[] = [
  game('ATL', 'NO', ONE, { state: 'post', awayScore: 27, homeScore: 20, period: 4, status: 'Final' }),
  game('KC', 'JAX', ONE, { state: 'post', awayScore: 27, homeScore: 24, period: 4, status: 'Final' }),
  game('DET', 'CHI', ONE, { state: 'post', awayScore: 31, homeScore: 17, period: 4, status: 'Final' }),
  game('CIN', 'CLE', ONE, {
    state: 'in',
    awayScore: 20,
    homeScore: 23,
    period: 4,
    clock: '1:58',
    possession: 'CIN',
    downDistance: '3rd & 6 at CLE 41',
    status: '1:58 - 4th'
  }),
  game('WAS', 'NYG', ONE, {
    state: 'in',
    awayScore: 17,
    homeScore: 17,
    period: 4,
    clock: '0:48',
    possession: 'NYG',
    downDistance: '1st & 10 at NYG 30',
    status: '0:48 - 4th'
  }),
  game('DAL', 'PHI', LATE, {
    state: 'in',
    awayScore: 0,
    homeScore: 7,
    period: 1,
    clock: '9:12',
    possession: 'PHI',
    redZone: true,
    downDistance: '2nd & 4 at DAL 7',
    status: '9:12 - 1st'
  }),
  // Kicked off five minutes before the last read: the feed has not caught up yet.
  game('LAR', 'SF', LATE),
  game('MIN', 'GB', SNF),
  game('BUF', 'MIA', MNF)
];

const QUARTER = 900;
function progress(g: Game): number | null {
  if (g.state === 'post') return 1;
  if (g.state === 'pre') return Date.parse(g.kickoff) <= Date.parse(NOW) ? null : 0;
  if (g.period === null) return null;
  const [m = '0', s = '0'] = (g.clock ?? '7:30').split(':');
  return (
    Math.round((((g.period - 1) * QUARTER + QUARTER - (Number(m) * 60 + Number(s))) / 3600) * 1000) / 1000
  );
}

/** The server's per-player game (the `game` field of a roster entry). */
export interface PlayerGame {
  state: string;
  opponent: string | null;
  home: boolean | null;
  kickoff: string | null;
  period: number | null;
  clock: string | null;
  teamScore: number | null;
  opponentScore: number | null;
  possession: boolean;
  redZone: boolean;
  progress: number | null;
}

/** The server's `game` for a player on `team` (core `playerGame`). */
export function playerGame(team: string): PlayerGame {
  const g = GAMES.find((x) => x.home === team || x.away === team);
  if (g === undefined) {
    return {
      state: 'bye',
      opponent: null,
      home: null,
      kickoff: null,
      period: null,
      clock: null,
      teamScore: null,
      opponentScore: null,
      possession: false,
      redZone: false,
      progress: null
    };
  }
  const home = g.home === team;
  const started = Date.parse(g.kickoff) <= Date.parse(NOW);
  const state = g.state === 'post' ? 'final' : g.state === 'in' || started ? 'live' : 'upcoming';
  const live = state === 'live';
  return {
    state,
    opponent: home ? g.away : g.home,
    home,
    kickoff: g.kickoff,
    period: state === 'upcoming' ? null : g.period,
    clock: live ? g.clock : null,
    teamScore: state === 'upcoming' ? null : home ? g.homeScore : g.awayScore,
    opponentScore: state === 'upcoming' ? null : home ? g.awayScore : g.homeScore,
    possession: live && g.possession === team,
    redZone: live && g.possession === team && g.redZone,
    progress: progress(g)
  };
}

const OUT = ['out', 'ir'];

interface Spec {
  id: string;
  name: string;
  position: string;
  team: string;
  slot: string;
  projected: number | null;
  points?: number | null;
  statLine?: string | null;
  status?: string;
  injuryStatus?: string | null;
}

/** A roster entry as the server sends it, with its expected final points. */
export function entry(spec: Spec) {
  const g = playerGame(spec.team);
  const points = spec.points ?? null;
  const status = spec.status ?? 'active';
  const projected = spec.projected;
  const current = points ?? 0;
  const willNotPlay = g.state === 'bye' || OUT.includes(status);
  let expected: number;
  if (g.state === 'final' || willNotPlay) expected = current;
  else if (g.state === 'live') {
    const left = g.progress === null ? 0.5 : 1 - g.progress;
    expected = current + Math.max((projected ?? 0) - current, 0) * left;
  } else expected = projected ?? 0;
  return {
    player: { id: spec.id, name: spec.name, team: spec.team, position: spec.position },
    slot: spec.slot,
    status,
    injuryStatus: spec.injuryStatus ?? null,
    byeWeek: spec.team === 'SEA' ? 4 : 9,
    onBye: g.state === 'bye',
    kickoff: g.kickoff,
    opponent: g.opponent === null ? null : { team: g.opponent, home: g.home },
    locked: g.state === 'live' || g.state === 'final',
    projectedPoints: projected,
    points,
    game: g,
    expectedPoints: Math.round(expected * 100) / 100,
    statLine: spec.statLine ?? null
  };
}

const MINE: Spec[] = [
  {
    id: 'fx-hurts',
    name: 'Jalen Hurts',
    position: 'QB',
    team: 'PHI',
    slot: 'QB',
    projected: 21.3,
    points: 4.32,
    statLine: '5/7 · 58 yds · 12 rush yds'
  },
  {
    id: 'fx-chase',
    name: "Ja'Marr Chase",
    position: 'WR',
    team: 'CIN',
    slot: 'WR',
    projected: 18.2,
    points: 14.6,
    statLine: '6/9 rec · 86 yds'
  },
  {
    id: 'fx-mclaurin',
    name: 'Terry McLaurin',
    position: 'WR',
    team: 'WAS',
    slot: 'WR',
    projected: 12,
    points: 6.4,
    statLine: '3/6 rec · 34 yds'
  },
  { id: 'fx-jsn', name: 'Jaxon Smith-Njigba', position: 'WR', team: 'SEA', slot: 'WR', projected: 13.1 },
  {
    id: 'fx-bijan',
    name: 'Bijan Robinson',
    position: 'RB',
    team: 'ATL',
    slot: 'RB',
    projected: 16.9,
    points: 23.4,
    statLine: '22 car · 118 yds · 3/4 rec · 21 rec yds · 1 TD'
  },
  { id: 'fx-cmc', name: 'Christian McCaffrey', position: 'RB', team: 'SF', slot: 'RB', projected: 18.2 },
  {
    id: 'fx-kelce',
    name: 'Travis Kelce',
    position: 'TE',
    team: 'KC',
    slot: 'TE',
    projected: 9.4,
    points: 8.7,
    statLine: '5/6 rec · 57 yds'
  },
  {
    id: 'fx-jjefferson',
    name: 'Justin Jefferson',
    position: 'WR',
    team: 'MIN',
    slot: 'W/R/T',
    projected: 17.4
  },
  {
    id: 'fx-butker',
    name: 'Harrison Butker',
    position: 'K',
    team: 'KC',
    slot: 'K',
    projected: 8.1,
    points: 9,
    statLine: '2/2 FG · 3/3 XP'
  },
  { id: 'fx-def-sf', name: '49ers', position: 'DEF', team: 'SF', slot: 'DEF', projected: 7 },
  {
    id: 'fx-mahomes',
    name: 'Patrick Mahomes',
    position: 'QB',
    team: 'KC',
    slot: 'BN',
    projected: 20.5,
    points: 24.1,
    statLine: '24/33 · 281 yds · 2 TD'
  },
  {
    id: 'fx-lamb',
    name: 'CeeDee Lamb',
    position: 'WR',
    team: 'DAL',
    slot: 'BN',
    projected: 16.8,
    points: 1.2,
    statLine: '1/2 rec · 12 yds'
  },
  { id: 'fx-kwalker', name: 'Kenneth Walker III', position: 'RB', team: 'SEA', slot: 'BN', projected: 12.2 },
  {
    id: 'fx-rice',
    name: 'Rashee Rice',
    position: 'WR',
    team: 'KC',
    slot: 'BN',
    projected: 11,
    status: 'out',
    injuryStatus: 'Out'
  }
];

const THEIRS: Spec[] = [
  { id: 'fx-jallen', name: 'Josh Allen', position: 'QB', team: 'BUF', slot: 'QB', projected: 22.8 },
  {
    id: 'fx-nabers',
    name: 'Malik Nabers',
    position: 'WR',
    team: 'NYG',
    slot: 'WR',
    projected: 15.6,
    points: 9.1,
    statLine: '6/10 rec · 61 yds'
  },
  { id: 'fx-tyhill', name: 'Tyreek Hill', position: 'WR', team: 'MIA', slot: 'WR', projected: 15 },
  { id: 'fx-ajbrown', name: 'A.J. Brown', position: 'WR', team: 'PHI', slot: 'WR', projected: 14.9 },
  {
    id: 'fx-gibbs',
    name: 'Jahmyr Gibbs',
    position: 'RB',
    team: 'DET',
    slot: 'RB',
    projected: 18.4,
    points: 27.8,
    statLine: '18 car · 97 yds · 5/5 rec · 41 rec yds · 2 TD'
  },
  { id: 'fx-kyrenw', name: 'Kyren Williams', position: 'RB', team: 'LAR', slot: 'RB', projected: 15.2 },
  {
    id: 'fx-kittle',
    name: 'George Kittle',
    position: 'TE',
    team: 'SF',
    slot: 'TE',
    projected: 10.2,
    status: 'out',
    injuryStatus: 'Out'
  },
  { id: 'fx-addison', name: 'Jordan Addison', position: 'WR', team: 'MIN', slot: 'W/R/T', projected: 11.3 },
  {
    id: 'fx-elliott',
    name: 'Jake Elliott',
    position: 'K',
    team: 'PHI',
    slot: 'K',
    projected: 8,
    points: 1,
    statLine: '1/1 XP'
  },
  {
    id: 'fx-def-kc',
    name: 'Chiefs',
    position: 'DEF',
    team: 'KC',
    slot: 'DEF',
    projected: 6.5,
    points: 4,
    statLine: '24 pts allowed · 2 sacks'
  },
  { id: 'fx-lamar', name: 'Lamar Jackson', position: 'QB', team: 'BAL', slot: 'BN', projected: 21 },
  { id: 'fx-jtaylor', name: 'Jonathan Taylor', position: 'RB', team: 'IND', slot: 'BN', projected: 14 }
];

const STARTER = (slot: string) => slot !== 'BN' && slot !== 'IR';

function lineup(teamId: string, specs: Spec[]) {
  const players = specs.map(entry);
  const starters = players.filter((p) => STARTER(p.slot));
  const cents = (n: number) => Math.round(n * 100);
  const points = starters.reduce((s, p) => s + cents(p.points ?? 0), 0) / 100;
  const projectedPoints = starters.reduce((s, p) => s + cents(p.expectedPoints), 0) / 100;
  return { teamId, points, projectedPoints, players };
}

export function matchup() {
  const home = lineup('team-1', MINE);
  const away = lineup('team-2', THEIRS);
  return {
    week: 4,
    teamId: 'team-1',
    matchup: {
      id: 'W04-M1',
      status: 'in_progress',
      home: { teamId: 'team-1', teamName: "Allen's Team", score: home.points, manager: null },
      away: {
        teamId: 'team-2',
        teamName: 'The Spreadsheet',
        score: away.points,
        manager: { name: 'Ada', avatarSeed: 'ada-seed', personality: 'The Spreadsheet' }
      }
    },
    lineups: { home, away }
  };
}

export function nflGames() {
  return {
    season: 2026,
    week: 4,
    games: GAMES.map((g) => ({
      gameId: `2026_04_${g.away}_${g.home}`,
      homeTeam: g.home,
      awayTeam: g.away,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      kickoff: g.kickoff,
      state: g.state,
      status: g.status,
      period: g.period,
      clock: g.clock,
      possessionTeam: g.possession,
      isRedZone: g.redZone,
      downDistance: g.downDistance,
      fieldPosition: g.redZone ? 'DAL 7' : null,
      yardsToGoal: g.redZone ? 7 : g.possession === null ? null : 60
    })),
    redZone: GAMES.filter((g) => g.redZone && g.possession !== null).map((g) => ({
      team: g.possession as string,
      downDistance: g.downDistance,
      fieldPosition: 'DAL 7'
    })),
    updatedAt: '2026-10-04T20:30:00.000Z'
  };
}

export function outlook() {
  const m = matchup();
  const side = (l: ReturnType<typeof lineup>, name: string, teamId: string, win: number) => {
    const starters = l.players.filter((p) => STARTER(p.slot));
    const count = (state: string) => starters.filter((p) => p.game.state === state).length;
    const out = starters.filter((p) => p.game.state !== 'final' && OUT.includes(p.status)).length;
    const live = starters.filter((p) => p.game.state === 'live' && OUT.includes(p.status)).length;
    return {
      teamId,
      teamName: name,
      currentPoints: l.points,
      projectedPoints: l.projectedPoints,
      remainingPoints: Math.round((l.projectedPoints - l.points) * 100) / 100,
      stdDev: 14,
      playersYetToPlay: count('upcoming') - (out - live),
      playersInProgress: count('live') - live,
      playersDone: count('final'),
      playersNotPlaying: count('bye') + out,
      winProbability: win
    };
  };
  return {
    week: 4,
    teamId: 'team-1',
    status: 'in_progress',
    you: side(m.lineups.home, "Allen's Team", 'team-1', 0.42),
    opponent: side(m.lineups.away, 'The Spreadsheet', 'team-2', 0.58),
    insights: {
      startersOut: [],
      emptySlots: [],
      benchUpgrades: [],
      lockedPlayers: m.lineups.home.players.filter((p) => p.locked).map((p) => p.player),
      currentProjectedPoints: 141.6,
      optimalProjectedPoints: 141.6
    },
    opponentWeakSpots: []
  };
}

const envelope = (data: unknown) => ({
  data,
  league: { id: 'L1', phase: 'regular_season', week: 4, allowedActions: ['set_lineup'] },
  warnings: []
});

/** The API stand-in for the live matchup, with the realtime stand-in turned on. */
export async function stubLiveMatchup(page: Page, overrides: { matchup?: () => unknown } = {}) {
  const reads = { matchup: 0, nfl: 0 };
  const json = (route: Route, data: unknown) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope(data)) });
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not stubbed.', fix: 'None.' } })
    })
  );
  await page.route('**/api/v1/leagues/L1/state', (route) =>
    json(route, {
      leagueId: 'L1',
      name: 'Sunday League',
      phase: 'regular_season',
      week: 4,
      allowedActions: ['set_lineup'],
      yourTeam: { id: 'team-1', name: "Allen's Team" }
    })
  );
  await page.route(/\/api\/v1\/leagues\/L1\/matchup(\?|$)/, (route) => {
    reads.matchup++;
    return json(route, (overrides.matchup ?? matchup)());
  });
  await page.route(/\/api\/v1\/leagues\/L1\/matchup\/outlook/, (route) => json(route, outlook()));
  await page.route(/\/api\/v1\/leagues\/L1\/matchup\/scoring-log/, (route) =>
    json(route, { week: 4, teamId: 'team-1', matchupId: 'W04-M1', entries: [], nextCursor: null })
  );
  await page.route(/\/api\/v1\/leagues\/L1\/nfl-games/, (route) => {
    reads.nfl++;
    return json(route, nflGames());
  });
  await page.route('**/api/v1/leagues/L1/realtime', (route) =>
    json(route, {
      enabled: true,
      httpHost: 'api.example',
      realtimeHost: 'realtime.example',
      channels: { league: '/fantasy/league/L1', global: '/fantasy/global', team: null },
      refreshAt: null,
      pollIntervalSeconds: 30
    })
  );
  return reads;
}

declare global {
  interface Window {
    __pushFantasyEvent?: (event: {
      detailType: string;
      leagueId: string | null;
      detail?: Record<string, unknown>;
    }) => void;
    __fantasyChannels?: string[];
  }
}

/**
 * Signs in with a stand-in session (the API is stubbed, so no dev user is needed) and stands in for
 * AppSync Events: the test pushes relayed events with `window.__pushFantasyEvent`.
 */
export async function signInStubbed(page: Page) {
  const b64 = (value: string) => Buffer.from(value).toString('base64url');
  const token = [
    b64(JSON.stringify({ alg: 'none' })),
    b64(JSON.stringify({ sub: 'allen', email: 'allen@example.com', given_name: 'Allen', family_name: 'H' })),
    'sig'
  ].join('.');
  await page.route('**/auth-config.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ region: 'us-east-1', userPoolId: 'us-east-1_e2e', clientId: 'e2e-client' })
    })
  );
  await page.addInitScript((idToken) => {
    localStorage.setItem(
      'rsc:auth',
      JSON.stringify({ idToken, refreshToken: 'refresh', expiresAt: 4_102_444_800_000 })
    );
    window.__fantasyEvents = async (target, handlers) => {
      window.__fantasyChannels = target.channels;
      window.__pushFantasyEvent = handlers.onEvent;
      return () => undefined;
    };
  }, token);
}
