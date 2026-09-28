import { yahooDefaultSettings } from '@fantasy/core';
import {
  createInMemoryReferenceStore,
  createInMemoryRepos,
  newTeam,
  type League,
  type Matchup,
  type Player,
  type Repos
} from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import { checkNoFutureData, checkRosters, checkStandings, checkWeekScored, teamViews } from './checks.js';

const NOW = new Date('2025-09-10T12:00:00.000Z');
const settings = yahooDefaultSettings(4);
const league: League = {
  id: 'lg',
  name: 'Checks',
  season: 2025,
  phase: 'regular_season',
  week: 1,
  settings,
  commissionerId: 'u',
  commissionerName: 'U',
  createdBy: 'u',
  scheduleSeed: 'lg',
  deadlines: { draftStartsAt: null, nextLineupLockAt: null, nextWaiverRunAt: null, tradeDeadlineAt: null },
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  version: 1
};

const player = (id: string, status: Player['status'] = 'active'): Player => ({
  id,
  name: id,
  firstName: id,
  lastName: id,
  team: 'KC',
  position: 'WR',
  status,
  injuryStatus: null,
  aliases: [],
  rank: null,
  updatedAt: NOW.toISOString()
});

async function world(rosters: Record<string, string[]>, faab: Record<string, number> = {}): Promise<Repos> {
  const ids = [...new Set(Object.values(rosters).flat())];
  const repos = createInMemoryRepos({
    players: ids.map((id) =>
      player(id, id === 'inactive' ? 'inactive' : id === 'hurt' ? 'injured_reserve' : 'active')
    )
  });
  await repos.teams.create(
    Object.entries(rosters).map(([id, roster], i) => ({
      ...newTeam({ leagueId: 'lg', id, draftSlot: i + 1, settings, now: NOW }),
      roster,
      faabRemaining: faab[id] ?? settings.waivers.faabBudget
    }))
  );
  return repos;
}

const matchup = (
  week: number,
  home: string,
  away: string,
  h: number | null,
  a: number | null,
  status: Matchup['status'] = 'final'
): Matchup => ({
  id: `W${week}-${home}`,
  leagueId: 'lg',
  week,
  kind: 'regular',
  homeTeamId: home,
  awayTeamId: away,
  homeScore: h,
  awayScore: a,
  status
});

