import { describe, expect, it } from 'vitest';
import { ALICE } from '../../test/support/leagues.js';
import {
  SEASON,
  SUNDAY_KICKOFF,
  TEAM1_LINEUP,
  THURSDAY_KICKOFF,
  seedNflSchedule,
  seedSeasonLeague
} from '../../test/support/season.js';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { silentLogger } from '../log.js';
import { fixturePlayers } from '../players/fixtures.js';
import { createInMemoryRepos } from '../repos/memory.js';
import { createInMemoryReferenceStore } from '../repos/memory-reference.js';
import { scoreWeek } from './scoring.js';

/**
 * Scoring a week after a mid-week roster change: a starter freezes at his kickoff, so he is scored
 * from the week's stored lineup even after leaving the roster, and the pickup who took his slot
 * sits on the bench for the week.
 */

async function setup() {
  const repos = createInMemoryRepos({ players: fixturePlayers });
  const reference = createInMemoryReferenceStore(repos.players);
  const deps = { repos, reference, events: new InMemoryEventPublisher(), log: silentLogger };
  await seedNflSchedule(reference);
  const { league } = await seedSeasonLeague(deps, { id: 'lg-score', owners: [ALICE] });
  const line = (playerId: string, stats: Record<string, number>) => ({
    playerId,
    season: SEASON,
    week: 1,
    stats,
    updatedAt: '2026-09-14T00:00:00.000Z'
  });
  // Kelce (KC, W/R/T) played Thursday; Lamb (DAL, bench) plays Sunday.
  await reference.stats.putLines([line('fx-kelce', { rec_yd: 50 }), line('fx-lamb', { rec_yd: 200 })]);
  return { deps, repos, league };
}

const AFTER_SUNDAY = new Date(Date.parse(SUNDAY_KICKOFF) + 6 * 3_600_000);

describe('scoreWeek with frozen starters', () => {
  it('scores a locked starter who left the roster, and benches the pickup in his slot', async () => {
    const { deps, repos, league } = await setup();
    const team = (await repos.teams.get(league.id, 'team-1'))!;
    expect((await scoreWeek(deps, league, 1, AFTER_SUNDAY)).get('team-1')?.points).toBe(5);

    // Friday: Kelce leaves the roster and the saved lineup moves Lamb into W/R/T (what set_lineup
    // writes: the frozen starter stays in the stored lineup next to the new one).
    await repos.teams.update({ ...team, roster: team.roster.filter((id) => id !== 'fx-kelce') });
    await repos.lineups.put([
      {
        leagueId: league.id,
        teamId: 'team-1',
        week: 1,
        entries: [...TEAM1_LINEUP.map((e) => ({ ...e })), { playerId: 'fx-lamb', slot: 'W/R/T' }],
        updatedAt: '2026-09-11T12:00:00.000Z',
        updatedBy: 'user#alice'
      }
    ]);
    const scores = await scoreWeek(deps, league, 1, AFTER_SUNDAY);
    expect(scores.get('team-1')?.points).toBe(5);
  });

  it('lets an unlocked starter be replaced before his kickoff', async () => {
    const { deps, repos, league } = await setup();
    const team = (await repos.teams.get(league.id, 'team-1'))!;
    await repos.teams.update({ ...team, roster: team.roster.filter((id) => id !== 'fx-kelce') });
    await repos.lineups.put([
      {
        leagueId: league.id,
        teamId: 'team-1',
        week: 1,
        entries: [
          ...TEAM1_LINEUP.filter((e) => e.playerId !== 'fx-kelce').map((e) => ({ ...e })),
          { playerId: 'fx-lamb', slot: 'W/R/T' }
        ],
        updatedAt: '2026-09-10T12:00:00.000Z',
        updatedBy: 'user#alice'
      }
    ]);
    // Before Thursday's kickoff the saved lineup is simply the new one.
    const before = await scoreWeek(deps, league, 1, new Date(Date.parse(THURSDAY_KICKOFF) - 60_000));
    expect(before.get('team-1')?.points).toBe(20);
  });
});
