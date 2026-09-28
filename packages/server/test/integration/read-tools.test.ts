import { computeStandings } from '@fantasy/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../../src/operations/index.js';
import { fixturePlayers } from '../../src/players/fixtures.js';
import type { Player } from '../../src/players/model.js';
import { createHarness, type Harness } from '../support/harness.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE, BOB, CAROL } from '../support/leagues.js';
import { SEASON, seedNflSchedule, seedSeasonLeague, THURSDAY_KICKOFF } from '../support/season.js';

/**
 * The read tools (#35) and get_matchup_outlook (#36) over HTTP: compact by default, `detail: true`
 * for full records, players always as {id, name, team, position}. team-1 is Alice's, team-2 an
 * agent seat, team-3 Bob's; Carol is not in the league.
 */

const L = '/leagues/lg-reads';
let h: Harness;
let alice: Caller;
let bob: Caller;
let carol: Caller;

const injured: Record<string, string> = { 'fx-cmc': 'Out', 'fx-arsb': 'Questionable', 'fx-kyrenw': 'IR' };
const players: Player[] = fixturePlayers.map((p) => ({ ...p, injuryStatus: injured[p.id] ?? null }));

const PROJECTED: Record<string, number> = {
  'fx-jallen': 250, // passing yards: 10 points
  'fx-bijan': 100, // rushing yards: 10 points
  'fx-bhall': 150, // 15
  'fx-cmc': 200, // 20, but he is out
  'fx-chase': 180,
  'fx-jjefferson': 170,
  'fx-arsb': 80, // 8
  'fx-lamb': 200, // 20, on the bench
  'fx-kelce': 90,
  'fx-lamar': 300,
  'fx-jtaylor': 120,
  'fx-ajbrown': 150
};

const PLAYER_KEYS = ['id', 'name', 'position', 'team'];
const isRef = (p: Record<string, unknown>) => expect(Object.keys(p).sort()).toEqual(PLAYER_KEYS);

beforeAll(async () => {
  h = await createHarness({ registry, players });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  carol = as(h, CAROL);
  const deps = { repos: h.repos, reference: h.services.data.reference };
  await seedNflSchedule(deps.reference);
  await seedSeasonLeague(deps, { id: 'lg-reads', owners: [ALICE, null, BOB] });
  await seedSeasonLeague(deps, {
    id: 'lg-reads-setup',
    owners: [ALICE],
    overrides: { phase: 'setup', week: null },
    lineup: false
  });
  await deps.reference.projections.putSnapshot(
    { season: SEASON, week: 1, capturedAt: '2026-09-09T12:00:00.000Z', hash: 'reads', count: 12 },
    Object.entries(PROJECTED).map(([playerId, yards]) => ({
      playerId,
      season: SEASON,
      week: 1,
      stats: playerId === 'fx-jallen' ? { pass_yd: yards } : { rush_yd: yards }
    }))
  );
  await h.repos.waivers.addTransactions([
    {
      id: 'tx-1',
      leagueId: 'lg-reads',
      at: '2026-09-09T10:00:00.000Z',
      week: 1,
      type: 'add',
      teamId: 'team-1',
      addPlayerId: 'fx-kwalker',
      dropPlayerId: null,
      cost: null,
      claimId: null
    }
  ]);
  await h.services.data.reference.trending.put({
    type: 'add',
    capturedAt: '2026-09-09T12:00:00.000Z',
    lookbacks: { '24': [{ playerId: 'fx-arsb', count: 900 }] }
  });
});
afterAll(() => h.close());

describe('search_players filters', () => {
  it('filters by injury designation', async () => {
    const out = data<{ players: { id: string; injuryStatus?: string }[] }>(
      await alice.get('/players?injury=out&detail=true&limit=50')
    );
    expect(out.players.map((p) => p.id).sort()).toEqual(['fx-cmc', 'fx-kyrenw']);
    const q = data<{ players: { id: string }[] }>(await alice.get('/players?injury=questionable'));
    expect(q.players.map((p) => p.id)).toEqual(['fx-arsb']);
    const healthy = data<{ players: { id: string }[] }>(
      await alice.get('/players?injury=healthy&position=RB&limit=50')
    );
    expect(healthy.players.map((p) => p.id)).not.toContain('fx-cmc');
    const hurt = data<{ players: { id: string }[] }>(await alice.get('/players?injury=injured&limit=50'));
    expect(hurt.players).toHaveLength(4);
    const doubtful = data<{ players: unknown[] }>(await alice.get('/players?injury=doubtful'));
    expect(doubtful.players).toEqual([]);
  });

  it('combines injury with league availability', async () => {
    const out = data<{ players: { id: string; availability: { status: string } }[] }>(
      await alice.get(`/players?leagueId=lg-reads&injury=out&availability=rostered`)
    );
    expect(out.players.map((p) => p.id)).toEqual(['fx-cmc', 'fx-kyrenw']);
  });
});

