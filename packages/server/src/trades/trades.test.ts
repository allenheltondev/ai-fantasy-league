import { acceptTrade, proposeTrade, ruleError, yahooDefaultSettings, type Trade } from '@fantasy/core';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../errors.js';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { newTeam } from '../league/seats.js';
import { silentLogger } from '../log.js';
import { fixturePlayers } from '../players/fixtures.js';
import { staleTeam } from '../repos/errors.js';
import { createInMemoryRepos } from '../repos/memory.js';
import { createInMemoryReferenceStore } from '../repos/memory-reference.js';
import type { TradeRecord } from '../repos/trades.js';
import type { League } from '../repos/types.js';
import { handleTradeTimer } from './handlers.js';
import { expireOffer, processAccepted, saveTrade, scheduleTradeDeadline, tradeError } from './lifecycle.js';
import {
  loadProjections,
  loadTradeWorld,
  locksReleaseAt,
  nextLockAt,
  tradeDeadlineAt,
  tradeWeek,
  type TradeDeps
} from './world.js';

/** Trade lifecycle edges the REST flows do not reach: races, drops, lineups, retries, and lookups. */

const NOW = new Date('2026-09-10T12:00:00.000Z');
const settings = yahooDefaultSettings(4);
settings.roster.slots = { QB: 1, RB: 1, BN: 1 };
settings.trades.review = 'none';

function league(overrides: Partial<League> = {}): League {
  return {
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
    version: 1,
    ...overrides
  };
}

async function world() {
  const repos = createInMemoryRepos({ players: fixturePlayers });
  const reference = createInMemoryReferenceStore(repos.players);
  const events = new InMemoryEventPublisher();
  const log = { ...silentLogger, warn: vi.fn() };
  const deps: TradeDeps = { repos, reference, events, log };
  const l = league();
  await repos.leagues.create(l);
  const rosters: Record<string, string[]> = {
    A: ['fx-jallen', 'fx-cmc'],
    B: ['fx-mahomes', 'fx-bijan', 'fx-chase'],
    C: []
  };
  await repos.teams.create(
    Object.entries(rosters).map(([id, roster], i) => ({
      ...newTeam({ leagueId: 'lg', id, draftSlot: i + 1, settings, now: NOW }),
      roster
    }))
  );
  return { repos, reference, events, log, deps, league: l };
}

/** A accepts... B's acceptance of A's cmc + jallen for bijan, dropping chase. */
async function accepted(s: Awaited<ReturnType<typeof world>>): Promise<TradeRecord> {
  const ctx = (await loadTradeWorld(s.deps, s.league, NOW)).context;
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
  const record: TradeRecord = {
    leagueId: 'lg',
    trade: done.trade,
    message: null,
    createdBy: 'user#u',
    processingAt: null,
    updatedAt: NOW.toISOString(),
    version: 1
  };
  await s.repos.trades.create(record);
  return record;
}

describe('trade repository (in memory)', () => {
  it('creates once, lists oldest first, and version-checks updates', async () => {
    const s = await world();
    const record = await accepted(s);
    await expect(s.repos.trades.create(record)).rejects.toMatchObject({ code: 'CONFLICT' });
    const later = {
      ...record,
      trade: { ...record.trade, tradeId: 't0', proposedAt: '2026-09-11T00:00:00Z' }
    };
    await s.repos.trades.create(later);
    expect((await s.repos.trades.list('lg')).map((r) => r.trade.tradeId)).toEqual(['t1', 't0']);
    await s.repos.trades.update(record);
    await expect(s.repos.trades.update(record)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await s.repos.trades.get('lg', 'nope')).toBeNull();
    expect(await saveTrade(s.repos, record, NOW)).toBeNull();
    vi.spyOn(s.repos.trades, 'update').mockRejectedValueOnce(new Error('down'));
    await expect(saveTrade(s.repos, record, NOW)).rejects.toThrow('down');
    await s.repos.leagues.delete('lg');
    expect(await s.repos.trades.list('lg')).toEqual([]);
  });
});

