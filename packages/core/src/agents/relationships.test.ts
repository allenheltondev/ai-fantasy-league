import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { emptyMemory, rememberEvent, type AgentLeagueMemory, type MemoryEvent } from './memory.js';
import {
  BOND_HALF_LIFE_DAYS,
  BOND_MAX,
  bondStance,
  relationshipWith,
  relationshipsFrom,
  stanceWords,
  type BondStance
} from './relationships.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-13T12:00:00.000Z');
const on = (days: number) => new Date(T0 + days * DAY).toISOString();

const game = (week: number, teamId: string, pf: number, pa: number, days: number): MemoryEvent => ({
  type: 'matchup',
  opponentTeamId: teamId,
  week,
  pointsFor: pf,
  pointsAgainst: pa,
  at: on(days)
});
const trade = (
  tradeId: string,
  teamId: string,
  outcome: 'rejected' | 'expired' | 'countered' | 'accepted' | 'processed' | 'vetoed' | 'proposed',
  days: number,
  extra: Partial<Extract<MemoryEvent, { type: 'trade' }>> = {}
): MemoryEvent => ({
  type: 'trade',
  teamId,
  tradeId,
  outcome,
  direction: 'outgoing',
  summary: `Trade ${outcome}.`,
  at: on(days),
  ...extra
});
const remember = (events: readonly MemoryEvent[], base: AgentLeagueMemory = emptyMemory()) =>
  events.reduce(rememberEvent, base);

