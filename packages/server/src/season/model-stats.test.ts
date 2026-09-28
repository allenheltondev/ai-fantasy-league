import { acceptTrade, computeStandings, proposeTrade, yahooDefaultSettings } from '@fantasy/core';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { newTeam } from '../league/seats.js';
import { silentLogger } from '../log.js';
import { fixturePlayers } from '../players/fixtures.js';
import { createInMemoryRepos } from '../repos/memory.js';
import { createInMemoryReferenceStore } from '../repos/memory-reference.js';
import type { League } from '../repos/types.js';
import type { TransactionRecord } from '../repos/waivers.js';
import { processAccepted } from '../trades/lifecycle.js';
import { loadTradeWorld } from '../trades/world.js';
import {
  leagueTransactions,
  modelLeaderboard,
  powerRankingLine,
  publishModelPowerRankings,
  valuedTrades,
  waiverOutcomes
} from './model-stats.js';

/**
 * Model stats (#76) over real processed trades and awarded claims: trade value won or lost,
 * waiver hit rate, the leaderboard roll-up by model, and the weekly power rankings post.
 */

const NOW = new Date('2026-09-10T12:00:00.000Z');
const LATER = new Date('2026-10-01T12:00:00.000Z');
const settings = yahooDefaultSettings(4);
settings.roster.slots = { QB: 1, RB: 1, BN: 2 };
settings.trades.review = 'none';

const league: League = {
  id: 'lg',
  name: 'L',
  season: 2026,
  phase: 'regular_season',
  week: 2,
  settings,
  commissionerId: 'u',
  commissionerName: 'U',
  createdBy: 'u',
  scheduleSeed: 's',
  deadlines: { draftStartsAt: null, nextLineupLockAt: null, nextWaiverRunAt: null, tradeDeadlineAt: null },
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  version: 1
};

const claim = (
  id: string,
  teamId: string,
  week: number,
  add: string,
  drop: string | null
): TransactionRecord => ({
  id,
  leagueId: 'lg',
  at: `2026-09-1${week}T10:00:00.000Z`,
  week,
  type: 'waiver_claim',
  teamId,
  addPlayerId: add,
  dropPlayerId: drop,
  cost: 3,
  claimId: `c-${id}`
});

async function setup() {
  const repos = createInMemoryRepos({ players: fixturePlayers });
  const reference = createInMemoryReferenceStore(repos.players);
  const events = new InMemoryEventPublisher();
  const log = { ...silentLogger, warn: vi.fn() };
  const deps = { repos, reference, events, log };
  await repos.leagues.create(league);
  const rosters: Record<string, string[]> = {
    A: ['fx-jallen', 'fx-cmc'],
    B: ['fx-mahomes', 'fx-bijan', 'fx-chase'],
    C: ['fx-kelce']
  };
  await repos.teams.create(
    Object.entries(rosters).map(([id, roster], i) => ({
      ...newTeam({ leagueId: 'lg', id, draftSlot: i + 1, settings, now: NOW }),
      name: `Team ${id}`,
      seatType: id === 'B' ? ('agent' as const) : ('human' as const),
      roster
    }))
  );
  await repos.agents.putSeat({
    leagueId: 'lg',
    teamId: 'B',
    agentId: 'lg.B',
    config: { personalityId: 'hype-man', difficulty: 'hall_of_famer', archetype: 'win_now' },
    version: 1,
    updatedAt: NOW.toISOString(),
    updatedBy: 'user#u'
  });
  // Week 2 projections (later weeks repeat them): cmc 20, bijan 15, jallen 25, the rest nothing.
  await reference.projections.putSnapshot(
    { season: 2026, week: 2, capturedAt: '2026-09-09T12:00:00.000Z', hash: 'ms', count: 3 },
    [
      { playerId: 'fx-cmc', season: 2026, week: 2, stats: { rush_yd: 200 } },
      { playerId: 'fx-bijan', season: 2026, week: 2, stats: { rush_yd: 150 } },
      { playerId: 'fx-jallen', season: 2026, week: 2, stats: { pass_yd: 625 } }
    ]
  );
  return { repos, reference, events, log, deps };
}

