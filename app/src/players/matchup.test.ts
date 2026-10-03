import { describe, expect, it } from 'vitest';
import { experienceText, matchupStrength, positionPlural } from './matchup';

describe('matchupStrength', () => {
  it('rates the top third favorable, the bottom third tough, and the rest average', () => {
    expect(matchupStrength(1, 32)).toBe('favorable');
    expect(matchupStrength(10, 32)).toBe('favorable');
    expect(matchupStrength(11, 32)).toBe('neutral');
    expect(matchupStrength(21, 32)).toBe('neutral');
    expect(matchupStrength(22, 32)).toBe('tough');
  });

  it('calls every matchup average with fewer than three defenses ranked', () => {
    expect(matchupStrength(1, 2)).toBe('neutral');
    expect(matchupStrength(2, 2)).toBe('neutral');
  });
});

describe('positionPlural', () => {
  it('names who a defense allows points to', () => {
    expect(positionPlural('WR')).toBe('WRs');
    expect(positionPlural('K')).toBe('kickers');
    expect(positionPlural('DEF')).toBe('team defenses');
  });
});

describe('experienceText', () => {
  it('counts seasons from Sleeper’s years of experience', () => {
    expect(experienceText(0)).toBe('Rookie');
    expect(experienceText(1)).toBe('2nd season');
    expect(experienceText(10)).toBe('11th season');
  });
});
