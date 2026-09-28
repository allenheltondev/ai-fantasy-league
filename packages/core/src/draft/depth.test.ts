import { describe, expect, it } from 'vitest';
import { yahooDefaultSettings } from '../rules/settings.js';
import { starterSlotFill } from './depth.js';

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
