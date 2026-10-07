import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OFFENSE_POSITIONS, type Position } from '../rules/positions.js';
import { yahooDefaultSettings } from '../rules/settings.js';
import { type DraftablePlayer } from './autopick.js';
import {
  BYE_CLASH_PENALTY,
  byeClash,
  byeRemains,
  draftRiskMultiplier,
  draftTendency,
  isSidelined,
  MAX_TENDENCY_REACH,
  likelyGoneBeforeYourPick,
  likelyTakenBeforeNextTurn,
  positionScarcity,
  picksBeforeNextTurn,
  recentPositionRun,
  seasonWindow,
  SHORT_SEASON_WEEKS,
  SIDELINED_PENALTY,
  type DraftRiskPlayer
} from './context.js';
import { createDraft, currentPick, makePick, picksUntilTurn, totalPicks, type DraftState } from './draft.js';

const settings = yahooDefaultSettings(4);

function draft(teams: number, rounds: number): DraftState {
  const r = createDraft({
    teamIds: Array.from({ length: teams }, (_, i) => `t${i + 1}`),
    rounds,
    pickSeconds: 60
  });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

function take(d: DraftState, playerId: string, positions: Position[]): DraftState {
  const slot = currentPick(d);
  if (slot === null) throw new Error('draft over');
  const r = makePick(d, slot.teamId, playerId, { positions });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.draft;
}

function advance(d: DraftState, n: number): DraftState {
  let s = d;
  for (let i = 0; i < n; i++) s = take(s, `x${i}`, ['WR']);
  return s;
}

describe('picksBeforeNextTurn', () => {
  it('follows the snake: pick p of n in a round waits 2(n - p) picks', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 12 }),
        fc.integer({ min: 1, max: 6 }),
        fc.nat(),
        (n, rounds, k) => {
          const d = draft(n, rounds);
          const made = k % totalPicks(d);
          const s = advance(d, made);
          const slot = currentPick(s)!;
          const between = picksBeforeNextTurn(s, slot.teamId);
          if (slot.round === rounds) {
            expect(between).toBeNull();
            return;
          }
          expect(between).toBe(2 * (n - slot.pick));
          // Equivalently: after this pick, picksUntilTurn counts the same wait.
          expect(picksUntilTurn(take(s, 'mine', ['QB']), slot.teamId)).toBe(between);
        }
      )
    );
  });

  it('is null once the draft is over', () => {
    const d = advance(draft(2, 1), 2);
    expect(picksBeforeNextTurn(d, 't1')).toBeNull();
  });
});

describe('recentPositionRun', () => {
  const positionArb = fc.constantFrom(...OFFENSE_POSITIONS);

  it('counts the last n picks by primary position, most first', () => {
    fc.assert(
      fc.property(
        fc.array(positionArb, { maxLength: 30 }),
        fc.integer({ min: 0, max: 12 }),
        (positions, n) => {
          const picks = positions.map((p) => ({ positions: [p] }));
          const run = recentPositionRun(picks, n);
          expect(run.reduce((sum, r) => sum + r.count, 0)).toBe(Math.min(n, positions.length));
          for (let i = 1; i < run.length; i++)
            expect(run[i - 1]!.count).toBeGreaterThanOrEqual(run[i]!.count);
          const last = positions.slice(positions.length - Math.min(n, positions.length));
          for (const r of run) expect(r.count).toBe(last.filter((p) => p === r.position).length);
        }
      )
    );
  });

  it('reads a run on tight ends', () => {
    const picks = (['QB', 'WR', 'TE', 'TE', 'WR', 'TE'] as const).map((p) => ({ positions: [p] }));
    expect(recentPositionRun(picks, 5)).toEqual([
      { position: 'TE', count: 3 },
      { position: 'WR', count: 2 }
    ]);
    expect(recentPositionRun([{ positions: [] }], 3)).toEqual([]);
  });
});

