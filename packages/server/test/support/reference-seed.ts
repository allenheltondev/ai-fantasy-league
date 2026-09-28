import type { ProjectionLine } from '@fantasy/data';
import type { Services } from '../../src/context.js';
import type { Repos } from '../../src/repos/types.js';
import { league } from './harness.js';

/** A league the research contract cases score projections with. */
export const RESEARCH_LEAGUE_ID = 'lg-research';

/**
 * Reference data for the research operations, as the scheduled jobs would have stored it by the
 * harness's START time (2026 week 1): NFL state, one projection snapshot, trending, and news.
 */
export async function seedReferenceData(services: Services, repos: Repos): Promise<void> {
  const ref = services.data.reference;
  await ref.nflState.put(
    {
      season: 2026,
      seasonType: 'regular',
      week: 1,
      displayWeek: 1,
      leagueSeason: 2026,
      previousSeason: 2025,
      seasonStartDate: '2026-09-10',
      updatedAt: '2026-09-10T11:00:00.000Z'
    },
    null
  );
  const line = (playerId: string, stats: Record<string, number>): ProjectionLine => ({
    playerId,
    season: 2026,
    week: 1,
    stats
  });
  const lines = [
    line('fx-cmc', { rush_att: 18, rush_yd: 85, rush_td: 0.8, rec: 5, rec_yd: 40, rec_td: 0.2 }),
    line('fx-chase', { rec_tgt: 10, rec: 7, rec_yd: 95, rec_td: 0.7 }),
    line('fx-lamb', { rec_tgt: 9, rec: 6.5, rec_yd: 80, rec_td: 0.6, rush_yd: 3 }),
    line('fx-jallen', { pass_yd: 250, pass_td: 1.9, pass_int: 0.6, rush_yd: 35, rush_td: 0.5 }),
    line('fx-butker', { fgm: 1.8, fga: 2.1, xpm: 2.6 }),
    line('fx-def-sf', { sack: 3, int: 1, fum_rec: 0.6, pts_allow: 18 }),
    line('unknown-player', { rec: 1 })
  ];
  await ref.projections.putSnapshot(
    { season: 2026, week: 1, capturedAt: '2026-09-09T12:00:00.000Z', hash: 'seed', count: lines.length },
    lines
  );
  await ref.trending.put({
    type: 'add',
    capturedAt: '2026-09-10T11:00:00.000Z',
    lookbacks: {
      '24': [
        { playerId: 'fx-swift', count: 4200 },
        { playerId: 'fx-jamesonw', count: 3100 },
        { playerId: 'unknown-player', count: 50 }
      ],
      '168': [{ playerId: 'fx-swift', count: 12000 }]
    }
  });
  await ref.news.add({
    id: 'news-1',
    url: 'https://example.com/cmc-limited',
    title: 'Christian McCaffrey limited at practice',
    source: 'Example Sports',
    publishedAt: '2026-09-10T08:00:00.000Z',
    summary: 'The 49ers running back was limited on Wednesday.',
    playerIds: ['fx-cmc'],
    teams: ['SF'],
    ingestedAt: '2026-09-10T08:05:00.000Z'
  });
  await ref.news.add({
    id: 'news-2',
    url: 'https://example.com/bills-depth',
    title: 'Bills release first depth chart',
    source: 'Example Sports',
    publishedAt: '2026-09-09T20:00:00.000Z',
    summary: null,
    playerIds: [],
    teams: ['BUF'],
    ingestedAt: '2026-09-09T20:05:00.000Z'
  });
  await repos.leagues.create(league({ id: RESEARCH_LEAGUE_ID }));
}