describe('replay checks', () => {
  it('passes a clean league and puts players without a saved lineup on the bench', async () => {
    const repos = await world({ 'team-1': ['a', 'hurt'], 'team-2': ['inactive'] });
    await repos.lineups.put([
      {
        leagueId: 'lg',
        teamId: 'team-1',
        week: 1,
        entries: [{ playerId: 'a', slot: 'WR' }],
        updatedAt: NOW.toISOString(),
        updatedBy: 'system'
      }
    ]);
    expect((await teamViews(repos, league, 1)).map((t) => t.roster)).toEqual([
      [
        { playerId: 'a', slot: 'WR' },
        { playerId: 'hurt', slot: 'BN' }
      ],
      [{ playerId: 'inactive', slot: 'BN' }]
    ]);
    expect((await checkRosters(repos, league, 1)).every((c) => c.ok)).toBe(true);
  });

  it('catches shared players and FAAB that does not add up', async () => {
    const repos = await world({ 'team-1': ['a'], 'team-2': ['a'] }, { 'team-1': 90 });
    await repos.waivers.addTransactions([
      {
        id: 't1',
        leagueId: 'lg',
        at: NOW.toISOString(),
        week: 1,
        type: 'waiver_claim',
        teamId: 'team-1',
        addPlayerId: 'a',
        dropPlayerId: null,
        cost: 5,
        claimId: 'c1'
      },
      {
        id: 't2',
        leagueId: 'lg',
        at: NOW.toISOString(),
        week: 1,
        type: 'add',
        teamId: 'team-2',
        addPlayerId: null,
        dropPlayerId: null,
        cost: null,
        claimId: null
      }
    ]);
    const found = Object.fromEntries(
      (await checkRosters(repos, league, 1)).map((c) => [c.name, c.violations])
    );
    expect(found.no_shared_players).toEqual(['a is on team-1 and team-2']);
    expect(found.faab_conserved).toContain('team-1: budget 100 - spent 5 != remaining 90');
  });

  it('flags a week that went final twice or left a game unscored', async () => {
    const repos = createInMemoryRepos();
    await repos.schedule.putMatchups([
      matchup(1, 'team-1', 'team-2', 10, null),
      matchup(1, 'team-3', 'team-4', null, null, 'in_progress')
    ]);
    expect((await checkWeekScored(repos, 'lg', 1, 2)).violations).toEqual([
      'week 1 went final 2 times',
      'week 1 W1-team-1 is final (10-null)',
      'week 1 W1-team-3 is in_progress (null-null)'
    ]);
  });

  it('compares standings with the final games', async () => {
    const repos = createInMemoryRepos();
    expect((await checkStandings(repos, 'lg')).ok).toBe(true);
    await repos.schedule.putMatchups([
      matchup(1, 'team-1', 'team-2', 10, 5),
      matchup(1, 'team-3', 'team-4', 7, 7),
      matchup(2, 'team-2', 'team-1', 9, 3),
      matchup(3, 'team-1', 'team-2', 1, 2)
    ]);
    const row = (teamId: string, wins: number, losses: number, ties: number, pf: number, pa: number) => ({
      teamId,
      rank: 1,
      wins,
      losses,
      ties,
      gamesPlayed: wins + losses + ties,
      winPct: 0,
      pointsFor: pf,
      pointsAgainst: pa,
      streak: null,
      tiebreakerOverNext: null
    });
    await repos.schedule.putStandings({
      leagueId: 'lg',
      week: 2,
      computedAt: NOW.toISOString(),
      rows: [
        row('team-1', 1, 1, 0, 13, 14),
        row('team-2', 1, 1, 0, 14, 13),
        row('team-3', 0, 0, 1, 7, 7),
        row('team-4', 1, 0, 0, 7, 8),
        row('team-5', 0, 0, 0, 0, 0)
      ]
    });
    expect((await checkStandings(repos, 'lg')).violations).toEqual([
      'team-4: standings 1-0-0, matchups 0-0-1',
      'team-4: standings points 7/8, matchups 7/7'
    ]);
  });

  it('flags stats stored before their game ended, and passes on future reads', async () => {
    const reference = createInMemoryReferenceStore(createInMemoryRepos().players);
    const kickoff = Date.parse('2025-09-07T17:00:00.000Z');
    await reference.stats.putLines([
      {
        playerId: 'early',
        season: 2025,
        week: 1,
        team: 'KC',
        stats: {},
        updatedAt: '2025-09-07T18:00:00.000Z'
      },
      {
        playerId: 'late',
        season: 2025,
        week: 1,
        team: 'KC',
        stats: {},
        updatedAt: '2025-09-08T18:00:00.000Z'
      },
      {
        playerId: 'bye',
        season: 2025,
        week: 1,
        team: 'BUF',
        stats: {},
        updatedAt: '2025-09-08T18:00:00.000Z'
      },
      { playerId: 'teamless', season: 2025, week: 1, stats: {}, updatedAt: '2025-09-08T18:00:00.000Z' }
    ]);
    const found = await checkNoFutureData(reference, 2025, 1, (team) => (team === 'KC' ? kickoff : null), [
      'read x'
    ]);
    expect(found.violations).toEqual([
      'read x',
      'bye week 1 stats stored at 2025-09-08T18:00:00.000Z before his game ended',
      'early week 1 stats stored at 2025-09-07T18:00:00.000Z before his game ended',
      'teamless week 1 stats stored at 2025-09-08T18:00:00.000Z before his game ended'
    ]);
  });
});