describe('likelyTakenBeforeNextTurn', () => {
  const pool: DraftablePlayer[] = Array.from({ length: 60 }, (_, i) => ({
    playerId: `p${String(i).padStart(2, '0')}`,
    positions: [OFFENSE_POSITIONS[i % OFFENSE_POSITIONS.length]!]
  }));
  const ranks = pool.map((p) => p.playerId);

  it('takes one distinct, available player per pick in between', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), fc.integer({ min: 0, max: 20 }), (n, made) => {
        const d = draft(n, 4);
        const s = advance(d, Math.min(made, totalPicks(d) - 1));
        const team = currentPick(s)!.teamId;
        const taken = likelyTakenBeforeNextTurn(s, team, pool, ranks, settings);
        const between = picksBeforeNextTurn(s, team) ?? 0;
        expect(taken.length).toBe(between);
        expect(new Set(taken).size).toBe(taken.length);
        for (const id of taken) expect(ranks).toContain(id);
      })
    );
  });

  it('goes by consensus rank and the other teams’ empty slots', () => {
    // t1 picks 1 and 8 in a 4-team snake: t2, t3, t4, t4, t3, t2 pick in between.
    const s = draft(4, 3);
    const taken = likelyTakenBeforeNextTurn(s, 't1', pool, ranks, settings);
    expect(taken).toEqual(['p00', 'p01', 'p02', 'p03', 'p04', 'p05']);
    // Nobody left to pick for: the list stops short.
    expect(likelyTakenBeforeNextTurn(s, 't1', pool.slice(0, 2), ranks, settings)).toEqual(['p00', 'p01']);
    expect(likelyTakenBeforeNextTurn(advance(s, 11), 't1', pool, ranks, settings)).toEqual([]);
  });
});

describe('likelyGoneBeforeYourPick', () => {
  const pool: DraftablePlayer[] = Array.from({ length: 60 }, (_, i) => ({
    playerId: `p${String(i).padStart(2, '0')}`,
    positions: [OFFENSE_POSITIONS[i % OFFENSE_POSITIONS.length]!]
  }));
  const ranks = pool.map((p) => p.playerId);

  it('counts the picks until your turn, or after it when you are on the clock', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }),
        fc.integer({ min: 0, max: 30 }),
        fc.nat(),
        (n, made, who) => {
          const d = draft(n, 4);
          const s = advance(d, Math.min(made, totalPicks(d) - 1));
          const team = `t${(who % n) + 1}`;
          const gone = likelyGoneBeforeYourPick(s, team, pool, ranks, settings);
          const onClock = currentPick(s)!.teamId === team;
          const expected = onClock ? (picksBeforeNextTurn(s, team) ?? 0) : (picksUntilTurn(s, team) ?? 0);
          expect(gone.length).toBe(expected);
          expect(new Set(gone).size).toBe(gone.length);
          if (onClock) expect(gone).toEqual(likelyTakenBeforeNextTurn(s, team, pool, ranks, settings));
        }
      )
    );
  });

  it('stops when the pool runs dry, and is empty once you have no pick left', () => {
    // t4 picks 4th in a 4-team snake: t1, t2, t3 pick first.
    const s = draft(4, 2);
    expect(likelyGoneBeforeYourPick(s, 't4', pool, ranks, settings)).toEqual(['p00', 'p01', 'p02']);
    expect(likelyGoneBeforeYourPick(s, 't4', pool.slice(0, 1), ranks, settings)).toEqual(['p00']);
    expect(likelyGoneBeforeYourPick(advance(s, 5), 't4', pool, ranks, settings)).toEqual([]);
    expect(likelyGoneBeforeYourPick(advance(s, 8), 't4', pool, ranks, settings)).toEqual([]);
  });
});