describe('detail on the read tools', () => {
  it('get_league_state adds settings and team FAAB only with detail', async () => {
    const compact = data<{ teams: Record<string, unknown>[]; settings?: unknown }>(
      await alice.get(`${L}/state`)
    );
    expect(compact.settings).toBeUndefined();
    expect(compact.teams[0]).not.toHaveProperty('faabRemaining');
    const full = data<{ teams: Record<string, unknown>[]; settings: { teamCount: number } }>(
      await alice.get(`${L}/state?detail=true`)
    );
    expect(full.settings.teamCount).toBe(4);
    expect(full.teams[0]).toMatchObject({
      faabRemaining: 100,
      waiverPriority: expect.any(Number),
      rosterSize: 13
    });
  });

  it('get_roster and get_matchup add full player records and eligible slots with detail', async () => {
    const compact = data<{ players: { player: Record<string, unknown>; eligibleSlots?: string[] }[] }>(
      await alice.get(`${L}/teams/team-1/roster`)
    );
    isRef(compact.players[0]?.player as Record<string, unknown>);
    expect(compact.players[0]).not.toHaveProperty('eligibleSlots');
    const full = data<{ players: { player: { id: string; rank?: number }; eligibleSlots: string[] }[] }>(
      await alice.get(`${L}/teams/team-1/roster?detail=true`)
    );
    const kelce = full.players.find((p) => p.player.id === 'fx-kelce');
    expect(kelce).toMatchObject({ player: { rank: 45 }, eligibleSlots: ['TE', 'W/R/T'] });

    const matchup = data<{ lineups: { home: { players: { eligibleSlots?: string[] }[] } } }>(
      await alice.get(`${L}/matchup?detail=true`)
    );
    expect(matchup.lineups.home.players[0]?.eligibleSlots?.length).toBeGreaterThan(0);
  });

  it('get_standings adds game-by-game results with detail', async () => {
    const [league, teams, matchups] = await Promise.all([
      h.repos.leagues.get('lg-reads'),
      h.repos.teams.list('lg-reads'),
      h.repos.schedule.listMatchups('lg-reads', 1)
    ]);
    await h.repos.schedule.putMatchups(
      matchups.map((m, i) => ({ ...m, status: 'final' as const, homeScore: 100 + i, awayScore: 100 }))
    );
    await h.repos.schedule.putStandings({
      leagueId: 'lg-reads',
      week: 1,
      rows: computeStandings(league!.settings, [], { teamIds: teams.map((t) => t.id), seed: 's' }),
      computedAt: '2026-09-16T00:00:00.000Z'
    });
    const compact = data<{ standings: Record<string, unknown>[] }>(await alice.get(`${L}/standings`));
    expect(compact.standings[0]).not.toHaveProperty('results');
    const full = data<{ standings: { teamId: string; results: { week: number; result: string }[] }[] }>(
      await alice.get(`${L}/standings?detail=true`)
    );
    const results = full.standings.flatMap((s) => s.results);
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.result).sort()).toEqual(['L', 'T', 'T', 'W']);
    await h.repos.schedule.putMatchups(matchups);
  });

  it('get_trending_players and list_transactions add player detail on request', async () => {
    const trending = data<{ players: { player: Record<string, unknown> }[] }>(
      await alice.get('/players/trending')
    );
    isRef(trending.players[0]?.player as Record<string, unknown>);
    const detailed = data<{ players: { player: { injuryStatus: string } }[] }>(
      await alice.get('/players/trending?detail=true')
    );
    expect(detailed.players[0]?.player.injuryStatus).toBe('Questionable');

    const tx = data<{ transactions: { added: Record<string, unknown> }[] }>(
      await alice.get(`${L}/transactions`)
    );
    isRef(tx.transactions[0]?.added as Record<string, unknown>);
    const txFull = data<{ transactions: { added: { status: string } }[] }>(
      await alice.get(`${L}/transactions?detail=true`)
    );
    expect(txFull.transactions[0]?.added.status).toBe('active');
  });
});

