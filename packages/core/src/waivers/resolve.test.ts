import { describe, expect, it } from 'vitest';
import type { LineupEntry } from '../rules/lineup.js';
import { yahooDefaultSettings, type LeagueSettings } from '../rules/settings.js';
import { resolveWaivers, type WaiverClaim, type WaiverState } from './resolve.js';

/** A tiny league: 3 active spots plus IR, so roster-full cases are easy to build. */
function settingsWith(waivers: Partial<LeagueSettings['waivers']> = {}): LeagueSettings {
  const base = yahooDefaultSettings(4);
  return {
    ...base,
    roster: { ...base.roster, slots: { QB: 1, BN: 2, IR: 1 } },
    waivers: { ...base.waivers, type: 'faab', ...waivers }
  };
}

const bench = (...ids: string[]): LineupEntry[] => ids.map((playerId) => ({ playerId, slot: 'BN' }));

function state(overrides: Partial<WaiverState> = {}): WaiverState {
  return {
    teams: {
      A: { roster: bench('a1'), faabRemaining: 100 },
      B: { roster: bench('b1'), faabRemaining: 100 },
      C: { roster: bench('c1'), faabRemaining: 100 }
    },
    priorityOrder: ['A', 'B', 'C'],
    availablePlayerIds: ['p1', 'p2', 'p3'],
    ...overrides
  };
}

