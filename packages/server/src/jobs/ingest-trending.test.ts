import { describe, expect, it } from 'vitest';
import { createTestJobDeps, StubProvider } from '../../test/support/jobs.js';
import { ingestTrending, TRENDING_LIMIT, TRENDING_LOOKBACKS_HOURS } from './ingest-trending.js';

describe('ingestTrending', () => {
  it('caches every lookback window for adds and drops', async () => {
    const provider = new StubProvider();
    provider.trending = { add: [{ playerId: '1', count: 900 }], drop: [] };
    const deps = createTestJobDeps({ provider });

    const result = await ingestTrending(deps, deps.clock);
    expect(result).toMatchObject({
      status: 'ok',
      capturedAt: '2025-09-04T12:00:00.000Z',
      counts: { add_24h: 1, add_168h: 1, drop_72h: 0 }
    });
    expect(provider.trendingOptions).toEqual(
      [...TRENDING_LOOKBACKS_HOURS, ...TRENDING_LOOKBACKS_HOURS].map((lookbackHours) => ({
        lookbackHours,
        limit: TRENDING_LIMIT
      }))
    );

    const adds = await deps.reference.trending.latest('add', deps.clock.now());
    expect(adds?.lookbacks).toEqual({
      '24': [{ playerId: '1', count: 900 }],
      '72': [{ playerId: '1', count: 900 }],
      '168': [{ playerId: '1', count: 900 }]
    });
    expect(await deps.reference.trending.latest('add', new Date('2025-09-04T11:00:00.000Z'))).toBeNull();
    expect((await deps.reference.trending.latest('drop', deps.clock.now()))?.lookbacks['24']).toEqual([]);
  });
});
