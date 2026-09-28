import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { OFFENSE_POSITIONS } from '../rules/positions.js';
import { yahooDefaultSettings } from '../rules/settings.js';
import { unfilledStarterSlots } from './autopick.js';
import { rosterLayout, starterSlotFill } from './depth.js';

const settings = yahooDefaultSettings(8);

describe('starterSlotFill', () => {
  it('lists every starting slot the league uses as empty for an empty roster', () => {
    const fill = starterSlotFill(settings, []);
    expect(fill.find((f) => f.slot === 'RB')).toEqual({ slot: 'RB', required: 2, filled: 0 });
    expect(fill.some((f) => f.slot === 'BN' || f.slot === 'Q/W/R/T')).toBe(false);
  });

  it('fills specific slots first, then the flex', () => {
    const fill = starterSlotFill(settings, [['RB'], ['RB'], ['RB'], ['QB']]);
    expect(fill.find((f) => f.slot === 'RB')).toMatchObject({ required: 2, filled: 2 });
    expect(fill.find((f) => f.slot === 'W/R/T')).toMatchObject({ required: 1, filled: 1 });
    expect(fill.find((f) => f.slot === 'QB')).toMatchObject({ filled: 1 });
    expect(fill.find((f) => f.slot === 'WR')).toMatchObject({ required: 3, filled: 0 });
  });

  it('never overfills a slot', () => {
    const fill = starterSlotFill(settings, [['QB'], ['QB'], ['QB']]);
    expect(fill.find((f) => f.slot === 'QB')).toMatchObject({ required: 1, filled: 1 });
  });
});

describe('rosterLayout', () => {
  it('shows every starting seat, fills specific slots first, and benches the rest in pick order', () => {
    const layout = rosterLayout(settings, [
      { playerId: 'rb1', positions: ['RB'] },
      { playerId: 'rb2', positions: ['RB'] },
      { playerId: 'rb3', positions: ['RB'] },
      { playerId: 'qb1', positions: ['QB'] },
      { playerId: 'qb2', positions: ['QB'] },
      { playerId: 'rb4', positions: ['RB'] }
    ]);
    expect(layout.starters.map((s) => `${s.slot}:${s.playerId ?? '-'}`)).toEqual([
      'QB:qb1',
      'WR:-',
      'WR:-',
      'WR:-',
      'RB:rb1',
      'RB:rb2',
      'TE:-',
      'W/R/T:rb3',
      'K:-',
      'DEF:-'
    ]);
    expect(layout.bench).toEqual(['qb2', 'rb4']);
  });

  it('leaves open exactly the slots unfilledStarterSlots reports, and places every player once', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...OFFENSE_POSITIONS), { maxLength: 20 }), (positions) => {
        const drafted = positions.map((p, i) => ({ playerId: `p${i}`, positions: [p] as const }));
        const layout = rosterLayout(settings, drafted);
        const open = layout.starters.filter((s) => s.playerId === null).map((s) => s.slot);
        expect([...open].sort()).toEqual(
          [
            ...unfilledStarterSlots(
              settings,
              drafted.map((d) => d.positions)
            )
          ].sort()
        );
        const placed = [
          ...layout.starters.flatMap((s) => (s.playerId === null ? [] : [s.playerId])),
          ...layout.bench
        ];
        expect([...placed].sort()).toEqual(drafted.map((d) => d.playerId).sort());
      })
    );
  });
});
