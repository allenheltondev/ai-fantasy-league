import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hashString, seededRandom, seededShuffle } from './random.js';
import { generateSchedule, matchupFor, type ScheduleOptions, type ScheduleWeek } from './schedule.js';

const teams = (n: number): string[] => Array.from({ length: n }, (_, i) => `t${i + 1}`);

function unwrap(teamIds: readonly string[], options: ScheduleOptions): ScheduleWeek[] {
  const r = generateSchedule(teamIds, options);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

function meetings(schedule: readonly ScheduleWeek[], ids: readonly string[]): number[] {
  const counts = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) counts.set(pairKey(ids[i]!, ids[j]!), 0);
  }
  for (const w of schedule) {
    for (const m of w.matchups) {
      const k = pairKey(m.homeTeamId, m.awayTeamId);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return [...counts.values()];
}

describe('generateSchedule', () => {
  it('builds a full 8-team, 14-week Yahoo schedule', () => {
    const ids = teams(8);
    const s = unwrap(ids, { startWeek: 1, regularSeasonEndWeek: 14, seed: 'league-1' });
    expect(s).toHaveLength(14);
    expect(s.map((w) => w.week)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    // 14 weeks = 2 full round robins: every pair meets exactly twice, once at each team's home.
    expect(new Set(meetings(s, ids))).toEqual(new Set([2]));
    for (const id of ids) {
      const home = s.flatMap((w) => w.matchups).filter((m) => m.homeTeamId === id).length;
      expect(home).toBe(7);
    }
  });

  it('is deterministic for a seed and varies with the seed', () => {
    const opts = { startWeek: 1, regularSeasonEndWeek: 14, seed: 42 };
    expect(unwrap(teams(10), opts)).toEqual(unwrap(teams(10), opts));
    expect(unwrap(teams(10), opts)).not.toEqual(unwrap(teams(10), { ...opts, seed: 43 }));
  });

  it('covers a mid-season start with a partial round robin', () => {
    const ids = teams(8);
    const s = unwrap(ids, { startWeek: 9, regularSeasonEndWeek: 14, seed: 'x' });
    expect(s.map((w) => w.week)).toEqual([9, 10, 11, 12, 13, 14]);
    const m = meetings(s, ids);
    expect(Math.max(...m) - Math.min(...m)).toBeLessThanOrEqual(1);
  });

  it('handles a two-team league (the only pairing repeats)', () => {
    const s = unwrap(['a', 'b'], { startWeek: 1, regularSeasonEndWeek: 3, seed: 1 });
    expect(s.every((w) => w.matchups.length === 1)).toBe(true);
    expect(s[0]!.matchups[0]!.homeTeamId).not.toBe(s[1]!.matchups[0]!.homeTeamId);
  });

  it('finds a team matchup', () => {
    const s = unwrap(teams(4), { startWeek: 1, regularSeasonEndWeek: 3, seed: 1 });
    const m = matchupFor(s, 2, 't1');
    expect(m && [m.homeTeamId, m.awayTeamId]).toContain('t1');
    expect(matchupFor(s, 9, 't1')).toBeUndefined();
  });

  it('rejects odd, too-small, and duplicate team lists and bad weeks', () => {
    const opts = { startWeek: 1, regularSeasonEndWeek: 14, seed: 1 };
    const codes = (ids: string[], o: ScheduleOptions = opts): string[] => {
      const r = generateSchedule(ids, o);
      return r.ok ? [] : r.issues.map((i) => i.code);
    };
    expect(codes(teams(7))).toEqual(['SCHEDULE_ODD_TEAMS']);
    expect(codes(['a'])).toEqual(['SCHEDULE_TOO_FEW_TEAMS']);
    expect(codes(['a', 'a'])).toEqual(['SCHEDULE_INVALID_TEAMS']);
    expect(codes(['a', ''])).toEqual(['SCHEDULE_INVALID_TEAMS']);
    expect(codes(teams(4), { ...opts, startWeek: 15 })).toEqual(['SEASON_HAS_NO_WEEKS']);
    expect(codes(teams(4), { ...opts, regularSeasonEndWeek: 19 })).toEqual(['INVALID_WEEK']);
    const r = generateSchedule(teams(7), opts);
    expect(!r.ok && r.issues[0]!.fix).toMatch(/8|6/);
  });
});

describe('schedule properties', () => {
  const input = fc.record({
    n: fc.integer({ min: 1, max: 6 }).map((k) => k * 2),
    start: fc.integer({ min: 1, max: 18 }),
    len: fc.integer({ min: 1, max: 18 }),
    seed: fc.oneof(fc.string(), fc.integer())
  });

  it('every week is a perfect matching and meetings per pair differ by at most 1', () => {
    fc.assert(
      fc.property(input, ({ n, start, len, seed }) => {
        const end = Math.min(18, start + len - 1);
        const ids = teams(n);
        const s = unwrap(ids, { startWeek: start, regularSeasonEndWeek: end, seed });
        expect(s).toHaveLength(end - start + 1);
        for (const w of s) {
          const seen = w.matchups.flatMap((m) => [m.homeTeamId, m.awayTeamId]);
          expect(seen.sort()).toEqual([...ids].sort());
          expect(w.matchups.every((m) => m.homeTeamId !== m.awayTeamId && m.week === w.week)).toBe(true);
        }
        const m = meetings(s, ids);
        expect(Math.max(...m) - Math.min(...m)).toBeLessThanOrEqual(1);
      })
    );
  });

  it('never repeats a pairing in consecutive weeks when there are 4 or more teams', () => {
    fc.assert(
      fc.property(input, ({ n, start, len, seed }) => {
        fc.pre(n >= 4);
        const end = Math.min(18, start + len - 1);
        const s = unwrap(teams(n), { startWeek: start, regularSeasonEndWeek: end, seed });
        for (let i = 1; i < s.length; i++) {
          const prev = new Set(s[i - 1]!.matchups.map((m) => pairKey(m.homeTeamId, m.awayTeamId)));
          for (const m of s[i]!.matchups) expect(prev.has(pairKey(m.homeTeamId, m.awayTeamId))).toBe(false);
        }
      })
    );
  });
});

describe('seeded random helpers', () => {
  it('hashes and shuffles deterministically', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
    const a = seededShuffle([1, 2, 3, 4, 5], seededRandom('s'));
    expect(a).toEqual(seededShuffle([1, 2, 3, 4, 5], seededRandom('s')));
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5]);
    const r = seededRandom(7);
    for (let i = 0; i < 100; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
