import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isOnBye,
  isPlayerLocked,
  validateLineup,
  type LineupEntry,
  type RosterPlayer
} from '../rules/lineup.js';
import {
  ROSTER_SLOTS,
  WILL_NOT_PLAY_STATUSES,
  isEligibleForSlot,
  isStarterSlot,
  type PlayerStatus,
  type Position,
  type RosterSlot
} from '../rules/positions.js';
import { activeRosterSize, slotCount, yahooDefaultSettings, type LeagueSettings } from '../rules/settings.js';
import { lineupDiff, optimizeLineup, rankValues, solveAssignment, startersProjection } from './optimizer.js';

const settings = yahooDefaultSettings();
const withSlots = (slots: LeagueSettings['roster']['slots']): LeagueSettings => ({
  ...settings,
  roster: { ...settings.roster, slots }
});

const p = (
  playerId: string,
  pos: Position | Position[],
  extra: Partial<RosterPlayer> = {}
): RosterPlayer => ({
  playerId,
  positions: Array.isArray(pos) ? pos : [pos],
  status: 'active',
  nflTeam: 'KC',
  ...extra
});

const starters = (lineup: readonly LineupEntry[]): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const e of lineup) if (isStarterSlot(e.slot)) (out[e.slot] ??= []).push(e.playerId);
  for (const ids of Object.values(out)) ids.sort();
  return out;
};

describe('solveAssignment', () => {
  it('matches brute force on small matrices', () => {
    const permutations = (n: number, m: number): number[][] => {
      if (n === 0) return [[]];
      const out: number[][] = [];
      for (const rest of permutations(n - 1, m))
        for (let j = 0; j < m; j++) if (!rest.includes(j)) out.push([...rest, j]);
      return out;
    };
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }).chain((n) =>
          fc.integer({ min: n, max: 5 }).chain((m) =>
            fc.array(fc.array(fc.integer({ min: -50, max: 50 }), { minLength: m, maxLength: m }), {
              minLength: n,
              maxLength: n
            })
          )
        ),
        (cost) => {
          const total = (a: number[]) => a.reduce((s, j, i) => s + (cost[i]?.[j] ?? 0), 0);
          const best = Math.min(...permutations(cost.length, cost[0]?.length ?? 0).map(total));
          const got = solveAssignment(cost);
          expect(new Set(got).size).toBe(got.length);
          expect(total(got)).toBe(best);
        }
      )
    );
    expect(solveAssignment([])).toEqual([]);
  });
});