describe('draft tendencies (#151)', () => {
  // Three rounds of a 4-team snake: t2 (picks 2, 7, 10) takes a running back every time, each one
  // `reach` picks ahead of his consensus rank. Round 4 opens t4, t3, t2, then t1.
  const OPENING: [string, Position][] = [
    ['a1', 'QB'],
    ['r1', 'RB'],
    ['a3', 'QB'],
    ['a4', 'QB'],
    ['a5', 'TE'],
    ['a6', 'TE'],
    ['r2', 'RB'],
    ['a8', 'TE'],
    ['a9', 'K'],
    ['r3', 'RB'],
    ['a11', 'K'],
    ['a12', 'K']
  ];
  function opened(reach: number): DraftState {
    let s = draft(4, 16);
    for (const [id, position] of OPENING) s = take(s, id, [position]);
    return {
      ...s,
      picks: s.picks.map((p) => (p.teamId === 't2' ? { ...p, adp: p.overall + reach } : { ...p, adp: null }))
    };
  }
  // Wide receivers lead consensus; the best back is sixth.
  const pool: DraftablePlayer[] = [
    ...['w0', 'w1', 'w2', 'w3', 'w4'].map((playerId) => ({ playerId, positions: ['WR' as const] })),
    { playerId: 'b0', positions: ['RB'] },
    ...['w5', 'w6', 'w7'].map((playerId) => ({ playerId, positions: ['WR' as const] }))
  ];
  const ranks = pool.map((p) => p.playerId);

  it('reads the position a team keeps taking and how far ahead of consensus it reaches', () => {
    const s = opened(8);
    expect(draftTendency(s.picks, 't2')).toEqual({ lean: 'RB', reach: 8 });
    // One of everything: no lean.
    expect(draftTendency(s.picks, 't1')).toBeNull();
    // Too few picks to say, and autopicks say nothing about the person.
    expect(draftTendency(s.picks.slice(0, 7), 't2')).toBeNull();
    expect(
      draftTendency(
        s.picks.map((p) => ({ ...p, auto: true })),
        't2'
      )
    ).toBeNull();
    // A reach is capped, and no ADP at all reads as drafting by consensus.
    expect(draftTendency(opened(500).picks, 't2')).toEqual({ lean: 'RB', reach: MAX_TENDENCY_REACH });
    expect(
      draftTendency(
        opened(8).picks.map((p) => ({ ...p, adp: null })),
        't2'
      )?.reach
    ).toBe(0);
  });

  it('finds no lean in a tie between positions', () => {
    const picks = (['RB', 'WR', 'RB', 'WR'] as const).map((position, i) => ({
      teamId: 't1',
      positions: [position],
      auto: false,
      overall: i + 1,
      adp: null
    }));
    expect(draftTendency(picks, 't1')).toBeNull();
  });

  it('has a person take the best player at their lean, within their reach of consensus', () => {
    const s = opened(8);
    const tendencies = { t2: draftTendency(s.picks, 't2') };
    // By consensus alone t4, t3 and t2 take the top three receivers.
    expect(likelyGoneBeforeYourPick(s, 't1', pool, ranks, settings)).toEqual(['w0', 'w1', 'w2']);
    // t2 has been reaching 8 picks for backs: the sixth-ranked back is within reach.
    expect(likelyGoneBeforeYourPick(s, 't1', pool, ranks, settings, tendencies)).toEqual(['w0', 'w1', 'b0']);
    // A team that only reaches 2 picks still takes the receiver.
    const near = opened(2);
    expect(
      likelyGoneBeforeYourPick(near, 't1', pool, ranks, settings, { t2: draftTendency(near.picks, 't2') })
    ).toEqual(['w0', 'w1', 'w2']);
  });

  it('applies to the picks after yours, too, and never to a team without a tendency', () => {
    // t1 on the clock at pick 16 picks again at 17: nobody in between.
    let s = opened(8);
    for (const id of ['x13', 'x14', 'x15']) s = take(s, id, ['WR']);
    expect(likelyTakenBeforeNextTurn(s, 't1', pool, ranks, settings, { t2: null })).toEqual([]);
    // t4 picks 13 and has no lean: consensus, whatever is passed for it.
    const fresh = opened(8);
    expect(likelyGoneBeforeYourPick(fresh, 't3', pool, ranks, settings, { t4: null })).toEqual(['w0']);
  });
});

describe('positionScarcity', () => {
  it('counts each position among the top available, and how many of those go early', () => {
    const players = (['TE', 'WR', 'TE', 'QB', 'TE'] as const).map((p, i) => ({
      playerId: `p${i}`,
      positions: [p]
    }));
    expect(positionScarcity(players, ['p0', 'p1', 'p4'], ['QB', 'TE', 'K'], 4)).toEqual([
      { position: 'QB', left: 1, likelyGone: 0 },
      { position: 'TE', left: 2, likelyGone: 1 },
      { position: 'K', left: 0, likelyGone: 0 }
    ]);
  });

  it('counts an unranked position (team defenses) across the whole pool, not just the top n', () => {
    const players = (['WR', 'WR', 'DEF', 'DEF', 'DEF'] as const).map((p, i) => ({
      playerId: `p${i}`,
      positions: [p]
    }));
    expect(positionScarcity(players, ['p2'], ['WR', 'DEF'], 2, ['DEF'])).toEqual([
      { position: 'WR', left: 2, likelyGone: 0 },
      { position: 'DEF', left: 3, likelyGone: 1 }
    ]);
  });

  it('never counts more than the top n, nor more gone than left', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...OFFENSE_POSITIONS), { maxLength: 40 }),
        fc.integer({ min: -2, max: 50 }),
        fc.array(fc.nat({ max: 45 })),
        (positions, top, goneIdx) => {
          const players = positions.map((p, i) => ({ playerId: `p${i}`, positions: [p] }));
          const rows = positionScarcity(
            players,
            goneIdx.map((i) => `p${i}`),
            OFFENSE_POSITIONS,
            top
          );
          const total = rows.reduce((sum, r) => sum + r.left, 0);
          expect(total).toBe(Math.min(Math.max(0, top), players.length));
          for (const r of rows) expect(r.likelyGone).toBeLessThanOrEqual(r.left);
        }
      )
    );
  });
});

