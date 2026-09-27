import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IR_ELIGIBLE_STATUSES,
  ROSTER_SLOTS,
  eligibleStarterSlots,
  isEligibleForSlot,
  isStarterSlot,
  normalizePlayerStatus,
  normalizePosition
} from './positions.js';

describe('slot eligibility', () => {
  it.each([
    ['W/R/T', ['WR', 'RB', 'TE'], ['QB', 'K', 'DEF']],
    ['Q/W/R/T', ['QB', 'WR', 'RB', 'TE'], ['K', 'DEF', 'LB']],
    ['W/T', ['WR', 'TE'], ['RB', 'QB']],
    ['W/R', ['WR', 'RB'], ['TE', 'QB']],
    ['IDP', ['DL', 'LB', 'DB'], ['DEF', 'QB']],
    ['DEF', ['DEF'], ['DL', 'LB']],
    ['QB', ['QB'], ['WR']],
    ['BN', ['QB', 'K', 'DEF', 'DB'], []],
    ['IR', ['QB', 'K', 'DEF', 'DB'], []]
  ] as const)('%s accepts %j and rejects %j', (slot, yes, no) => {
    for (const p of yes) expect(isEligibleForSlot(slot, [p])).toBe(true);
    for (const p of no) expect(isEligibleForSlot(slot, [p])).toBe(false);
  });

  it('multi-position players qualify through any position', () => {
    expect(isEligibleForSlot('TE', ['WR', 'TE'])).toBe(true);
    expect(isEligibleForSlot('QB', ['WR', 'TE'])).toBe(false);
  });

  it('lists starting slots a player could fill', () => {
    expect(eligibleStarterSlots(['RB'])).toEqual(['RB', 'W/R/T', 'Q/W/R/T', 'W/R']);
    expect(eligibleStarterSlots(['K'])).toEqual(['K']);
  });

  it('only BN and IR are non-starting', () => {
    expect(ROSTER_SLOTS.filter((s) => !isStarterSlot(s))).toEqual(['BN', 'IR']);
  });
});

describe('normalizePosition', () => {
  it.each([
    ['qb', 'QB'],
    [' WR ', 'WR'],
    ['FB', 'RB'],
    ['PK', 'K'],
    ['D/ST', 'DEF'],
    ['DE', 'DL'],
    ['OLB', 'LB'],
    ['CB', 'DB'],
    ['SS', 'DB'],
    ['OL', null],
    ['P', null]
  ])('%s → %s', (raw, expected) => {
    expect(normalizePosition(raw)).toBe(expected);
  });
});

describe('normalizePlayerStatus', () => {
  it.each([
    ['Questionable', null, 'questionable'],
    ['Doubtful', 'Active', 'doubtful'],
    ['Out', null, 'out'],
    ['IR', null, 'ir'],
    ['PUP', null, 'pup'],
    ['NFI-R', null, 'nfi'],
    ['Sus', null, 'suspended'],
    ['COV', null, 'covid'],
    ['NA', null, 'na'],
    [null, 'Injured Reserve', 'ir'],
    [null, 'Physically Unable to Perform', 'pup'],
    [null, 'Non Football Injury', 'nfi'],
    [null, 'Inactive', 'na'],
    [null, 'Active', 'active'],
    [undefined, undefined, 'active'],
    ['Weird', 'Other', 'active'],
    ['', 'Injured Reserve', 'ir']
  ])('(%s, %s) → %s', (injury, status, expected) => {
    expect(normalizePlayerStatus(injury, status)).toBe(expected);
  });

  it('IR-eligible statuses match Yahoo (IR, O, PUP, NFI, COVID)', () => {
    expect([...DEFAULT_IR_ELIGIBLE_STATUSES].sort()).toEqual(['covid', 'ir', 'nfi', 'out', 'pup']);
  });
});