describe('optimizeLineup', () => {
  it('picks the best flex from WR, RB and TE', () => {
    const roster = [
      p('qb', 'QB'),
      p('w1', 'WR'),
      p('w2', 'WR'),
      p('w3', 'WR'),
      p('w4', 'WR'),
      p('r1', 'RB'),
      p('r2', 'RB'),
      p('r3', 'RB'),
      p('t1', 'TE'),
      p('t2', 'TE'),
      p('k', 'K'),
      p('d', 'DEF')
    ];
    const proj = {
      qb: 20,
      w1: 20,
      w2: 18,
      w3: 15,
      w4: 12,
      r1: 16,
      r2: 14,
      r3: 13,
      t1: 10,
      t2: 9,
      k: 8,
      d: 7
    };
    const r = optimizeLineup(settings, roster, proj);
    expect(starters(r.lineup)).toEqual({
      QB: ['qb'],
      WR: ['w1', 'w2', 'w3'],
      RB: ['r1', 'r2'],
      TE: ['t1'],
      'W/R/T': ['r3'],
      K: ['k'],
      DEF: ['d']
    });
    expect(r.projectedPoints).toBe(141);
    expect(r.validation.valid).toBe(true);
    expect(r.validation.warnings).toEqual([]);
  });

  it('solves overlapping flex slots exactly where a greedy fill would not', () => {
    // Greedy (best player into the first flex) puts the WR in W/R and leaves the TE for W/T: 12 points.
    const s = withSlots({ 'W/R': 1, 'W/T': 1, BN: 3 });
    const r = optimizeLineup(s, [p('wr', 'WR'), p('rb', 'RB'), p('te', 'TE')], { wr: 10, rb: 9, te: 2 });
    expect(starters(r.lineup)).toEqual({ 'W/R': ['rb'], 'W/T': ['wr'] });
    expect(r.projectedPoints).toBe(19);
  });

  it('uses multi-position players where they help most', () => {
    const s = withSlots({ RB: 1, WR: 1, BN: 2 });
    const r = optimizeLineup(s, [p('x', ['RB', 'WR']), p('rb', 'RB')], { x: 10, rb: 6 });
    expect(starters(r.lineup)).toEqual({ RB: ['rb'], WR: ['x'] });
  });

  it('benches players on bye or ruled out, and leaves a slot empty rather than start a negative projection', () => {
    const s = withSlots({ QB: 1, WR: 1, K: 1, BN: 3 });
    const games = { KC: { kickoff: '2026-10-04T17:00:00Z' } };
    const roster = [
      p('qb', 'QB', { nflTeam: 'BUF' }),
      p('qb2', 'QB'),
      p('wr', 'WR', { status: 'out' }),
      p('k', 'K')
    ];
    const r = optimizeLineup(s, roster, { qb: 30, qb2: 5, wr: 20, k: -1 }, { games });
    expect(starters(r.lineup)).toEqual({ QB: ['qb2'] });
    expect(r.projectedPoints).toBe(5);
    expect(r.validation.valid).toBe(true);
    expect(r.validation.warnings.map((w) => w.code).sort()).toEqual([
      'EMPTY_STARTER_SLOT',
      'EMPTY_STARTER_SLOT'
    ]);
  });

  it('keeps locked players and IR players where they are', () => {
    const s = withSlots({ QB: 1, WR: 2, BN: 2, IR: 1 });
    const games = { KC: { kickoff: '2026-10-04T17:00:00Z' }, BUF: { kickoff: '2026-10-05T00:20:00Z' } };
    const roster = [
      p('qb', 'QB', { nflTeam: 'BUF' }),
      p('lockedStarter', 'WR'),
      p('lockedBench', 'WR'),
      p('w3', 'WR', { nflTeam: 'BUF' }),
      p('hurt', 'WR', { status: 'ir' })
    ];
    const previousLineup: LineupEntry[] = [
      { playerId: 'lockedStarter', slot: 'WR' },
      { playerId: 'lockedBench', slot: 'BN' },
      { playerId: 'hurt', slot: 'IR' }
    ];
    const now = '2026-10-04T18:00:00Z';
    const proj = { qb: 20, lockedStarter: 1, lockedBench: 30, w3: 10, hurt: 0 };
    const r = optimizeLineup(s, roster, proj, { games, now, previousLineup });
    expect(r.lineup).toEqual(
      expect.arrayContaining([
        { playerId: 'lockedStarter', slot: 'WR' },
        { playerId: 'lockedBench', slot: 'BN' },
        { playerId: 'w3', slot: 'WR' },
        { playerId: 'qb', slot: 'QB' },
        { playerId: 'hurt', slot: 'IR' }
      ])
    );
    expect(r.projectedPoints).toBe(31);
    expect(r.validation.valid).toBe(true);
  });

  it('keeps players where they are when a move gains nothing', () => {
    const s = withSlots({ QB: 1, WR: 2, 'W/R/T': 1, BN: 3 });
    const roster = [p('qb', 'QB'), p('a', 'WR'), p('b', 'WR'), p('c', 'WR'), p('d', 'WR'), p('e', 'RB')];
    const previousLineup: LineupEntry[] = [
      { playerId: 'qb', slot: 'QB' },
      { playerId: 'c', slot: 'WR' },
      { playerId: 'e', slot: 'W/R/T' },
      { playerId: 'd', slot: 'WR' }
    ];
    const r = optimizeLineup(
      s,
      roster,
      { a: 5, b: 5, c: 5, d: 5, e: 5 },
      { previousLineup },
      { keepSlots: true }
    );
    expect(lineupDiff(previousLineup, r.lineup)).toEqual([]);
    // A real gain still moves players.
    const better = optimizeLineup(
      s,
      roster,
      { a: 9, b: 5, c: 5, d: 5, e: 5 },
      { previousLineup },
      { keepSlots: true }
    );
    expect(lineupDiff(previousLineup, better.lineup)).toHaveLength(2);
  });

  it('handles an empty roster', () => {
    const r = optimizeLineup(settings, [], {});
    expect(r.lineup).toEqual([]);
    expect(r.projectedPoints).toBe(0);
  });
});

