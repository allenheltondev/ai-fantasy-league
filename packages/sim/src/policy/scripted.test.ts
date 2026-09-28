import { createDraft, yahooDefaultSettings, type RosterPlayer } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { draftRankings, scriptedPolicy } from './scripted.js';
import type { DraftContext, FreeAgent, WaiverContext } from './types.js';

const settings = yahooDefaultSettings(8);
const rp = (playerId: string, position: RosterPlayer['positions'][number], nflTeam = 'KC'): RosterPlayer => ({
  playerId,
  positions: [position],
  status: 'active',
  nflTeam
});

function draftContext(teamId = 'a'): DraftContext {
  const draft = createDraft({ teamIds: ['a', 'b'], rounds: 16, pickSeconds: 60 });
  if (!draft.ok) throw new Error('draft');
  return {
    teamId,
    settings,
    draft: draft.value,
    available: [
      { playerId: 'qb1', positions: ['QB'] },
      { playerId: 'rb1', positions: ['RB'] },
      { playerId: 'k1', positions: ['K'] },
      { playerId: 'none', positions: ['WR'] }
    ],
    projections: { qb1: 20, rb1: 18, k1: 8 },
    seed: 's'
  };
}

describe('scriptedPolicy draft', () => {
  it('ranks by projection with bounded, deterministic per-team jitter', () => {
    expect(draftRankings(draftContext(), 0)).toEqual(['qb1', 'rb1', 'k1']);
    const a = draftRankings(draftContext('a'), 0.15);
    expect(draftRankings(draftContext('a'), 0.15)).toEqual(a);
    expect(a).not.toContain('none');
    expect(a[a.length - 1]).toBe('k1');
  });

  it('picks with core autopick', () => {
    expect(scriptedPolicy({ draftJitter: 0 }).draftPick(draftContext())).toBe('qb1');
    const empty = { ...draftContext(), available: [] };
    expect(scriptedPolicy().draftPick(empty)).toBeNull();
  });
});

describe('scriptedPolicy lineup', () => {
  it('starts the best projected eligible players via the optimizer', async () => {
    const roster = [rp('q1', 'QB'), rp('q2', 'QB')];
    const lineup = await scriptedPolicy().lineup({
      teamId: 'a',
      week: 1,
      now: new Date('2025-09-01T00:00:00Z'),
      settings,
      roster,
      currentLineup: [],
      games: { KC: { kickoff: '2025-09-07T17:00:00Z' } },
      projections: { q1: 10, q2: 20 }
    });
    expect(lineup.find((e) => e.playerId === 'q2')?.slot).toBe('QB');
    expect(lineup.find((e) => e.playerId === 'q1')?.slot).toBe('BN');
  });
});

describe('scriptedPolicy waivers', () => {
  const fa = (player: RosterPlayer, projection: number, value: number, trending = false): FreeAgent => ({
    player,
    projection,
    value,
    trending
  });
  function ctx(freeAgents: FreeAgent[], faab = 100): WaiverContext {
    const roster = [rp('wr-weak', 'WR'), rp('wr-ok', 'WR'), rp('k', 'K')];
    const projections: Record<string, number> = { 'wr-weak': 2, 'wr-ok': 12, k: 8 };
    const values: Record<string, number> = { 'wr-weak': 3, 'wr-ok': 12, k: 8 };
    for (const f of freeAgents) {
      projections[f.player.playerId] = f.projection;
      values[f.player.playerId] = f.value;
    }
    return {
      teamId: 'a',
      week: 3,
      now: new Date('2025-09-17T06:00:00Z'),
      settings,
      roster,
      faabRemaining: faab,
      freeAgents,
      trending: [],
      projections,
      values
    };
  }

  it('bids on trending or high-projection free agents who beat the weakest player at their position', () => {
    const claims = scriptedPolicy().waiverClaims(
      ctx([fa(rp('wr-hot', 'WR'), 11, 9), fa(rp('wr-trend', 'WR'), 6, 6, true), fa(rp('wr-meh', 'WR'), 4, 4)])
    );
    // wr-hot: blended 10 vs wr-weak 2.5 → gain 7.5 → $15; wr-trend: 6 vs wr-ok 12 → no gain.
    expect(claims).toEqual([{ addPlayerId: 'wr-hot', dropPlayerId: 'wr-weak', bid: 15 }]);
  });

  it('adds a trending bonus, stays within the budget, and caps the number of claims', () => {
    const claims = scriptedPolicy({ maxClaims: 1 }).waiverClaims(
      ctx([fa(rp('wr-trend', 'WR'), 9, 9, true), fa(rp('wr-hot', 'WR'), 20, 20)], 10)
    );
    expect(claims).toEqual([{ addPlayerId: 'wr-hot', dropPlayerId: 'wr-weak', bid: 10 }]);
    const both = scriptedPolicy().waiverClaims(ctx([fa(rp('wr-trend', 'WR'), 9, 9, true)]));
    expect(both).toEqual([
      { addPlayerId: 'wr-trend', dropPlayerId: 'wr-weak', bid: Math.floor(6.5 * 2) + 3 }
    ]);
  });

  it('never bids on a position it has no one to drop at, or on players with no projection', () => {
    expect(scriptedPolicy().waiverClaims(ctx([fa(rp('te', 'TE'), 15, 15)]))).toEqual([]);
    expect(scriptedPolicy().waiverClaims(ctx([fa(rp('wr-x', 'WR'), 0, 30, true)]))).toEqual([]);
  });
});
