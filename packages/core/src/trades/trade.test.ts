import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { NOW, context, rp, settings, squad } from './fixtures.test-helpers.js';
import {
  applyTrade,
  expiresAt,
  isTradeDeadlinePassed,
  validateTrade,
  type RosteredPlayer,
  type TradeSide
} from './trade.js';

const side = (teamId: string, sends: string[] = [], drops: string[] = []): TradeSide => ({
  teamId,
  sends,
  drops
});

describe('expiresAt', () => {
  it('is 48 hours after the proposal when no lock comes first', () => {
    expect(expiresAt(settings, NOW, null)).toBe('2026-10-03T12:00:00.000Z');
    expect(expiresAt(settings, NOW, '2026-10-05T17:00:00Z')).toBe('2026-10-03T12:00:00.000Z');
  });

  it('is the next lineup lock when that comes first', () => {
    expect(expiresAt(settings, NOW, '2026-10-02T00:15:00Z')).toBe('2026-10-02T00:15:00.000Z');
  });

  it('ignores a lock in the past and a disabled lock rule', () => {
    expect(expiresAt(settings, NOW, '2026-09-30T00:00:00Z')).toBe('2026-10-03T12:00:00.000Z');
    const noLock = { trades: { ...settings.trades, expireAtNextLineupLock: false, offerExpiryHours: 24 } };
    expect(expiresAt(noLock, NOW, '2026-10-01T13:00:00Z')).toBe('2026-10-02T12:00:00.000Z');
  });
});

describe('isTradeDeadlinePassed', () => {
  const games = { KC: { kickoff: '2026-11-15T18:00:00Z' }, BUF: { kickoff: '2026-11-13T01:15:00Z' } };
  it('uses the deadline week and its first kickoff', () => {
    expect(isTradeDeadlinePassed(settings, 10, games, NOW)).toBe(false);
    expect(isTradeDeadlinePassed(settings, 12, undefined, NOW)).toBe(true);
    expect(isTradeDeadlinePassed(settings, 11, games, '2026-11-13T01:14:59Z')).toBe(false);
    expect(isTradeDeadlinePassed(settings, 11, games, '2026-11-13T01:15:00Z')).toBe(true);
    expect(isTradeDeadlinePassed(settings, 11, undefined, NOW)).toBe(false);
  });
});