describe('startersProjection and lineupDiff', () => {
  const roster = [
    p('qb', 'QB'),
    p('wr', 'WR', { nflTeam: 'SEA' }),
    p('out', 'WR', { status: 'out' }),
    p('bench', 'WR')
  ];
  const lineup: LineupEntry[] = [
    { playerId: 'qb', slot: 'QB' },
    { playerId: 'wr', slot: 'WR' },
    { playerId: 'out', slot: 'WR' },
    { playerId: 'bench', slot: 'BN' },
    { playerId: 'gone', slot: 'WR' }
  ];
  const proj = { qb: 20.333, wr: 10, out: 12, bench: 9, gone: 5 };

  it('counts only starters who will play, to the cent', () => {
    expect(startersProjection(roster, lineup, proj)).toBe(30.33);
    expect(startersProjection(roster, lineup, proj, { KC: { kickoff: '2026-10-04T17:00:00Z' } })).toBe(20.33);
    expect(startersProjection(roster, [], proj)).toBe(0);
  });

  it('ranks players by consensus rank when there are no projections', () => {
    const values = rankValues([
      { playerId: 'star', rank: 1 },
      { playerId: 'depth', rank: 250 },
      { playerId: 'deep', rank: 5000 },
      { playerId: 'none', rank: null }
    ]);
    expect(values).toEqual({ star: 9.99, depth: 7.5, deep: 0.01, none: 0.01 });
    const s = withSlots({ QB: 1, WR: 1, BN: 3 });
    const roster = [p('qb', 'QB'), p('wr1', 'WR'), p('wr2', 'WR')];
    const best = optimizeLineup(
      s,
      roster,
      rankValues([
        { playerId: 'qb', rank: null },
        { playerId: 'wr1', rank: 80 },
        { playerId: 'wr2', rank: 12 }
      ])
    );
    expect(starters(best.lineup)).toEqual({ QB: ['qb'], WR: ['wr2'] });
  });

  it('lists the moves between two lineups, counting missing players as bench', () => {
    expect(
      lineupDiff(lineup, [
        { playerId: 'qb', slot: 'QB' },
        { playerId: 'bench', slot: 'WR' },
        { playerId: 'out', slot: 'BN' },
        { playerId: 'new', slot: 'BN' },
        { playerId: 'new2', slot: 'WR' }
      ])
    ).toEqual([
      { playerId: 'bench', slot: 'WR' },
      { playerId: 'out', slot: 'BN' },
      { playerId: 'new2', slot: 'WR' }
    ]);
  });
});

describe('optimizeLineup with locks and injuries (properties)', () => {
  const positions: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  const statuses: PlayerStatus[] = ['active', 'active', 'questionable', 'doubtful', 'out', 'ir', 'suspended'];
  // KC has kicked off, BUF and SF have not, SEA is on bye.
  const games = {
    KC: { kickoff: '2026-10-04T17:00:00Z' },
    BUF: { kickoff: '2026-10-04T20:25:00Z' },
    SF: { kickoff: '2026-10-05T00:20:00Z' }
  };
  const now = '2026-10-04T18:00:00Z';
  const slotsArb = fc.constantFrom<LeagueSettings['roster']['slots']>(
    settings.roster.slots,
    { QB: 1, RB: 2, WR: 2, TE: 1, 'W/R/T': 2, 'Q/W/R/T': 1, K: 1, DEF: 1, BN: 6 },
    { QB: 1, 'W/R': 1, 'W/T': 1, 'W/R/T': 1, BN: 6 }
  );
  const rosterArb = fc.array(
    fc.record({
      positions: fc.subarray(positions, { minLength: 1, maxLength: 2 }),
      status: fc.constantFrom(...statuses),
      team: fc.constantFrom('KC', 'BUF', 'SF', 'SEA'),
      points: fc.integer({ min: -300, max: 3000 }).map((c) => c / 100)
    }),
    { minLength: 0, maxLength: 16 }
  );

  /** A legal lineup: each starting slot takes a random unused eligible player or stays empty. */
  function randomLineup(s: LeagueSettings, roster: RosterPlayer[], picks: number[]): LineupEntry[] {
    const used = new Set<string>();
    const lineup: LineupEntry[] = [];
    let k = 0;
    for (const slot of ROSTER_SLOTS.filter(isStarterSlot) as RosterSlot[]) {
      for (let n = 0; n < slotCount(s, slot); n++) {
        const options = roster.filter(
          (pl) => !used.has(pl.playerId) && isEligibleForSlot(slot, pl.positions)
        );
        const chosen = options[(picks[k++ % picks.length] ?? 0) % (options.length + 1)];
        if (chosen) {
          used.add(chosen.playerId);
          lineup.push({ playerId: chosen.playerId, slot });
        }
      }
    }
    return lineup;
  }

  it('never starts an ineligible, locked, or ruled-out player, and never projects below the current lineup', () => {
    fc.assert(
      fc.property(
        slotsArb,
        rosterArb,
        fc.array(fc.nat(), { minLength: 40, maxLength: 40 }),
        fc.boolean(),
        (slots, rows, picks, keepSlots) => {
          const s = withSlots(slots);
          const roster = rows
            .slice(0, activeRosterSize(s))
            .map((r, i) => p(`p${i}`, r.positions, { status: r.status, nflTeam: r.team }));
          const proj = Object.fromEntries(rows.map((r, i) => [`p${i}`, r.points]));
          const current = randomLineup(s, roster, picks);
          expect(validateLineup(s, roster, current).valid).toBe(true);

          const best = optimizeLineup(
            s,
            roster,
            proj,
            { games, now, previousLineup: current },
            { keepSlots }
          );
          expect(best.validation.valid).toBe(true);
          const was = new Map(current.map((e) => [e.playerId, e.slot]));
          const byId = new Map(roster.map((pl) => [pl.playerId, pl]));
          for (const e of best.lineup) {
            const player = byId.get(e.playerId) as RosterPlayer;
            const before = was.get(e.playerId) ?? 'BN';
            const locked = isPlayerLocked(player, games, now);
            // A locked player keeps his slot, whatever it is.
            if (locked) expect(e.slot).toBe(before);
            if (!isStarterSlot(e.slot)) continue;
            expect(isEligibleForSlot(e.slot, player.positions)).toBe(true);
            // Out, IR, and bye players only start when they were already locked into the slot.
            if (WILL_NOT_PLAY_STATUSES.includes(player.status) || isOnBye(player, games)) {
              expect(locked && before === e.slot).toBe(true);
            }
          }
          expect(startersProjection(roster, best.lineup, proj, games)).toBeGreaterThanOrEqual(
            startersProjection(roster, current, proj, games)
          );
          // The diff, applied to the current lineup, gives the optimized one.
          const moved = new Map(was);
          for (const m of lineupDiff(current, best.lineup)) moved.set(m.playerId, m.slot);
          for (const e of best.lineup) expect(moved.get(e.playerId) ?? 'BN').toBe(e.slot);
        }
      ),
      { numRuns: 300 }
    );
  });
});