describe('processing', () => {
  it('moves players and locks, drops to waivers, records transactions, and reconciles lineups', async () => {
    const s = await world();
    const record = await accepted(s);
    await s.repos.waivers.acquirePlayer('lg', 'fx-bijan', 'C');
    await s.repos.lineups.put([
      {
        leagueId: 'lg',
        teamId: 'B',
        week: 2,
        entries: [
          { playerId: 'fx-mahomes', slot: 'QB' },
          { playerId: 'fx-bijan', slot: 'RB' },
          { playerId: 'fx-chase', slot: 'BN' }
        ],
        updatedAt: NOW.toISOString(),
        updatedBy: 'user#b'
      }
    ]);
    // One roster write loses a race and is retried against the latest team.
    const update = s.repos.teams.update.bind(s.repos.teams);
    vi.spyOn(s.repos.teams, 'update').mockRejectedValueOnce(staleTeam('A')).mockImplementation(update);

    const result = await processAccepted(s.deps, s.league, record, NOW);
    expect(result.outcome).toBe('processed');
    expect((await s.repos.teams.get('lg', 'A'))?.roster).toEqual(['fx-bijan']);
    expect((await s.repos.teams.get('lg', 'B'))?.roster).toEqual(['fx-mahomes', 'fx-cmc', 'fx-jallen']);
    expect(s.log.warn).toHaveBeenCalledWith('trade player lock held by a third team', expect.anything());
    expect((await s.repos.waivers.listWire('lg')).map((w) => w.playerId)).toEqual(['fx-chase']);
    const log = await s.repos.waivers.listTransactions('lg', { limit: 10 });
    expect(log.items.map((t) => `${t.type}:${t.teamId}:${t.addPlayerId ?? t.dropPlayerId}`).sort()).toEqual([
      'drop:B:fx-chase',
      'trade:A:fx-bijan',
      'trade:B:fx-cmc',
      'trade:B:fx-jallen'
    ]);
    expect((await s.repos.lineups.get('lg', 'B', 2))?.entries).toEqual([
      { playerId: 'fx-mahomes', slot: 'QB' },
      { playerId: 'fx-cmc', slot: 'BN' },
      { playerId: 'fx-jallen', slot: 'BN' }
    ]);

    // A crashed run (stamped, not finished) finishes without validating or moving anyone twice.
    const stamped = { ...result.record, trade: record.trade, processingAt: NOW.toISOString() };
    const again = await processAccepted(s.deps, s.league, stamped, NOW);
    expect(again.outcome).toBe('processed');
    expect((await s.repos.teams.get('lg', 'A'))?.roster).toEqual(['fx-bijan']);
    expect((await s.repos.waivers.listTransactions('lg', { limit: 10 })).items).toHaveLength(4);
  });

  it('reports a lost race at each commit point', async () => {
    const s = await world();
    const record = await accepted(s);
    await s.repos.trades.update(record);
    expect((await processAccepted(s.deps, s.league, record, NOW)).outcome).toBe('raced');
    // Invalid now (cmc left A), and the void loses the race too.
    const a = await s.repos.teams.get('lg', 'A');
    if (a === null) throw new Error('A');
    await s.repos.teams.update({ ...a, roster: ['fx-jallen'] });
    expect((await processAccepted(s.deps, s.league, record, NOW)).outcome).toBe('raced');
    const open: Trade = { ...record.trade, status: 'proposed', expiresAt: NOW.toISOString() };
    expect(await expireOffer(s.deps, s.league, { ...record, trade: open }, NOW)).toBe('raced');
  });

  it('rethrows a roster write that keeps failing for another reason', async () => {
    const s = await world();
    const record = await accepted(s);
    vi.spyOn(s.repos.teams, 'update').mockRejectedValue(new Error('table down'));
    await expect(processAccepted(s.deps, s.league, record, NOW)).rejects.toThrow('table down');
  });
});