/** A sends cmc and jallen for B's bijan; B drops chase to make room. Processed in week 2. */
async function processTrade(s: Awaited<ReturnType<typeof setup>>) {
  const ctx = (await loadTradeWorld(s.deps, league, NOW)).context;
  const offer = proposeTrade(
    settings,
    {
      tradeId: 't1',
      sides: [
        { teamId: 'A', sends: ['fx-cmc', 'fx-jallen'], drops: [] },
        { teamId: 'B', sends: ['fx-bijan'], drops: [] }
      ],
      nextLockTime: null
    },
    ctx
  );
  if (!offer.ok) throw new Error('offer');
  const done = acceptTrade(settings, offer.trade, { byTeamId: 'B', drops: ['fx-chase'] }, ctx);
  if (!done.ok) throw new Error(JSON.stringify(done.issues));
  const record = {
    leagueId: 'lg',
    trade: done.trade,
    message: null,
    createdBy: 'user#u',
    processingAt: null,
    updatedAt: NOW.toISOString(),
    version: 1
  };
  await s.repos.trades.create(record);
  expect((await processAccepted(s.deps, league, record, NOW)).outcome).toBe('processed');
}

/** Three awarded claims: C's kelce for swift (a miss), A's swift (a hit), A's chase for bijan (a miss). */
async function seedClaims(s: Awaited<ReturnType<typeof setup>>) {
  await s.repos.waivers.addTransactions([
    claim('w1', 'C', 2, 'fx-kelce', 'fx-swift'),
    claim('w2', 'A', 3, 'fx-swift', null),
    claim('w3', 'A', 4, 'fx-chase', 'fx-bijan')
  ]);
  const lineup = (teamId: string, week: number, players: string[]) => ({
    leagueId: 'lg',
    teamId,
    week,
    entries: players.map((playerId) => ({ playerId, slot: 'BN' as const })),
    updatedAt: NOW.toISOString(),
    updatedBy: 'system'
  });
  await s.repos.lineups.put([
    lineup('C', 2, ['fx-kelce']),
    lineup('C', 3, ['fx-kelce']),
    lineup('A', 3, ['fx-swift', 'fx-bijan']),
    lineup('A', 4, ['fx-swift', 'fx-chase'])
  ]);
  const line = (playerId: string, week: number, rec_yd: number) => ({
    playerId,
    season: 2026,
    week,
    stats: { rec_yd },
    updatedAt: NOW.toISOString()
  });
  await s.reference.stats.putLines([
    line('fx-kelce', 2, 100),
    line('fx-kelce', 3, 50),
    line('fx-swift', 2, 300),
    line('fx-swift', 3, 50),
    line('fx-chase', 4, 10),
    line('fx-bijan', 4, 90)
  ]);
  await s.repos.schedule.putStandings({
    leagueId: 'lg',
    week: 4,
    rows: computeStandings(settings, [], { teamIds: ['A', 'B', 'C'], seed: 's' }),
    computedAt: LATER.toISOString()
  });
}

describe('trade value won or lost', () => {
  it('values each processed trade from its players, projected from the trade week', async () => {
    const s = await setup();
    await processTrade(s);
    const teams = await s.repos.teams.list('lg');
    const [trade, ...rest] = await valuedTrades(
      s.deps,
      league,
      teams,
      LATER,
      await leagueTransactions(s.deps, 'lg')
    );
    expect(rest).toEqual([]);
    expect(trade).toMatchObject({ tradeId: 't1', week: 2 });
    const [a, b] = trade!.sides;
    expect(a).toMatchObject({ teamId: 'A', partnerTeamId: 'B', receives: ['fx-bijan'], drops: [] });
    expect(b).toMatchObject({ teamId: 'B', sends: ['fx-bijan'], drops: ['fx-chase'] });
    expect(a.valueDelta).toBeLessThan(0);
    expect(b.valueDelta).toBeGreaterThan(0);
    expect(b.received).toBe(a.given);
    expect(await valuedTrades(s.deps, league, teams, LATER, [])).toEqual([]);
  });
});

describe('waiver hit rate', () => {
  it('compares each claimed player with the dropped one while he was rostered', async () => {
    const s = await setup();
    await seedClaims(s);
    const outcomes = await waiverOutcomes(s.deps, league, 4, await leagueTransactions(s.deps, 'lg'));
    expect(outcomes.map((o) => [o.teamId, o.weeks, o.hit])).toEqual([
      ['C', [2, 3], false],
      ['A', [3, 4], true],
      ['A', [4], false]
    ]);
    expect(outcomes[0]).toMatchObject({ addedPoints: 15, droppedPoints: 35 });
    expect(await waiverOutcomes(s.deps, league, null, [claim('x', 'A', 2, 'fx-cmc', null)])).toEqual([]);
  });
});

