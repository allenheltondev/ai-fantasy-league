import { FixtureDataProvider } from '@fantasy/data';
import { describe, expect, it } from 'vitest';
import { createTestJobDeps, nflState } from '../../test/support/jobs.js';
import { syncSchedule } from './sync-schedule.js';

describe('syncSchedule', () => {
  it('stores the season schedule by week and the bye weeks', async () => {
    const deps = createTestJobDeps({ provider: new FixtureDataProvider() });
    const result = await syncSchedule(deps, deps.clock);
    expect(result).toMatchObject({ status: 'ok', season: 2025, teamsWithByes: 32 });
    expect(result.games).toBeGreaterThan(270);

    const week1 = await deps.reference.schedule.getWeek(2025, 1);
    expect(week1).toHaveLength(16);
    expect(week1[0]).toMatchObject({ gameId: '2025_01_DAL_PHI', kickoff: '2025-09-05T00:20:00.000Z' });
    const season = await deps.reference.schedule.getSeason(2025);
    expect(season).toMatchObject({ season: 2025, syncedAt: '2025-09-04T12:00:00.000Z' });
    expect(Object.keys(season?.byes ?? {})).toHaveLength(32);
  });

  it('uses the stored NFL state’s league season when there is one', async () => {
    const deps = createTestJobDeps({ provider: new FixtureDataProvider() });
    await deps.reference.nflState.put({ ...nflState({ leagueSeason: 2025 }), updatedAt: 'x' }, null);
    expect(await syncSchedule(deps, deps.clock)).toMatchObject({ season: 2025 });
    expect(await deps.reference.schedule.getSeason(2024)).toBeNull();
  });
});
