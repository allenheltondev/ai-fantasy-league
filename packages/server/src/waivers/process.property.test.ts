import { yahooDefaultSettings } from '@fantasy/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { newTeam } from '../league/seats.js';
import { silentLogger } from '../log.js';
import { createInMemoryRepos } from '../repos/memory.js';
import { createInMemoryReferenceStore } from '../repos/memory-reference.js';
import type { League } from '../repos/types.js';
import type { WaiverClaimRecord } from '../repos/waivers.js';
import { processLeagueWaivers } from './process.js';

/**
 * Invariants of waiver processing over random leagues and claims (bids over budget, drops that are
 * gone, rostered targets, duplicate targets): FAAB is conserved (spent = sum of winning bids) and
 * never negative, no player ends up on two rosters, no roster goes over the limit, and a second run
 * in the same window changes nothing.
 */

const NOW = new Date('2026-10-07T08:00:00.000Z');
const POOL = Array.from({ length: 10 }, (_, i) => `p${i}`);

const scenario = fc.record({
  teamCount: fc.integer({ min: 2, max: 4 }),
  owners: fc.array(fc.integer({ min: -1, max: 3 }), { minLength: POOL.length, maxLength: POOL.length }),
  budgets: fc.array(fc.integer({ min: 0, max: 20 }), { minLength: 4, maxLength: 4 }),
  type: fc.constantFrom('faab' as const, 'rolling' as const),
  claims: fc.array(
    fc.record({
      team: fc.integer({ min: 0, max: 3 }),
      player: fc.constantFrom(...POOL),
      drop: fc.option(fc.constantFrom(...POOL), { nil: null }),
      bid: fc.integer({ min: 0, max: 25 }),
      priority: fc.integer({ min: 1, max: 3 })
    }),
    { maxLength: 12 }
  )
});

describe('processLeagueWaivers invariants', () => {
  it('conserves FAAB, never goes negative, and never puts a player on two rosters', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ teamCount, owners, budgets, type, claims }) => {
        const repos = createInMemoryRepos();
        const settings = yahooDefaultSettings(teamCount);
        settings.roster.slots = { QB: 1, RB: 1, BN: 1 };
        settings.waivers.type = type;
        const league: League = {
          id: 'lg',
          name: 'Prop',
          season: 2026,
          phase: 'regular_season',
          week: 5,
          settings,
          commissionerId: 'u',
          commissionerName: 'U',
          createdBy: 'u',
          scheduleSeed: 's',
          deadlines: {
            draftStartsAt: null,
            nextLineupLockAt: null,
            nextWaiverRunAt: null,
            tradeDeadlineAt: null
          },
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          version: 1
        };
        await repos.leagues.create(league);
        const teams = Array.from({ length: teamCount }, (_, i) => {
          const roster = POOL.filter((_, p) => owners[p] === i).slice(0, 3);
          return {
            ...newTeam({ leagueId: 'lg', id: `t${i}`, draftSlot: i + 1, settings, now: NOW }),
            roster,
            faabRemaining: budgets[i] ?? 0
          };
        });
        await repos.teams.create(teams);
        for (const player of POOL) {
          await repos.waivers.putWireEntry({
            leagueId: 'lg',
            playerId: player,
            droppedByTeamId: 't0',
            droppedAt: '2026-10-04T08:00:00.000Z',
            clearsAt: '2026-10-06T08:00:00.000Z'
          });
        }
        for (const [i, c] of claims.entries()) {
          const record: WaiverClaimRecord = {
            id: `c${String(i).padStart(2, '0')}`,
            leagueId: 'lg',
            teamId: `t${c.team % teamCount}`,
            addPlayerId: c.player,
            dropPlayerId: c.drop,
            bid: c.bid,
            priority: c.priority,
            status: 'pending',
            week: 5,
            processesAt: NOW.toISOString(),
            createdAt: `2026-10-05T00:00:${String(i).padStart(2, '0')}.000Z`,
            createdBy: 'test',
            resolvedAt: null,
            failure: null,
            cost: null,
            awardingRunId: null,
            version: 1
          };
          await repos.waivers.createClaim(record);
        }
        const before = teams.reduce((sum, t) => sum + t.faabRemaining, 0);
        const deps = {
          repos,
          reference: createInMemoryReferenceStore(repos.players),
          events: new InMemoryEventPublisher(),
          log: silentLogger
        };
        await processLeagueWaivers(deps, league, NOW);

        const after = await repos.teams.list('lg');
        const awarded = (await repos.waivers.listClaims('lg', 'awarded')).reduce(
          (sum, c) => sum + (c.cost ?? 0),
          0
        );
        expect(after.reduce((sum, t) => sum + t.faabRemaining, 0) + awarded).toBe(before);
        if (type === 'rolling') expect(awarded).toBe(0);
        for (const t of after) {
          expect(t.faabRemaining).toBeGreaterThanOrEqual(0);
          expect(t.roster.length).toBeLessThanOrEqual(3);
        }
        const rostered = after.flatMap((t) => t.roster);
        expect(new Set(rostered).size).toBe(rostered.length);
        for (const t of after) {
          for (const p of t.roster) {
            const owner = await repos.waivers.playerOwner('lg', p);
            expect(owner === null || owner === t.id).toBe(true);
          }
        }
        expect(await repos.waivers.listClaims('lg', 'pending')).toEqual([]);

        const again = await processLeagueWaivers(deps, league, NOW);
        expect(again.status).toBe('already_processed');
        expect(await repos.teams.list('lg')).toEqual(after);
      }),
      { numRuns: 60 }
    );
  });
});