describe('optimizeLineup properties', () => {
  const positions: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  const slotsArb = fc.constantFrom<LeagueSettings['roster']['slots']>(
    settings.roster.slots,
    { QB: 1, RB: 2, WR: 2, TE: 1, 'W/R/T': 2, 'Q/W/R/T': 1, K: 1, DEF: 1, BN: 6 },
    { 'W/R': 1, 'W/T': 1, 'W/R/T': 1, BN: 6 }
  );
  const rosterArb = fc.array(
    fc.record({
      positions: fc.subarray(positions, { minLength: 1, maxLength: 2 }),
      points: fc.integer({ min: 0, max: 3000 }).map((c) => c / 100)
    }),
    { minLength: 0, maxLength: 16 }
  );

  it('is legal and at least as good as any random legal lineup', () => {
    fc.assert(
      fc.property(
        slotsArb,
        rosterArb,
        fc.array(fc.nat(), { minLength: 40, maxLength: 40 }),
        (slots, rows, picks) => {
          const s = withSlots(slots);
          const roster = rows.slice(0, activeRosterSize(s)).map((r, i) => p(`p${i}`, r.positions));
          const proj = Object.fromEntries(rows.map((r, i) => [`p${i}`, r.points]));
          const best = optimizeLineup(s, roster, proj);
          expect(best.validation.valid).toBe(true);

          // Build a random legal lineup: each starting slot takes a random unused eligible player or stays empty.
          const used = new Set<string>();
          const random: LineupEntry[] = [];
          let k = 0;
          for (const slot of ROSTER_SLOTS.filter(isStarterSlot) as RosterSlot[]) {
            for (let n = 0; n < slotCount(s, slot); n++) {
              const options = roster.filter(
                (pl) => !used.has(pl.playerId) && isEligibleForSlot(slot, pl.positions)
              );
              const pick = (picks[k++ % picks.length] ?? 0) % (options.length + 1);
              const chosen = options[pick];
              if (chosen) {
                used.add(chosen.playerId);
                random.push({ playerId: chosen.playerId, slot });
              }
            }
          }
          expect(validateLineup(s, roster, random).valid).toBe(true);
          const randomPoints = random.reduce((sum, e) => sum + (proj[e.playerId] ?? 0), 0);
          expect(best.projectedPoints).toBeGreaterThanOrEqual(Math.round(randomPoints * 100) / 100 - 1e-9);
        }
      )
    );
  });
});