describe('validateTrade', () => {
  const rosters = {
    A: [...squad('a', 15), rp('aIR', 'RB', 'KC', { slot: 'IR', status: 'ir' })],
    B: squad('b', 10, 'BUF')
  };

  it('accepts a legal trade', () => {
    const v = validateTrade(
      settings,
      { sides: [side('A', ['a0']), side('B', ['b0'])] },
      context(rosters),
      'proposal'
    );
    expect(v).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('rejects a team trading with itself and unknown teams', () => {
    const same = validateTrade(
      settings,
      { sides: [side('A', ['a0']), side('A')] },
      context(rosters),
      'proposal'
    );
    expect(same.errors.map((e) => e.code)).toEqual(['SAME_TEAM']);
    const unknown = validateTrade(
      settings,
      { sides: [side('A', ['a0']), side('Z')] },
      context(rosters),
      'proposal'
    );
    expect(unknown.errors.map((e) => e.code)).toEqual(['UNKNOWN_TEAM']);
  });

  it('rejects an empty trade, duplicates, and players not on the roster', () => {
    const empty = validateTrade(settings, { sides: [side('A'), side('B')] }, context(rosters), 'proposal');
    expect(empty.errors.map((e) => e.code)).toEqual(['TRADE_EMPTY']);
    const bad = validateTrade(
      settings,
      { sides: [side('A', ['a0', 'b1'], ['a0']), side('B', ['b0'], ['zz'])] },
      context(rosters),
      'proposal'
    );
    expect(bad.errors.map((e) => e.code)).toEqual([
      'PLAYER_NOT_ON_ROSTER',
      'DUPLICATE_PLAYER',
      'PLAYER_NOT_ON_ROSTER'
    ]);
    expect(bad.errors[0]?.fix).toMatch(/out of date/);
    expect(bad.errors[2]?.fix).toMatch(/Drop a player who is on team B/);
  });

  it('rejects locked players and trades after the deadline', () => {
    const games = { KC: { kickoff: '2026-10-01T11:00:00Z' }, BUF: { kickoff: '2026-10-04T17:00:00Z' } };
    const v = validateTrade(
      settings,
      { sides: [side('A', ['a0'], ['a1']), side('B', ['b0'])] },
      context(rosters, { games, currentWeek: 12 }),
      'processing'
    );
    expect(v.errors.map((e) => e.code)).toEqual(['PLAYER_LOCKED', 'PLAYER_LOCKED', 'TRADE_DEADLINE_PASSED']);
    expect(v.errors[1]?.message).toMatch(/cannot be dropped/);
  });

  it('requires drops so both rosters fit, but only warns about the responder at proposal', () => {
    const trade = { sides: [side('A', ['a0']), side('B', ['b0', 'b1'])] as [TradeSide, TradeSide] };
    const atProposal = validateTrade(settings, trade, context(rosters), 'proposal');
    expect(atProposal.valid).toBe(true);
    expect(atProposal.warnings).toEqual([]);

    const bFull = { ...rosters, B: squad('b', 16, 'BUF') };
    const reverse = { sides: [side('B', ['b0']), side('A', ['a0', 'a1'])] as [TradeSide, TradeSide] };
    const r = validateTrade(settings, reverse, context(bFull), 'proposal');
    expect(r.errors.map((e) => e.code)).toEqual(['ROSTER_LIMIT_EXCEEDED']);
    expect(r.errors[0]?.details).toMatchObject({ teamId: 'B', activeAfter: 17, limit: 16, dropsNeeded: 1 });

    const aNearFull = { ...rosters, A: squad('a', 16) };
    const warned = validateTrade(
      settings,
      { sides: [side('B', ['b0', 'b1']), side('A', ['a0'])] },
      context(aNearFull),
      'proposal'
    );
    expect(warned.valid).toBe(true);
    expect(warned.warnings.map((w) => w.code)).toEqual(['RESPONDER_MUST_DROP']);
    const accepted = validateTrade(
      settings,
      { sides: [side('B', ['b0', 'b1']), side('A', ['a0'])] },
      context(aNearFull),
      'acceptance'
    );
    expect(accepted.errors.map((e) => e.code)).toEqual(['ROSTER_LIMIT_EXCEEDED']);
    const withDrop = validateTrade(
      settings,
      { sides: [side('B', ['b0', 'b1']), side('A', ['a0'], ['a1'])] },
      context(aNearFull),
      'acceptance'
    );
    expect(withDrop.valid).toBe(true);
  });
});

describe('applyTrade', () => {
  const rosters = {
    A: [rp('a0', 'QB', 'KC', { slot: 'QB' }), rp('a1', 'WR'), rp('a2', 'RB')],
    B: [rp('b0', 'TE', 'BUF', { slot: 'TE' }), rp('b1', 'K', 'BUF')]
  };

  it('swaps players onto the bench and releases drops', () => {
    const { rosters: out, dropped } = applyTrade(rosters, {
      sides: [side('A', ['a0'], ['a2']), side('B', ['b0'])]
    });
    expect(out.A?.map((p) => [p.playerId, p.slot])).toEqual([
      ['a1', 'BN'],
      ['b0', 'BN']
    ]);
    expect(out.B?.map((p) => [p.playerId, p.slot])).toEqual([
      ['b1', 'BN'],
      ['a0', 'BN']
    ]);
    expect(dropped.map((p) => p.playerId)).toEqual(['a2']);
    // The input is untouched.
    expect(rosters.A.map((p) => p.playerId)).toEqual(['a0', 'a1', 'a2']);
  });

  it('ignores players not on the listed team, same-team trades, and unknown teams', () => {
    expect(applyTrade(rosters, { sides: [side('A', ['b0']), side('B')] }).rosters).toEqual(rosters);
    expect(applyTrade(rosters, { sides: [side('A', ['a0']), side('A')] }).rosters).toEqual(rosters);
    expect(applyTrade(rosters, { sides: [side('A', ['a0']), side('Z', ['z'])] }).rosters).toEqual(rosters);
  });

  it('never creates or loses a player', () => {
    const ids = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('A', 'B', 'C'), { minLength: ids.length, maxLength: ids.length }),
        fc.subarray(ids),
        fc.subarray(ids),
        fc.subarray(ids),
        fc.subarray(ids),
        fc.constantFrom('A', 'B', 'C'),
        fc.constantFrom('A', 'B', 'C'),
        (owners, aSends, aDrops, bSends, bDrops, ta, tb) => {
          const start: Record<string, RosteredPlayer[]> = { A: [], B: [], C: [] };
          ids.forEach((id, i) => start[owners[i] as string]?.push(rp(id, 'WR')));
          const { rosters: out, dropped } = applyTrade(start, {
            sides: [side(ta, aSends, aDrops), side(tb, bSends, bDrops)]
          });
          const after = [...Object.values(out).flat(), ...dropped].map((p) => p.playerId).sort();
          expect(after).toEqual([...ids].sort());
        }
      )
    );
  });
});
