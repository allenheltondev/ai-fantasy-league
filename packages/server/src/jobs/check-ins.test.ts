import { FixedClock } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { league } from '../../test/support/harness.js';
import { createTestJobDeps } from '../../test/support/jobs.js';
import { EVENT_DETAIL_SCHEMAS } from '../events/details.js';
import type { LeaguePhase } from '../repos/types.js';
import { managerCheckIns } from './check-ins.js';
import { runJob } from './lambda.js';

// 2 PM in New York (daylight time).
const AFTERNOON = '2026-09-29T18:00:00.000Z';

async function world(at = AFTERNOON) {
  const deps = createTestJobDeps({ clock: new FixedClock(at) });
  const add = async (id: string, phase: LeaguePhase, agents: boolean) => {
    await deps.repos.leagues.create(league({ id, phase, week: phase === 'setup' ? null : 4 }));
    if (agents) {
      await deps.repos.agents.putSeat({
        leagueId: id,
        teamId: 'team-2',
        agentId: `${id}.team-2`,
        config: { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' },
        version: 1,
        updatedAt: at,
        updatedBy: 'user#user-123'
      });
    }
  };
  await add('lg-season', 'regular_season', true);
  await add('lg-playoffs', 'playoffs', true);
  await add('lg-people', 'regular_season', false);
  await add('lg-setup', 'setup', true);
  await add('lg-drafting', 'drafting', true);
  await add('lg-done', 'complete', true);
  const published = () => deps.events.events.filter((e) => e.detailType === 'Manager Check-In');
  return { deps, published };
}

describe('managerCheckIns', () => {
  it('publishes one check-in per drafted, unfinished league with agents, keyed by date and slot', async () => {
    const { deps, published } = await world();
    const result = await managerCheckIns(deps, deps.clock);
    expect(result).toEqual({
      status: 'ok',
      slot: 'afternoon',
      date: '2026-09-29',
      leagues: 3,
      published: 2,
      failed: 0
    });
    expect(
      published()
        .map((e) => (e.detail as { leagueId: string }).leagueId)
        .sort()
    ).toEqual(['lg-playoffs', 'lg-season']);
    const detail = published()[0]?.detail;
    expect(detail).toEqual({
      leagueId: expect.any(String),
      slot: 'afternoon',
      date: '2026-09-29',
      at: AFTERNOON,
      nextAt: '2026-09-30T00:00:00.000Z',
      week: 4
    });
    expect(EVENT_DETAIL_SCHEMAS['Manager Check-In'].safeParse(detail).success).toBe(true);
  });

  it('names the slot by the latest scheduled check-in, even when the run is late', async () => {
    // 1 AM in New York is still the evening before; 10:30 AM is the morning.
    const late = await world('2026-09-30T05:00:00.000Z');
    expect(await managerCheckIns(late.deps, late.deps.clock)).toMatchObject({
      slot: 'evening',
      date: '2026-09-29'
    });
    const morning = await world('2026-09-30T14:30:00.000Z');
    expect(await managerCheckIns(morning.deps, morning.deps.clock)).toMatchObject({
      slot: 'morning',
      date: '2026-09-30'
    });
  });

  it('publishes nothing while the agent kill switch is on', async () => {
    const { deps, published } = await world();
    const result = await managerCheckIns(
      { ...deps, agentKillSwitch: { engaged: async () => true } },
      deps.clock
    );
    expect(result).toEqual({ status: 'skipped', reason: 'kill_switch', slot: 'afternoon' });
    expect(published()).toEqual([]);
    expect(
      await managerCheckIns({ ...deps, agentKillSwitch: { engaged: async () => false } }, deps.clock)
    ).toMatchObject({ published: 2 });
  });

  it('finishes the other leagues when one fails, then fails the run (and records it)', async () => {
    const { deps, published } = await world();
    const listSeats = deps.repos.agents.listSeats.bind(deps.repos.agents);
    deps.repos.agents.listSeats = async (leagueId) => {
      if (leagueId === 'lg-playoffs') throw new Error('table unavailable');
      return listSeats(leagueId);
    };
    await expect(runJob({ job: 'managerCheckIns' }, deps, deps.clock)).rejects.toThrow(
      /managerCheckIns: 1 failed/
    );
    expect(published().map((e) => (e.detail as { leagueId: string }).leagueId)).toEqual(['lg-season']);
    expect((await deps.reference.jobRuns.list(['managerCheckIns']))[0]).toMatchObject({
      latest: { status: 'failed' }
    });
  });
});