describe('seasonWindow', () => {
  it('counts the weeks left from the later of the start week and the current week', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 17 }),
        fc.integer({ min: 1, max: 17 }),
        fc.option(fc.integer({ min: 1, max: 18 })),
        (a, b, current) => {
          const schedule = { startWeek: Math.min(a, b), regularSeasonEndWeek: Math.max(a, b) };
          const w = seasonWindow(schedule, current);
          expect(w.firstWeek).toBe(Math.max(schedule.startWeek, current ?? 1));
          expect(w.weeksRemaining).toBe(Math.max(0, schedule.regularSeasonEndWeek - w.firstWeek + 1));
          expect(w.midSeason).toBe(w.firstWeek > 1);
          expect(w.shortSeason).toBe(w.weeksRemaining <= SHORT_SEASON_WEEKS);
        }
      )
    );
  });

  it('is a full season for a week-1 league before kickoff', () => {
    expect(seasonWindow({ startWeek: 1, regularSeasonEndWeek: 14 }, null)).toEqual({
      firstWeek: 1,
      lastWeek: 14,
      weeksRemaining: 14,
      midSeason: false,
      shortSeason: false
    });
  });
});

describe('draft risk', () => {
  const full = seasonWindow({ startWeek: 1, regularSeasonEndWeek: 14 }, null);
  const mid = seasonWindow({ startWeek: 9, regularSeasonEndWeek: 14 }, 9);
  const qb = (bye: number | null, injuryStatus: string | null = null): DraftRiskPlayer => ({
    position: 'QB',
    bye,
    injuryStatus
  });
  const playerArb = fc.record({
    position: fc.constantFrom(...OFFENSE_POSITIONS),
    bye: fc.option(fc.integer({ min: 5, max: 14 })),
    injuryStatus: fc.constantFrom(null, 'Questionable', 'Doubtful', 'Out', 'IR', 'PUP', 'Sus')
  });

  it('is never a bonus, and is one of the known penalties', () => {
    fc.assert(
      fc.property(playerArb, fc.array(playerArb, { maxLength: 8 }), fc.boolean(), (c, roster, midSeason) => {
        const m = draftRiskMultiplier(c, roster, midSeason ? mid : full);
        expect([1, BYE_CLASH_PENALTY, SIDELINED_PENALTY, BYE_CLASH_PENALTY * SIDELINED_PENALTY]).toContain(m);
        // An empty roster has no bye to clash with, and a healthy player has nothing to miss.
        expect(draftRiskMultiplier({ ...c, injuryStatus: null }, [], midSeason ? mid : full)).toBe(1);
      })
    );
  });

  it('only a mid-season draft marks down sidelined players', () => {
    fc.assert(
      fc.property(playerArb, (c) => {
        const out = { ...c, injuryStatus: 'Out' };
        expect(draftRiskMultiplier(out, [], full)).toBe(1);
        expect(draftRiskMultiplier(out, [], mid)).toBe(SIDELINED_PENALTY);
      })
    );
    expect(['Out', 'IR', 'PUP', 'Sus'].every(isSidelined)).toBe(true);
    expect([null, 'Questionable', 'Doubtful'].some(isSidelined)).toBe(false);
  });

  it('marks down a player whose bye matches most of his position mates', () => {
    expect(byeClash(qb(10), [qb(10)], full)).toBe(true);
    expect(byeClash(qb(10), [qb(10), qb(7)], full)).toBe(false);
    expect(byeClash(qb(10), [qb(10), qb(10), qb(7)], full)).toBe(true);
    expect(byeClash(qb(10), [{ position: 'RB', bye: 10 }], full)).toBe(false);
    expect(byeClash(qb(null), [qb(null)], full)).toBe(false);
    // A bye already played does not matter to a mid-season team.
    expect(byeClash(qb(6), [qb(6)], mid)).toBe(false);
    expect(byeRemains(6, mid)).toBe(false);
    expect(byeRemains(12, mid)).toBe(true);
    expect(draftRiskMultiplier(qb(10, 'IR'), [qb(10)], mid)).toBe(BYE_CLASH_PENALTY * SIDELINED_PENALTY);
  });
});