describe('relationships (#210)', () => {
  it('turns a close loss into rivalry, not hostility, and a fair trade into warmth', () => {
    const m = remember([game(1, 'rival', 99, 104, 0), trade('t1', 'friend', 'processed', 0, { value: 2 })]);
    const rival = relationshipWith(m, 'rival', on(0));
    expect(rival).toMatchObject({ rivalry: 2, grudge: 0, warmth: 0, stance: 'rivals' });
    expect(rival?.reasons).toEqual(['week 1 you lost a close one to them 99-104']);
    expect(relationshipWith(m, 'friend', on(0))).toMatchObject({
      warmth: 2,
      grudge: 0,
      stance: 'on_good_terms'
    });
    // Winning never builds a grudge.
    const won = remember([game(1, 'x', 150, 90, 0)]);
    expect(relationshipWith(won, 'x', on(0))).toMatchObject({ grudge: 0, rivalry: 1, stance: 'neutral' });
    expect(relationshipWith(won, 'nobody')).toBeNull();
  });

  it('only counts a turned-down offer against the team that turned it down', () => {
    const mine = remember([trade('t1', 'a', 'rejected', 0)]);
    expect(relationshipWith(mine, 'a', on(0))).toMatchObject({ grudge: 1, stance: 'wary' });
    const theirs = remember([trade('t1', 'a', 'rejected', 0, { direction: 'incoming' })]);
    expect(relationshipWith(theirs, 'a', on(0))).toBeNull();
    // Stored before directions: read from the summary.
    const legacy = remember([
      trade('t2', 'b', 'expired', 0, { direction: undefined, summary: 'An offer from b was expired.' })
    ]);
    expect(relationshipWith(legacy, 'b', on(0))).toBeNull();
  });

  it('lets an old grudge fade with time', () => {
    const m = remember([
      game(1, 'b', 70, 130, 0),
      trade('t1', 'b', 'rejected', 1),
      trade('t2', 'b', 'rejected', 2),
      trade('t3', 'b', 'rejected', 3)
    ]);
    const fresh = relationshipWith(m, 'b', on(3));
    expect(fresh?.stance).toBe('grudge');
    expect(fresh?.grudge).toBeGreaterThanOrEqual(3);
    // Two half-lives later, a quarter of it is left: the grudge has cooled.
    const later = relationshipWith(m, 'b', on(3 + 2 * BOND_HALF_LIFE_DAYS.grudge));
    expect(later?.grudge).toBeCloseTo((fresh?.grudge ?? 0) / 4, 1);
    expect(later?.stance).toBe('cooling');
    expect(stanceWords('cooling')).toContain('cooled');
  });

  it('repairs a grudge with a fair deal', () => {
    const feud = [
      game(1, 'b', 70, 130, 0),
      trade('t1', 'b', 'rejected', 1),
      trade('t2', 'b', 'rejected', 2),
      trade('t3', 'b', 'rejected', 3)
    ];
    const before = relationshipWith(remember(feud), 'b', on(4));
    const m = remember([...feud, trade('t4', 'b', 'processed', 4, { value: 1 })]);
    const after = relationshipWith(m, 'b', on(4));
    expect(after?.grudge).toBeLessThan((before?.grudge ?? 0) - 1.5);
    expect(after?.warmth).toBe(2);
    expect(after?.stance).toBe('mending');
    expect(after?.reasons[0]).toBe('a fair trade went through');
    // A trade they won big by the agent's own numbers is no repair.
    const fleeced = relationshipWith(
      remember([...feud, trade('t4', 'b', 'processed', 4, { value: -20 })]),
      'b',
      on(4)
    );
    expect(fleeced?.grudge).toBeGreaterThan(before?.grudge ?? 0);
    expect(fleeced?.stance).toBe('grudge');
  });

  it('reads a corrected result, not the provisional one', () => {
    const m = remember([game(1, 'b', 95, 100, 0)]);
    expect(relationshipWith(m, 'b', on(0))?.reasons[0]).toBe('week 1 you lost a close one to them 95-100');
    const fixed = rememberEvent(m, {
      type: 'matchup',
      opponentTeamId: 'b',
      week: 1,
      pointsFor: 103,
      pointsAgainst: 100,
      at: on(3),
      official: true
    });
    const bond = relationshipWith(fixed, 'b', on(3));
    expect(bond?.reasons).toEqual(['week 1 you edged them 103-100 (after stat corrections)']);
    expect(bond?.grudge).toBe(0);
  });

  it('reads stored grudge counts from before #210 as a grudge that decays', () => {
    const m = { ...emptyMemory(), rivals: [{ teamId: 'old', grudge: 9, reason: 'x', at: on(0) }] };
    expect(relationshipWith(m, 'old', on(0))).toMatchObject({ grudge: BOND_MAX / 2, stance: 'grudge' });
    expect(relationshipWith(m, 'old', on(90))?.stance).toBe('cooling');
  });

  it('names every stance', () => {
    const cases: [Parameters<typeof bondStance>[0], BondStance][] = [
      [{ warmth: 0, rivalry: 0, grudge: 0, peakGrudge: 0 }, 'neutral'],
      [{ warmth: 2, rivalry: 4, grudge: 0, peakGrudge: 0 }, 'friendly_rivals'],
      [{ warmth: 2, rivalry: 0, grudge: 0, peakGrudge: 0 }, 'on_good_terms'],
      [{ warmth: 0, rivalry: 3, grudge: 0, peakGrudge: 0 }, 'rivals'],
      [{ warmth: 0, rivalry: 0, grudge: 1.2, peakGrudge: 1.2 }, 'wary'],
      [{ warmth: 0, rivalry: 0, grudge: 4, peakGrudge: 4 }, 'grudge'],
      [{ warmth: 2, rivalry: 0, grudge: 1, peakGrudge: 4 }, 'mending'],
      [{ warmth: 0, rivalry: 0, grudge: 1, peakGrudge: 4 }, 'cooling']
    ];
    for (const [bond, stance] of cases) {
      expect(bondStance(bond)).toBe(stance);
      expect(stanceWords(stance).length).toBeGreaterThan(0);
    }
  });

  it('stays bounded, decays, and reads the same on replay (property)', () => {
    const event = fc.oneof(
      fc
        .tuple(
          fc.integer({ min: 1, max: 17 }),
          fc.constantFrom('a', 'b', 'c'),
          fc.integer({ min: 0, max: 200 }),
          fc.integer({ min: 0, max: 200 }),
          fc.integer({ min: 0, max: 120 })
        )
        .map(([w, t, pf, pa, d]) => game(w, t, pf, pa, d)),
      fc
        .tuple(
          fc.string({ minLength: 1, maxLength: 3 }),
          fc.constantFrom('a', 'b', 'c'),
          fc.constantFrom(
            'rejected',
            'expired',
            'countered',
            'accepted',
            'processed',
            'vetoed',
            'proposed' as const
          ),
          fc.integer({ min: 0, max: 120 }),
          fc.option(fc.integer({ min: -40, max: 40 }), { nil: undefined }),
          fc.constantFrom('outgoing', 'incoming' as const)
        )
        .map(([id, t, o, d, value, direction]) =>
          trade(id, t, o, d, { direction, ...(value === undefined ? {} : { value }) })
        )
    );
    fc.assert(
      fc.property(fc.array(event, { maxLength: 40 }), fc.integer({ min: 0, max: 400 }), (events, days) => {
        const m = remember(events);
        const now = on(days + 120);
        const bonds = relationshipsFrom(m, now);
        for (const b of bonds) {
          for (const v of [b.warmth, b.rivalry, b.grudge]) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(BOND_MAX);
          }
        }
        // Replaying the same events reads the same, and time only ever cools things down.
        expect(relationshipsFrom(remember(events), now)).toEqual(bonds);
        for (const later of relationshipsFrom(m, on(days + 400))) {
          const b = bonds.find((x) => x.teamId === later.teamId);
          expect(later.grudge).toBeLessThanOrEqual(b?.grudge ?? 0);
          expect(later.warmth).toBeLessThanOrEqual(b?.warmth ?? 0);
        }
      })
    );
  });
});