describe('the model leaderboard', () => {
  it('rolls trades and waivers up by model', async () => {
    const s = await setup();
    await processTrade(s);
    await seedClaims(s);
    const board = await modelLeaderboard(s.deps, league, await s.repos.teams.list('lg'), LATER);
    expect(board.throughWeek).toBe(4);
    const b = board.teams.find((t) => t.teamId === 'B');
    expect(b).toMatchObject({ seatType: 'agent', modelKey: 'claude-opus-5', trades: 1, tradesWon: 1 });
    const human = board.models.find((m) => m.modelKey === 'human');
    expect(human).toMatchObject({ teams: 2, trades: 1, tradesLost: 1, waiverClaims: 3, waiverHits: 1 });
    expect(human?.waiverHitRate).toBe(0.333);
    expect(human?.tradeValue).toBeCloseTo(-(b?.tradeValue ?? 0), 0);
  });

  it('keeps going without the transaction log', async () => {
    const s = await setup();
    vi.spyOn(s.repos.waivers, 'listTransactionsSince').mockRejectedValueOnce(new Error('down'));
    const board = await modelLeaderboard(s.deps, league, await s.repos.teams.list('lg'), LATER);
    expect(board.models.every((m) => m.trades === 0 && m.waiverHitRate === null)).toBe(true);
    expect(s.log.warn).toHaveBeenCalledWith('could not read the transaction log', expect.anything());
  });
});

describe('the weekly model power rankings', () => {
  it('posts one line per model when a model plays a team', async () => {
    const s = await setup();
    await processTrade(s);
    await seedClaims(s);
    expect(await publishModelPowerRankings(s.deps, league, 4, LATER)).toBe(true);
    const posted = s.events.events.find((e) => e.detailType === 'Model Power Rankings');
    expect(posted?.detail).toMatchObject({
      leagueId: 'lg',
      week: 4,
      rankings: [expect.objectContaining({ rank: 1 }), expect.objectContaining({ rank: 2 })],
      postedAt: LATER.toISOString()
    });
    const lines = (posted?.detail as { lines: string[] }).lines;
    expect(lines).toHaveLength(2);
    expect(lines.join(' ')).toMatch(/trades [+-]\d/);
    expect(lines.join(' ')).toContain('waivers 1/3');
  });

  it('stays quiet without a model seat, and never fails the rollover', async () => {
    const s = await setup();
    const teams = await s.repos.teams.list('lg');
    const b = teams.find((t) => t.id === 'B')!;
    await s.repos.teams.update({ ...b, seatType: 'human' });
    expect(await publishModelPowerRankings(s.deps, league, 4, LATER)).toBe(false);
    vi.spyOn(s.repos.teams, 'list').mockRejectedValueOnce(new Error('down'));
    expect(await publishModelPowerRankings(s.deps, league, 4, LATER)).toBe(false);
    expect(s.log.warn).toHaveBeenCalledWith('model power rankings not posted', expect.anything());
    expect(s.events.events.filter((e) => e.detailType === 'Model Power Rankings')).toEqual([]);
  });

  it('formats a line with ties and without moves', () => {
    const base = {
      modelKey: 'nova-pro',
      modelName: 'Nova Pro',
      provider: 'amazon',
      teams: 1,
      bestRank: 1,
      pointsForPerTeam: 100,
      costPerWinUsd: null,
      wins: 3,
      losses: 1,
      ties: 1,
      winRate: 0.7,
      pointsFor: 100,
      costUsd: 0,
      trades: 0,
      tradesWon: 0,
      tradesLost: 0,
      tradeValue: 0,
      waiverClaims: 0,
      waiverHits: 0,
      waiverHitRate: null,
      waiverNetPoints: 0
    };
    expect(powerRankingLine(2, base)).toBe('2. Nova Pro 3-1-1');
    expect(powerRankingLine(1, { ...base, ties: 0, trades: 2, tradeValue: 12.345 })).toBe(
      '1. Nova Pro 3-1 (trades +12.35)'
    );
  });
});
