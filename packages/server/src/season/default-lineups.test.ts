import { isStarterSlot } from '@fantasy/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../../test/support/harness.js';
import { ALICE, BOB } from '../../test/support/leagues.js';
import { SEASON, seedNflSchedule, seedSeasonLeague, TEAM1_ROSTER } from '../../test/support/season.js';
import { setDefaultLineups } from './lineups.js';

/**
 * Default lineups after the draft (#176): every human team without a lineup gets the optimizer's,
 * by projection or, with none stored, by consensus rank. Agent seats and existing lineups are left
 * alone. team-1 is Alice's, team-3 Bob's; team-2 and team-4 are agent seats.
 */

let h: Harness;
afterEach(() => h.close());

async function seed(id: string) {
  h = await createHarness();
  const deps = { repos: h.repos, reference: h.services.data.reference };
  await seedNflSchedule(deps.reference);
  const { league } = await seedSeasonLeague(deps, { id, owners: [ALICE, null, BOB], lineup: false });
  const bob = (await h.repos.teams.get(id, 'team-3'))!;
  await h.repos.teams.update({ ...bob, roster: ['fx-swift', 'fx-jamesonw'] });
  return { deps, league };
}

const starters = async (leagueId: string, teamId: string) =>
  ((await h.repos.lineups.get(leagueId, teamId, 1))?.entries ?? [])
    .filter((e) => isStarterSlot(e.slot))
    .map((e) => `${e.slot}:${e.playerId}`)
    .sort();

describe('setDefaultLineups', () => {
  it('starts each human team by consensus rank when there are no projections, never an agent seat', async () => {
    const { deps, league } = await seed('lg-default-rank');
    expect(await setDefaultLineups(deps, league, h.clock.now())).toEqual(['team-1', 'team-3']);
    const alice = await starters(league.id, 'team-1');
    // Every starting slot filled; Walker's Seahawks are on bye, so he sits.
    expect(alice).toHaveLength(10);
    expect(alice).not.toContain('W/R/T:fx-kwalker');
    expect(alice.filter((s) => s.startsWith('QB:'))).toEqual(['QB:fx-jallen']);
    expect((await h.repos.lineups.get(league.id, 'team-1', 1))?.entries).toHaveLength(TEAM1_ROSTER.length);
    // Swift's Bears have no game this week.
    expect(await starters(league.id, 'team-3')).toEqual(['WR:fx-jamesonw']);
    expect(await h.repos.lineups.get(league.id, 'team-2', 1)).toBeNull();
  });

  it('follows projections when they are stored, and never overwrites a lineup', async () => {
    const { deps, league } = await seed('lg-default-proj');
    await deps.reference.projections.putSnapshot(
      { season: SEASON, week: 1, capturedAt: '2026-09-09T12:00:00.000Z', hash: 'd', count: 2 },
      [
        { playerId: 'fx-mahomes', season: SEASON, week: 1, stats: { pass_yd: 400 } },
        { playerId: 'fx-jallen', season: SEASON, week: 1, stats: { pass_yd: 100 } }
      ]
    );
    const mine = [{ playerId: 'fx-swift', slot: 'RB' as const }];
    await h.repos.lineups.put([
      { leagueId: league.id, teamId: 'team-3', week: 1, entries: mine, updatedAt: '', updatedBy: 'user#bob' }
    ]);
    expect(await setDefaultLineups(deps, league, h.clock.now())).toEqual(['team-1']);
    expect(await starters(league.id, 'team-1')).toContain('QB:fx-mahomes');
    expect((await h.repos.lineups.get(league.id, 'team-3', 1))?.entries).toEqual(mine);
    // A second run changes nothing, and a league without a week has nothing to set.
    expect(await setDefaultLineups(deps, league, h.clock.now())).toEqual([]);
    expect(await setDefaultLineups(deps, { ...league, week: null }, h.clock.now())).toEqual([]);
  });
});
