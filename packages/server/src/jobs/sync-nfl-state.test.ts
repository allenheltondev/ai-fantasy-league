import { describe, expect, it } from 'vitest';
import { createTestJobDeps, nflState, StubProvider } from '../../test/support/jobs.js';
import { syncNflState } from './sync-nfl-state.js';

function setup() {
  const provider = new StubProvider();
  const deps = createTestJobDeps({ provider });
  return { provider, deps };
}

const rollovers = (deps: ReturnType<typeof setup>['deps']) =>
  deps.events.events.filter((e) => e.detailType === 'Week Rolled Over');

describe('syncNflState', () => {
  it('stores the first observation without announcing a rollover', async () => {
    const { provider, deps } = setup();
    provider.state = nflState({ week: 3 });
    expect(await syncNflState(deps, deps.clock)).toMatchObject({ status: 'ok', week: 3, rolledOver: false });
    expect(await deps.reference.nflState.get()).toMatchObject({
      season: 2025,
      week: 3,
      updatedAt: '2025-09-04T12:00:00.000Z'
    });
    expect(deps.events.events).toEqual([]);
  });

  it('emits Week Rolled Over exactly once per rollover', async () => {
    const { provider, deps } = setup();
    provider.state = nflState({ week: 3 });
    await syncNflState(deps, deps.clock);
    await syncNflState(deps, deps.clock);
    expect(rollovers(deps)).toHaveLength(0);

    provider.state = nflState({ week: 4, displayWeek: 4 });
    deps.clock.advance(15 * 60_000);
    expect(await syncNflState(deps, deps.clock)).toMatchObject({ rolledOver: true, week: 4 });
    await syncNflState(deps, deps.clock);
    await syncNflState(deps, deps.clock);

    expect(rollovers(deps)).toEqual([
      {
        source: 'fantasy',
        detailType: 'Week Rolled Over',
        detail: {
          season: 2025,
          seasonType: 'regular',
          week: 4,
          kind: 'week',
          from: { season: 2025, seasonType: 'regular', week: 3 },
          to: { season: 2025, seasonType: 'regular', week: 4 },
          rolledOverAt: '2025-09-04T12:15:00.000Z'
        }
      }
    ]);
  });

  it('announces season-type and season changes but not backwards glitches', async () => {
    const { provider, deps } = setup();
    provider.state = nflState({ seasonType: 'pre', week: 2 });
    await syncNflState(deps, deps.clock);
    provider.state = nflState({ week: 1 });
    await syncNflState(deps, deps.clock);
    provider.state = nflState({ seasonType: 'pre', week: 3 });
    await syncNflState(deps, deps.clock);
    provider.state = nflState({ season: 2026, leagueSeason: 2026, seasonType: 'pre', week: 0 });
    await syncNflState(deps, deps.clock);
    expect(rollovers(deps).map((e) => e.detail.kind)).toEqual(['season_type', 'season']);
  });

  it('stays quiet when another run changed the state first', async () => {
    const { provider, deps } = setup();
    provider.state = nflState({ week: 3 });
    await syncNflState(deps, deps.clock);
    provider.state = nflState({ week: 4 });
    // Another invocation wins the race between this run's read and its conditional write.
    const repo = deps.reference.nflState;
    const racing = {
      get: () => repo.get(),
      put: async (...args: Parameters<typeof repo.put>) => {
        await repo.put({ ...nflState({ week: 4 }), updatedAt: 'other' }, nflState({ week: 3 }));
        return repo.put(...args);
      }
    };
    const result = await syncNflState(
      { ...deps, reference: { ...deps.reference, nflState: racing } },
      deps.clock
    );
    expect(result).toEqual({ status: 'skipped', reason: 'concurrent_update' });
    expect(rollovers(deps)).toEqual([]);
  });
});