describe('timers and lookups', () => {
  it('ignores a review timer for a trade that is not accepted', async () => {
    const s = await world();
    const record = await accepted(s);
    await s.repos.trades.update({ ...record, trade: { ...record.trade, status: 'rejected' } });
    const services = {
      repos: s.repos,
      events: s.events,
      log: silentLogger,
      data: { reference: s.reference },
      clock: { now: () => NOW }
    };
    expect(
      await handleTradeTimer(services as never, 'Trade Review Ended', { leagueId: 'lg', tradeId: 't1' })
    ).toBe('stale');
    expect(await handleTradeTimer(services as never, 'Trade Deadline Passed', {})).toBe('ignored');
  });

  it('computes the week, next lock, deadline, and lock release from the schedule', async () => {
    const s = await world();
    expect(tradeWeek(league({ week: null }))).toBe(1);
    expect(await nextLockAt(s.reference, s.league, NOW)).toBeNull();
    expect(await tradeDeadlineAt(s.reference, s.league)).toBeNull();
    expect(await locksReleaseAt(s.reference, s.league, NOW)).toBe('2026-09-10T12:30:00.000Z');
    const game = (week: number, kickoff: string) => ({
      gameId: `g${week}`,
      season: 2026,
      seasonType: 'regular' as const,
      week,
      kickoff,
      homeTeam: 'KC',
      awayTeam: 'BAL',
      status: 'scheduled' as const
    });
    await s.reference.schedule.putSeason(
      2026,
      [game(2, '2026-09-10T00:00:00Z'), game(3, '2026-09-17T00:20:00.000Z')],
      {},
      NOW
    );
    expect(await nextLockAt(s.reference, s.league, NOW)).toBe('2026-09-17T00:20:00.000Z');
    await scheduleTradeDeadline(s.deps, s.league);
    expect(s.events.events).toEqual([]);
    const withDeadline = league({
      deadlines: { ...s.league.deadlines, tradeDeadlineAt: '2026-11-20T00:20:00.000Z' }
    });
    await scheduleTradeDeadline(s.deps, withDeadline);
    expect(s.events.events[0]?.detail).toMatchObject({
      name: 'trade-deadline-lg',
      event: { detailType: 'Trade Deadline Passed', detail: { leagueId: 'lg', deadlineWeek: 11 } }
    });
  });

  it('values with last week’s projections until the new week’s are out, and zero with none at all', async () => {
    const s = await world();
    const ids = ['fx-cmc', 'fx-jallen'];
    // Week 1 (no earlier week) and week 2 without any snapshot: nothing projects.
    expect((await loadProjections(s.reference, league({ week: 1 }), ids, NOW)).table).toEqual({});
    expect((await loadProjections(s.reference, s.league, ids, NOW)).table).toEqual({});
    await s.reference.projections.putSnapshot(
      { season: 2026, week: 1, capturedAt: '2026-09-05T12:00:00.000Z', hash: 'w1', count: 1 },
      [{ playerId: 'fx-cmc', season: 2026, week: 1, stats: { rush_yd: 100 } }]
    );
    // Just after the rollover to week 2: week 1's numbers stand in for every valuation week.
    const early = await loadProjections(s.reference, s.league, ids, NOW);
    expect(early.fromWeek).toBe(2);
    expect(Object.keys(early.table['fx-cmc'] ?? {}).map(Number)).toEqual(
      Array.from({ length: early.toWeek - 1 }, (_, i) => i + 2)
    );
    expect(early.table['fx-cmc']?.[2]).toBe(10);
    await s.reference.projections.putSnapshot(
      { season: 2026, week: 2, capturedAt: '2026-09-09T12:00:00.000Z', hash: 'w2', count: 1 },
      [{ playerId: 'fx-cmc', season: 2026, week: 2, stats: { rush_yd: 200 } }]
    );
    expect((await loadProjections(s.reference, s.league, ids, NOW)).table['fx-cmc']?.[3]).toBe(20);
  });

  it('maps rule issues to API errors with every fix', () => {
    const vote = tradeError([ruleError('ALREADY_VOTED', 'x', 'Voted.', 'No action needed.')]);
    expect(vote).toBeInstanceOf(ApiError);
    expect(vote).toMatchObject({ code: 'VOTE_NOT_ALLOWED', fix: 'No action needed.' });
    expect(tradeError([ruleError('SAME_TEAM', 'x', 'Same.', 'Pick another.')]).code).toBe('TRADE_INVALID');
    expect(tradeError([]).code).toBe('TRADE_INVALID');
  });
});