interface Side {
  teamId: string;
  currentPoints: number;
  projectedPoints: number;
  winProbability: number | null;
  playersYetToPlay: number;
  playersInProgress: number;
  players?: { player: { id: string }; game: string; expectedPoints: number }[];
}
interface Outlook {
  week: number;
  status: string | null;
  you: Side;
  opponent: Side | null;
  insights: {
    startersOut: { player: { id: string }; reason: string }[];
    emptySlots: { slot: string }[];
    benchUpgrades: { player: { id: string }; replaces: { id: string } | null; slot: string; gain: number }[];
    lockedPlayers: { id: string }[];
    currentProjectedPoints: number;
    optimalProjectedPoints: number;
  };
  opponentWeakSpots: { slot: string; reason: string; edge: number; player: { id: string } | null }[];
}

describe('get_matchup_outlook', () => {
  it('projects both sides, gives a win probability, and flags the lineup', async () => {
    const res = await alice.get(`${L}/matchup/outlook`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const o = data<Outlook>(res);
    expect(o).toMatchObject({ week: 1, status: 'scheduled' });
    expect(o.you.teamId).toBe('team-1');
    expect(o.opponent).not.toBeNull();
    expect((o.you.winProbability ?? 0) + (o.opponent?.winProbability ?? 0)).toBeCloseTo(1, 10);
    expect(o.you.currentPoints).toBe(0);
    expect(o.you.playersYetToPlay).toBe(8); // nine starters, CMC ruled out
    expect(o.you).not.toHaveProperty('players');

    expect(o.insights.startersOut).toEqual([
      { player: expect.objectContaining({ id: 'fx-cmc' }), slot: 'RB', reason: 'out' }
    ]);
    expect(o.insights.benchUpgrades.map((u) => [u.player.id, u.replaces?.id, u.slot, u.gain])).toEqual([
      ['fx-bhall', 'fx-cmc', 'RB', 15],
      ['fx-lamb', 'fx-arsb', 'WR', 12]
    ]);
    expect(o.insights.lockedPlayers).toEqual([]);
    expect(o.insights.optimalProjectedPoints).toBeGreaterThan(o.insights.currentProjectedPoints);
    for (const u of o.insights.benchUpgrades) isRef(u.player as unknown as Record<string, unknown>);
    expect(Array.isArray(o.opponentWeakSpots)).toBe(true);
  });

  it('tracks live games: locked players, points so far, and players in progress', async () => {
    await h.services.data.reference.stats.putLines([
      {
        playerId: 'fx-kelce',
        season: SEASON,
        week: 1,
        stats: { rec: 3, rec_yd: 40 },
        updatedAt: THURSDAY_KICKOFF
      }
    ]);
    h.clock.set(new Date(Date.parse(THURSDAY_KICKOFF) + 60_000));
    try {
      const o = data<Outlook>(await alice.get(`${L}/matchup/outlook?detail=true`));
      expect(o.insights.lockedPlayers.map((p) => p.id).sort()).toEqual([
        'fx-butker',
        'fx-kelce',
        'fx-mahomes'
      ]);
      expect(o.you.currentPoints).toBe(5.5);
      expect(o.you.playersInProgress).toBe(2);
      const kelce = o.you.players?.find((p) => p.player.id === 'fx-kelce');
      expect(kelce).toMatchObject({ game: 'live' });
      expect(kelce?.expectedPoints).toBeGreaterThan(5.5);
      expect(o.opponent?.players?.length).toBeGreaterThan(0);
    } finally {
      h.clock.set('2026-09-10T12:00:00.000Z');
    }
  });

  it('reads any team for members, refuses outsiders, and warns before the schedule exists', async () => {
    const other = data<Outlook>(await bob.get(`${L}/matchup/outlook?teamId=team-1`));
    expect(other.you.teamId).toBe('team-1');
    expect(errorCode(await carol.get(`${L}/matchup/outlook`))).toBe('FORBIDDEN');
    const setup = await alice.get('/leagues/lg-reads-setup/matchup/outlook');
    expect(setup.status).toBe(200);
    expect((setup.body as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['NO_SCHEDULE_YET'])
    );
  });

  it('warns when a week has no projections or no game', async () => {
    const res = await alice.get(`${L}/matchup/outlook?week=2`);
    expect((res.body as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toContain(
      'NO_PROJECTIONS'
    );
    const noGame = await alice.get(`${L}/matchup/outlook?week=16`);
    expect(noGame.status, JSON.stringify(noGame.body)).toBe(200);
  });
});
