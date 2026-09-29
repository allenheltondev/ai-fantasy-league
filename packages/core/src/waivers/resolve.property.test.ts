import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { openRosterSpots, type LineupEntry } from '../rules/lineup.js';
import { yahooDefaultSettings, type LeagueSettings } from '../rules/settings.js';
import { resolveWaivers, reverseStandingsOrder, type WaiverClaim, type WaiverState } from './resolve.js';

const base = yahooDefaultSettings(6);
const PLAYERS = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];

interface Scenario {
  settings: LeagueSettings;
  state: WaiverState;
  claims: WaiverClaim[];
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    teamCount: fc.integer({ min: 2, max: 5 }),
    type: fc.constantFrom('faab' as const, 'rolling' as const),
    tiebreak: fc.constantFrom(
      'waiver_priority' as const,
      'reverse_standings' as const,
      'earliest_claim' as const
    ),
    allowZeroBids: fc.boolean(),
    rosterSizes: fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 5, maxLength: 5 }),
    budgets: fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 5, maxLength: 5 }),
    rawClaims: fc.array(
      fc.record({
        team: fc.integer({ min: 0, max: 5 }),
        player: fc.constantFrom(...PLAYERS, 't0_0', 't1_1'),
        drop: fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }),
        bid: fc.integer({ min: 0, max: 50 }),
        priority: fc.integer({ min: 1, max: 4 }),
        minute: fc.integer({ min: 0, max: 59 })
      }),
      { maxLength: 20 }
    )
  })
  .map(({ teamCount, type, tiebreak, allowZeroBids, rosterSizes, budgets, rawClaims }) => {
    const settings: LeagueSettings = {
      ...base,
      roster: { ...base.roster, slots: { QB: 1, BN: 2, IR: 1 } },
      waivers: { ...base.waivers, type, faabTiebreak: tiebreak, allowZeroBids }
    };
    const teamIds = Array.from({ length: teamCount }, (_, i) => `T${i}`);
    const teams: WaiverState['teams'] = Object.fromEntries(
      teamIds.map((t, i) => {
        const size = rosterSizes[i] ?? 0;
        const roster: LineupEntry[] = Array.from({ length: size }, (_, j) => ({
          playerId: `t${i}_${j}`,
          slot: j === 3 ? 'IR' : 'BN'
        }));
        return [t, { roster, faabRemaining: budgets[i] ?? 0 }];
      })
    );
    const claims = rawClaims.map((c, k) => ({
      claimId: `c${k}`,
      teamId: `T${c.team}`,
      addPlayerId: c.player,
      dropPlayerId: c.drop === undefined ? null : `t${c.team}_${c.drop}`,
      bid: c.bid,
      priority: c.priority,
      createdAt: `2026-10-01T00:${String(c.minute).padStart(2, '0')}:00Z`
    }));
    return {
      settings,
      state: {
        teams,
        priorityOrder: [...teamIds].reverse(),
        availablePlayerIds: PLAYERS,
        reverseStandings: teamIds
      },
      claims
    };
  });

describe('waiver resolution properties', () => {
  it('conserves FAAB, never double-awards, never overspends, and never overfills a roster', () => {
    fc.assert(
      fc.property(scenarioArb, ({ settings, state, claims }) => {
        const r = resolveWaivers(settings, claims, state);

        // Every claim is decided exactly once.
        const decided = [...r.awarded.map((a) => a.claim.claimId), ...r.failed.map((f) => f.claim.claimId)];
        expect(decided.sort()).toEqual(claims.map((c) => c.claimId).sort());

        // No player is awarded twice, and only available players are awarded.
        const players = r.awarded.map((a) => a.claim.addPlayerId);
        expect(new Set(players).size).toBe(players.length);
        for (const p of players) expect(state.availablePlayerIds).toContain(p);

        // FAAB spent equals the sum of winning bids; no budget goes negative.
        const before = Object.values(state.teams).reduce((s, t) => s + t.faabRemaining, 0);
        const after = Object.values(r.budgets).reduce((s, b) => s + b, 0);
        const spent = r.awarded.reduce((s, a) => s + a.cost, 0);
        expect(before - after).toBe(spent);
        if (settings.waivers.type === 'faab') {
          expect(spent).toBe(r.awarded.reduce((s, a) => s + a.claim.bid, 0));
        } else {
          expect(spent).toBe(0);
        }
        for (const b of Object.values(r.budgets)) expect(b).toBeGreaterThanOrEqual(0);

        // Rosters never exceed the active limit (every generated roster starts within it).
        for (const roster of Object.values(r.rosters)) {
          expect(openRosterSpots(settings, roster)).toBeGreaterThanOrEqual(0);
          const ids = roster.map((e) => e.playerId);
          expect(new Set(ids).size).toBe(ids.length);
        }

        // The priority list stays a permutation of the teams.
        expect([...r.priorityOrder].sort()).toEqual(Object.keys(state.teams).sort());
        expect(r.transactions).toHaveLength(r.awarded.length);
      })
    );
  });

  it('reverseStandingsOrder lists every team once, worst record first', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'), { minLength: 1 }),
        fc.array(
          fc.record({ team: fc.constantFrom('a', 'b', 'c', 'x'), rank: fc.integer({ min: 1, max: 8 }) })
        ),
        (teamIds, raw) => {
          const rows = raw.map((r) => ({ teamId: r.team, rank: r.rank }));
          const order = reverseStandingsOrder(rows, teamIds);
          expect([...order].sort()).toEqual([...teamIds].sort());
          const worst = new Map<string, number>();
          for (const r of rows) worst.set(r.teamId, Math.max(worst.get(r.teamId) ?? 0, r.rank));
          const ranked = order.filter((id) => worst.has(id));
          expect(order.slice(0, ranked.length)).toEqual(ranked);
          for (let i = 1; i < ranked.length; i++) {
            expect(worst.get(ranked[i - 1] as string)).toBeGreaterThanOrEqual(
              worst.get(ranked[i] as string) ?? 0
            );
          }
          expect(order.slice(ranked.length)).toEqual(teamIds.filter((id) => !worst.has(id)));
        }
      )
    );
  });

  it('under the reverse_standings tiebreak, a tied bid goes to the worse team', () => {
    const settings = {
      ...base,
      waivers: { ...base.waivers, type: 'faab' as const, faabTiebreak: 'reverse_standings' as const }
    };
    const team = { roster: [], faabRemaining: 50 };
    const claim = (teamId: string) => ({
      claimId: `c-${teamId}`,
      teamId,
      addPlayerId: 'p0',
      bid: 10,
      priority: 1,
      createdAt: '2026-10-01T00:00:00Z'
    });
    const r = resolveWaivers(settings, [claim('A'), claim('B')], {
      teams: { A: team, B: team },
      priorityOrder: ['A', 'B'],
      availablePlayerIds: ['p0'],
      reverseStandings: reverseStandingsOrder(
        [
          { teamId: 'A', rank: 1 },
          { teamId: 'B', rank: 2 }
        ],
        ['A', 'B']
      )
    });
    expect(r.awarded.map((a) => a.claim.teamId)).toEqual(['B']);
  });
});