let seq = 0;
function claim(
  teamId: string,
  addPlayerId: string,
  bid: number,
  extra: Partial<WaiverClaim> = {}
): WaiverClaim {
  seq += 1;
  return {
    claimId: `${teamId}-${addPlayerId}-${seq}`,
    teamId,
    addPlayerId,
    bid,
    priority: 1,
    createdAt: `2026-10-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
    ...extra
  };
}

const codes = (r: ReturnType<typeof resolveWaivers>) => r.failed.map((f) => f.issue.code);

describe('resolveWaivers (FAAB)', () => {
  it('awards the highest bid, charges it, and fails the other claims for that player', () => {
    const r = resolveWaivers(settingsWith(), [claim('A', 'p1', 10), claim('B', 'p1', 25)], state());
    expect(r.awarded.map((a) => [a.claim.teamId, a.cost])).toEqual([['B', 25]]);
    expect(r.budgets).toEqual({ A: 100, B: 75, C: 100 });
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]?.issue).toMatchObject({ code: 'PLAYER_CLAIMED', details: { winningTeamId: 'B' } });
    expect(r.failed[0]?.issue.fix).toMatch(/Bid more/);
    expect(r.rosters.B).toContainEqual({ playerId: 'p1', slot: 'BN' });
    expect(r.priorityOrder).toEqual(['A', 'C', 'B']);
    expect(r.transactions).toEqual([
      {
        sequence: 1,
        type: 'waiver_claim',
        claimId: r.awarded[0]?.claim.claimId,
        teamId: 'B',
        addPlayerId: 'p1',
        dropPlayerId: null,
        cost: 25
      }
    ]);
  });

  it('breaks equal bids by waiver priority by default, then moves the winner to the back', () => {
    const r = resolveWaivers(settingsWith(), [claim('C', 'p1', 5), claim('B', 'p1', 5)], state());
    expect(r.awarded[0]?.claim.teamId).toBe('B');
    expect(r.priorityOrder).toEqual(['A', 'C', 'B']);
  });

  it('breaks equal bids by the earliest claim when configured', () => {
    const early = claim('C', 'p1', 5, { createdAt: '2026-10-01T00:00:00Z' });
    const late = claim('A', 'p1', 5, { createdAt: '2026-10-01T05:00:00Z' });
    const r = resolveWaivers(settingsWith({ faabTiebreak: 'earliest_claim' }), [late, early], state());
    expect(r.awarded[0]?.claim.teamId).toBe('C');
    expect(r.priorityOrder).toEqual(['A', 'B', 'C']);
  });

  it('breaks equal bids by reverse standings when configured', () => {
    const settings = settingsWith({ faabTiebreak: 'reverse_standings' });
    const claims = [claim('A', 'p1', 5), claim('C', 'p1', 5)];
    const r = resolveWaivers(settings, claims, state({ reverseStandings: ['C', 'B', 'A'] }));
    expect(r.awarded[0]?.claim.teamId).toBe('C');
    // Without standings it falls back to the priority list.
    expect(resolveWaivers(settings, claims, state()).awarded[0]?.claim.teamId).toBe('A');
  });

  it('falls back to the claim ID when every tiebreak is equal', () => {
    const settings = settingsWith({ faabTiebreak: 'earliest_claim' });
    const at = '2026-10-01T00:00:00Z';
    const x = { ...claim('B', 'p1', 5, { createdAt: at }), claimId: 'x' };
    const w = { ...claim('C', 'p1', 5, { createdAt: at }), claimId: 'w' };
    expect(resolveWaivers(settings, [x, w], state()).awarded[0]?.claim.claimId).toBe('w');
  });

  it("handles a team's claims in its own priority order and fails a claim whose drop is gone", () => {
    const full = state({
      teams: {
        A: { roster: bench('a1', 'a2', 'a3'), faabRemaining: 100 },
        B: { roster: bench('b1'), faabRemaining: 100 }
      },
      priorityOrder: ['A', 'B']
    });
    const r = resolveWaivers(
      settingsWith(),
      [
        claim('A', 'p2', 30, { priority: 2, dropPlayerId: 'a1' }),
        claim('A', 'p1', 5, { priority: 1, dropPlayerId: 'a1' })
      ],
      full
    );
    expect(r.awarded.map((a) => a.claim.addPlayerId)).toEqual(['p1']);
    expect(codes(r)).toEqual(['DROP_PLAYER_NOT_ON_ROSTER']);
    expect(r.rosters.A?.map((e) => e.playerId)).toEqual(['a2', 'a3', 'p1']);
  });

  it('lets a lower-ranked claim win a player once the team moves past its first choice', () => {
    // B ranks p2 first; A bids low on p1. B wins p2 first (higher bid), then outbids A for p1.
    const r = resolveWaivers(
      settingsWith(),
      [claim('A', 'p1', 3), claim('B', 'p2', 40, { priority: 1 }), claim('B', 'p1', 10, { priority: 2 })],
      state()
    );
    expect(r.awarded.map((a) => `${a.claim.teamId}:${a.claim.addPlayerId}`)).toEqual(['B:p2', 'B:p1']);
    expect(codes(r)).toEqual(['PLAYER_CLAIMED']);
  });

  it('fails a bid that exceeds the budget left after an earlier win', () => {
    const r = resolveWaivers(
      settingsWith(),
      [claim('A', 'p1', 60, { priority: 1 }), claim('A', 'p2', 50, { priority: 2 })],
      state()
    );
    expect(r.budgets.A).toBe(40);
    expect(r.failed[0]?.issue).toMatchObject({
      code: 'BID_EXCEEDS_BUDGET',
      details: { bid: 50, remaining: 40 }
    });
    expect(r.failed[0]?.issue.fix).toBe('Bid $40 or less.');
  });

  it('fails a claim that would overfill the roster, and an IR drop does not free a spot', () => {
    const s = state({
      teams: {
        A: {
          roster: [...bench('a1', 'a2', 'a3'), { playerId: 'air', slot: 'IR' }],
          faabRemaining: 100
        }
      },
      priorityOrder: ['A']
    });
    const r = resolveWaivers(
      settingsWith(),
      [claim('A', 'p1', 1, { priority: 1 }), claim('A', 'p2', 1, { priority: 2, dropPlayerId: 'air' })],
      s
    );
    expect(codes(r)).toEqual(['ROSTER_FULL', 'ROSTER_FULL']);
    expect(r.failed[0]?.issue.fix).toMatch(/dropPlayerId to one of: a1, a2, a3/);
  });

  it('rejects $0 bids when the league disallows them, and malformed bids always', () => {
    const r = resolveWaivers(
      settingsWith({ allowZeroBids: false }),
      [claim('A', 'p1', 0), claim('B', 'p1', 2.5), claim('C', 'p1', -1)],
      state()
    );
    expect(codes(r).sort()).toEqual(['INVALID_BID', 'INVALID_BID', 'ZERO_BID_NOT_ALLOWED']);
    expect(r.awarded).toEqual([]);
  });

  it('awards a $0 bid when allowed', () => {
    const r = resolveWaivers(settingsWith(), [claim('A', 'p1', 0)], state());
    expect(r.awarded[0]?.cost).toBe(0);
  });

  it('fails claims for unavailable players, unknown teams, and teams at the weekly add limit', () => {
    const s = state();
    const limited = {
      ...s,
      teams: { ...s.teams, C: { roster: bench('c1'), faabRemaining: 100, acquisitionsThisWeek: 1 } }
    };
    const r = resolveWaivers(
      settingsWith({ maxAcquisitionsPerWeek: 1 }),
      [claim('A', 'b1', 5), claim('Z', 'p1', 5), claim('C', 'p2', 5), claim('B', 'p3', 5, { priority: 1 })],
      limited
    );
    expect(codes(r).sort()).toEqual(['ACQUISITION_LIMIT_REACHED', 'PLAYER_UNAVAILABLE', 'UNKNOWN_TEAM']);
    expect(r.awarded.map((a) => a.claim.teamId)).toEqual(['B']);
  });

  it('appends teams missing from the priority list', () => {
    const r = resolveWaivers(settingsWith(), [], state({ priorityOrder: ['B'] }));
    expect(r.priorityOrder).toEqual(['B', 'A', 'C']);
    expect(r.awarded).toEqual([]);
  });
});

describe('resolveWaivers (rolling priority)', () => {
  it('gives each player to the team highest on the list, ignores bids, and moves winners to the back', () => {
    const settings = settingsWith({ type: 'rolling' });
    const r = resolveWaivers(
      settings,
      [
        claim('C', 'p1', 99),
        claim('B', 'p1', 0),
        claim('B', 'p2', 0, { priority: 2 }),
        claim('C', 'p2', 0, { priority: 2 })
      ],
      state({ priorityOrder: ['B', 'C', 'A'] })
    );
    expect(r.awarded.map((a) => `${a.claim.teamId}:${a.claim.addPlayerId}`)).toEqual(['B:p1', 'C:p2']);
    expect(r.budgets).toEqual({ A: 100, B: 100, C: 100 });
    expect(r.priorityOrder).toEqual(['A', 'B', 'C']);
    // C's p1 loses to B; B's p2 loses to C, which moved ahead of B after B won p1.
    expect(r.failed.map((f) => `${f.claim.teamId}:${f.claim.addPlayerId}`).sort()).toEqual(['B:p2', 'C:p1']);
    expect(r.failed[0]?.issue.fix).toBe('Rank this claim higher next time, or target another player.');
  });

  it('does not check bids or budgets', () => {
    const r = resolveWaivers(
      settingsWith({ type: 'rolling', allowZeroBids: false }),
      [claim('A', 'p1', 500)],
      state()
    );
    expect(r.awarded).toHaveLength(1);
  });
});
