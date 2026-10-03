import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { scorePlayer, type StatLine } from './engine.js';
import {
  describeChanges,
  isScoringChange,
  scoredStats,
  scorePlayerEvents,
  statChanges,
  sumPoints,
  toCents,
  type ScoringEvent
} from './log.js';
import { YAHOO_POINTS_ALLOWED_TIERS, scoringPreset, type ScoringSettings } from './settings.js';

const at = (minute: number) => `2026-09-13T17:${String(minute).padStart(2, '0')}:00.000Z`;
const event = (minute: number, stats: StatLine, playerId = 'p1'): ScoringEvent => ({
  playerId,
  at: at(minute),
  kind: 'live',
  stats
});

describe('statChanges', () => {
  it('lists every stat that moved, a missing stat counting as 0', () => {
    expect(statChanges({ rec: 1, rec_yd: 10, fum: 1 }, { rec: 2, rec_yd: 28, rec_td: 1 })).toEqual([
      { stat: 'fum', delta: -1 },
      { stat: 'rec', delta: 1 },
      { stat: 'rec_td', delta: 1 },
      { stat: 'rec_yd', delta: 18 }
    ]);
    expect(statChanges(undefined, { pass_yd: 0.1 + 0.2 })).toEqual([{ stat: 'pass_yd', delta: 0.3 }]);
  });
});

describe('isScoringChange', () => {
  it('ignores lines where only precomputed points, games, or snaps moved', () => {
    expect(isScoringChange({ pts_ppr: 1, off_snp: 10 }, { pts_ppr: 3, off_snp: 12, gp: 1 })).toBe(false);
    expect(isScoringChange({ rec: 1 }, { rec: 1 })).toBe(false);
    expect(isScoringChange({ rec_tgt: 1 }, { rec_tgt: 2 })).toBe(true);
    expect(isScoringChange(undefined, { rush_yd: 4 })).toBe(true);
  });

  it('ignores the nflverse usage stats the official final adds', () => {
    expect(isScoringChange({ rec: 5 }, { rec: 5, nfv_tgt_share: 0.25, nfv_rec_epa: -1.2 })).toBe(false);
    expect(isScoringChange({ rec: 5, nfv_wopr: 0.4 }, { rec: 6, nfv_wopr: 0.5 })).toBe(true);
  });
});

describe('scoredStats', () => {
  it('holds weighted and tiered stats, not zero weights', () => {
    const stats = scoredStats({ perStat: { rec: 0, rec_yd: 0.1 }, tiers: [YAHOO_POINTS_ALLOWED_TIERS] });
    expect([...stats].sort()).toEqual(['pts_allow', 'rec_yd']);
    expect(scoredStats({ scoring: scoringPreset('full_ppr') }).has('rec')).toBe(true);
  });
});

describe('scorePlayerEvents', () => {
  const ppr = scoringPreset('full_ppr');

  it('scores each change against the previous line, first against an empty line', () => {
    const scored = scorePlayerEvents(ppr, [
      event(2, { rec: 2, rec_yd: 28, rec_td: 1, rec_tgt: 3, pts_ppr: 12.8 }),
      event(1, { rec: 1, rec_yd: 10, rec_tgt: 2, pts_ppr: 2 })
    ]);
    expect(scored.map((s) => s.points)).toEqual([2, 8.8]);
    expect(scored[1]).toMatchObject({
      touchdown: true,
      summary: '+1 rec, +18 rec yds, +1 rec TD',
      changes: [
        { stat: 'rec', delta: 1 },
        { stat: 'rec_td', delta: 1 },
        { stat: 'rec_yd', delta: 18 }
      ]
    });
    expect(scored[0]?.touchdown).toBe(false);
  });

  it('lists only the stats the league scores, and negative points for a correction', () => {
    const standard = scoringPreset('standard');
    const scored = scorePlayerEvents(standard, [
      event(1, { rec: 3, rec_yd: 40, rec_td: 1 }),
      { ...event(9, { rec: 3, rec_yd: 38 }), kind: 'correction' }
    ]);
    expect(scored[1]).toMatchObject({
      points: -6.2,
      touchdown: false,
      summary: '-2 rec yds, -1 rec TD'
    });
    expect(scored[1]?.changes.map((c) => c.stat)).not.toContain('rec');
  });

  it("describes a defense's first line at 0 points allowed, which scores the shutout tier", () => {
    const scored = scorePlayerEvents(scoringPreset('yahoo_standard'), [event(1, { pts_allow: 0 })]);
    expect(scored[0]).toMatchObject({ points: 10, summary: '0 pts allowed' });
    expect(statChanges({ pts_allow: 0 }, {})).toEqual([{ stat: 'pts_allow', delta: 0 }]);
    expect(statChanges({ rec: 0 }, { rec: 0 })).toEqual([]);
  });

  it('keeps a change too small to show when rounded, since it can still cross a tier edge', () => {
    // fast-check's counterexample: points allowed going from the smallest float to 0 scores the shutout.
    expect(statChanges({ pts_allow: 5e-324 }, { pts_allow: 0 })).toEqual([{ stat: 'pts_allow', delta: 0 }]);
    const scored = scorePlayerEvents(scoringPreset('yahoo_standard'), [
      event(1, { pts_allow: 5e-324 }),
      event(2, { pts_allow: 0 })
    ]);
    expect(scored[1]?.changes.map((c) => c.stat)).toEqual(['pts_allow']);
  });

  it('scores tier changes: a defense giving up a touchdown', () => {
    const yahoo = scoringPreset('yahoo_standard');
    const scored = scorePlayerEvents(yahoo, [event(1, { pts_allow: 0 }), event(2, { pts_allow: 7 })]);
    expect(scored.map((s) => s.points)).toEqual([10, -6]);
    expect(scored[1]?.summary).toBe('+7 pts allowed');
  });

  it('refuses events of different players', () => {
    expect(() => scorePlayerEvents(ppr, [event(1, { rec: 1 }), event(2, { rec: 2 }, 'p2')])).toThrow();
  });

  it('returns nothing for no events', () => {
    expect(scorePlayerEvents(ppr, [])).toEqual([]);
  });
});

describe('describeChanges', () => {
  it('uses short singular and plural labels, puts touchdowns last, and falls back to the key', () => {
    expect(
      describeChanges([
        { stat: 'pass_td', delta: 1 },
        { stat: 'pass_yd', delta: 42 },
        { stat: 'custom_stat', delta: 1.5 },
        { stat: 'fgm_40_49', delta: 2 },
        { stat: 'rush_att', delta: 1 }
      ])
    ).toBe('+42 pass yds, +1 carry, +2 FGs (40-49), +1.5 custom_stat, +1 pass TD');
    expect(describeChanges([])).toBe('');
  });
});

describe('sumPoints and toCents', () => {
  it('adds point values exactly', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumPoints([0.1, 0.2])).toBe(0.3);
    expect(toCents(-6.2)).toBe(-620);
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const STAT_KEYS = [
  'pass_yd',
  'pass_td',
  'pass_int',
  'rush_yd',
  'rush_td',
  'rec',
  'rec_yd',
  'rec_td',
  'pts_allow',
  'off_snp'
];
const statValue = fc.oneof(
  fc.integer({ min: 0, max: 400 }),
  fc.double({ min: 0, max: 400, noNaN: true, noDefaultInfinity: true })
);
const statLineArb = fc.dictionary(fc.constantFrom(...STAT_KEYS), statValue);
const weight = fc.double({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true });
const customScoring = fc
  .record({ perStat: fc.dictionary(fc.constantFrom(...STAT_KEYS), weight), tiered: fc.boolean() })
  .map(({ perStat, tiered }): ScoringSettings => ({
    perStat,
    tiers: tiered ? [YAHOO_POINTS_ALLOWED_TIERS] : []
  }));
const scoringArb = fc.oneof(
  fc.constantFrom(scoringPreset('yahoo_standard'), scoringPreset('full_ppr'), scoringPreset('standard')),
  customScoring
);

/** A week of fetched lines for one player, as the live job stores them (only real changes). */
const weekArb = fc.array(statLineArb, { minLength: 1, maxLength: 12 }).map((lines) => {
  const events: ScoringEvent[] = [];
  let previous: StatLine | undefined;
  lines.forEach((line, i) => {
    if (!isScoringChange(previous, line)) return;
    events.push({
      playerId: 'p1',
      at: at(i),
      kind: i === lines.length - 1 ? 'correction' : 'live',
      stats: line
    });
    previous = line;
  });
  return events;
});

describe('scoring log properties', () => {
  it("a player's event points sum exactly to his week score", () => {
    fc.assert(
      fc.property(scoringArb, weekArb, (scoring, events) => {
        const scored = scorePlayerEvents(scoring, events);
        const total = scored.reduce((acc, s) => acc + toCents(s.points), 0);
        const last = events.at(-1)?.stats ?? {};
        expect(total).toBe(toCents(scorePlayer(scoring, last).points));
        expect(sumPoints(scored.map((s) => s.points))).toBe(scorePlayer(scoring, last).points);
      })
    );
  });

  it('the sum holds for any subset of the events (a missed read folds into the next one)', () => {
    fc.assert(
      fc.property(
        scoringArb,
        weekArb,
        fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
        (scoring, events, keep) => {
          const kept = events.filter((_, i) => keep[i] === true);
          const total = scorePlayerEvents(scoring, kept).reduce((acc, s) => acc + toCents(s.points), 0);
          expect(total).toBe(toCents(scorePlayer(scoring, kept.at(-1)?.stats ?? {}).points));
        }
      )
    );
  });

  it("each event's points are score(after) minus score(before), whatever the input order", () => {
    fc.assert(
      fc.property(scoringArb, weekArb, (scoring, events) => {
        const scored = scorePlayerEvents(scoring, [...events].reverse());
        scored.forEach((s, i) => {
          const before = i === 0 ? {} : (events[i - 1]?.stats ?? {});
          const expected =
            scorePlayer(scoring, events[i]?.stats ?? {}).points - scorePlayer(scoring, before).points;
          expect(toCents(s.points)).toBe(Math.round(expected * 100));
          expect(s.event).toBe(events[i]);
        });
      })
    );
  });

  it('an event with no scored stat change is worth nothing', () => {
    fc.assert(
      fc.property(scoringArb, weekArb, (scoring, events) => {
        for (const s of scorePlayerEvents(scoring, events)) {
          if (s.changes.length === 0) expect(s.points).toBe(0);
        }
      })
    );
  });
});
