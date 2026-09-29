import { FixedClock } from '@fantasy/core';
import { FixtureDataProvider, type InjuryReport } from '@fantasy/data';
import { describe, expect, it } from 'vitest';
import {
  createTestJobDeps,
  game,
  nflState,
  seedRosteredLeague,
  sourcePlayer,
  StubProvider
} from '../../test/support/jobs.js';
import { syncGameDayInjuries } from './sync-gameday-injuries.js';
import { syncPlayers } from './sync-players.js';

// Week 1 of 2025: SF at LAR on Sunday at 1pm Eastern, BAL at KC on Monday night.
const SUNDAY = '2025-09-07T17:00:00.000Z';
const MONDAY = '2025-09-09T00:15:00.000Z';
const GAMES = [
  game({ gameId: '2025_01_SF_LAR', kickoff: SUNDAY, homeTeam: 'LAR', awayTeam: 'SF' }),
  game({ gameId: '2025_01_BAL_KC', kickoff: MONDAY, homeTeam: 'KC', awayTeam: 'BAL' })
];
/** The week ends when the Monday night game does (kickoff + 4.5 hours). */
const WEEK_ENDS = '2025-09-09T04:45:00.000Z';

const PLAYERS = [
  sourcePlayer({ id: '1', name: 'Alpha One', team: 'SF', position: 'RB', espnId: 'e1' }),
  sourcePlayer({ id: '2', name: 'Bravo Two', team: 'SF', position: 'WR', injuryStatus: 'Questionable' }),
  sourcePlayer({ id: '3', name: 'Charlie Three', team: 'KC', position: 'TE', espnId: 'e3' }),
  sourcePlayer({ id: '4', name: 'Delta Four', team: 'SF', position: 'WR', espnId: 'e4' })
];

const report = (over: Partial<InjuryReport> & Pick<InjuryReport, 'name'>): InjuryReport => ({
  espnId: null,
  team: 'SF',
  position: 'WR',
  injuryStatus: 'Out',
  statusText: 'Out',
  reportedAt: null,
  comment: null,
  ...over
});

const REPORT = [
  report({ name: 'Alpha One', espnId: 'e1', position: 'RB' }),
  report({ name: 'Bravo Two', injuryStatus: 'Doubtful', statusText: 'Doubtful' }),
  report({ name: 'Charlie Three', espnId: 'e3', team: 'KC', position: 'TE' }),
  // Nobody rosters him: out of scope.
  report({ name: 'Delta Four', espnId: 'e4' })
];

async function setup(at: string) {
  const provider = new StubProvider();
  provider.players = PLAYERS;
  provider.injuries = REPORT;
  const deps = createTestJobDeps({ provider, clock: new FixedClock('2025-09-04T12:00:00.000Z') });
  await syncPlayers(deps, deps.clock);
  await deps.reference.nflState.put({ ...nflState(), updatedAt: at }, null);
  await deps.reference.schedule.putSeason(2025, GAMES, {}, new Date(at));
  await seedRosteredLeague(deps.repos, {
    leagueId: 'lg',
    week: 1,
    teams: [
      { id: 't1', owner: 'ann', roster: ['1', '2'] },
      { id: 't2', roster: ['3'] }
    ]
  });
  deps.clock.set(new Date(at));
  deps.events.events.length = 0;
  provider.calls.length = 0;
  return { deps, provider };
}

describe('syncGameDayInjuries', () => {
  it('exits cheaply outside a game day, without reading ESPN', async () => {
    const { deps, provider } = await setup('2025-09-06T20:00:00.000Z');
    expect(await syncGameDayInjuries(deps, deps.clock)).toEqual({
      status: 'skipped',
      reason: 'outside_window',
      season: 2025,
      week: 1
    });
    expect(provider.calls).toEqual([]);
    // Three hours and a minute before Sunday's first kickoff: still closed.
    deps.clock.set(new Date('2025-09-07T13:59:00.000Z'));
    expect(await syncGameDayInjuries(deps, deps.clock)).toMatchObject({ reason: 'outside_window' });
  });

  it('reads the report on game day for rostered players whose team plays that day', async () => {
    const { deps, provider } = await setup('2025-09-07T15:30:00.000Z');
    const result = await syncGameDayInjuries(deps, deps.clock);
    expect(result).toMatchObject({
      status: 'ok',
      window: 'game_day',
      inScope: 2,
      matchedById: 1,
      matchedByName: 1,
      statusChanges: 2
    });
    expect(provider.calls).toEqual(['getInjuries']);
    expect(await deps.playerRepo.get('1')).toMatchObject({
      injuryStatus: 'Out',
      statusSource: 'espn_gameday',
      statusAsOf: '2025-09-07T15:30:00.000Z',
      statusHeldUntil: WEEK_ENDS
    });
    // Charlie plays Monday and Delta is on nobody's roster: neither is touched.
    expect((await deps.playerRepo.get('3'))?.injuryStatus).toBeNull();
    expect((await deps.playerRepo.get('4'))?.injuryStatus).toBeNull();
    expect(deps.events.events.map((e) => e.detail)).toEqual([
      {
        playerId: '1',
        name: 'Alpha One',
        team: 'SF',
        position: 'RB',
        changes: [{ field: 'injuryStatus', from: null, to: 'Out' }],
        changedAt: '2025-09-07T15:30:00.000Z',
        source: 'espn_gameday'
      },
      expect.objectContaining({
        playerId: '2',
        changes: [{ field: 'injuryStatus', from: 'Questionable', to: 'Doubtful' }],
        source: 'espn_gameday'
      })
    ]);

    // The same report again changes nothing.
    deps.events.events.length = 0;
    deps.clock.advance(15 * 60_000);
    expect(await syncGameDayInjuries(deps, deps.clock)).toMatchObject({ statusChanges: 0 });
    expect(deps.events.events).toEqual([]);
  });

  it('runs once on a normal morning for every team still to play this week', async () => {
    const { deps } = await setup('2025-09-08T15:05:00.000Z');
    expect(await syncGameDayInjuries(deps, deps.clock)).toMatchObject({
      status: 'ok',
      window: 'morning',
      teams: 2,
      inScope: 1,
      statusChanges: 1
    });
    expect((await deps.playerRepo.get('3'))?.injuryStatus).toBe('Out');
    deps.clock.set(new Date('2025-09-08T15:15:00.000Z'));
    expect(await syncGameDayInjuries(deps, deps.clock)).toMatchObject({ reason: 'outside_window' });
    // After the week's last kickoff there is nothing left to read for.
    deps.clock.set(new Date('2025-09-09T15:05:00.000Z'));
    expect(await syncGameDayInjuries(deps, deps.clock)).toMatchObject({ reason: 'no_games_ahead' });
  });

  it('keeps the game-day status through a stale Sleeper sync until the week ends', async () => {
    const { deps, provider } = await setup('2025-09-07T15:30:00.000Z');
    await syncGameDayInjuries(deps, deps.clock);
    deps.events.events.length = 0;

    // Sleeper still says Alpha is healthy, but moves him on the depth chart.
    provider.players = [{ ...PLAYERS[0]!, depthChartOrder: 2 }, ...PLAYERS.slice(1)];
    deps.clock.set(new Date('2025-09-07T21:17:00.000Z'));
    expect(await syncPlayers(deps, deps.clock)).toMatchObject({ gameDayHeld: 2, statusChanges: 1 });
    expect(await deps.playerRepo.get('1')).toMatchObject({
      injuryStatus: 'Out',
      statusSource: 'espn_gameday',
      statusHeldUntil: WEEK_ENDS
    });
    expect((await deps.playerRepo.get('2'))?.injuryStatus).toBe('Doubtful');
    expect(deps.events.events.map((e) => [e.detail.playerId, e.detail.changes, e.detail.source])).toEqual([
      ['1', [{ field: 'depthChartOrder', from: 1, to: 2 }], 'sleeper']
    ]);

    // Once the week is over, Sleeper's value stands again.
    deps.events.events.length = 0;
    deps.clock.set(new Date('2025-09-09T09:17:00.000Z'));
    await syncPlayers(deps, deps.clock);
    expect(await deps.playerRepo.get('1')).toMatchObject({ injuryStatus: null });
    expect((await deps.playerRepo.get('1'))?.statusSource).toBeUndefined();
    expect(deps.events.events.map((e) => [e.detail.playerId, e.detail.source])).toEqual([
      ['1', 'sleeper'],
      ['2', 'sleeper']
    ]);
  });

  it('skips without an injury source, NFL state, regular season, schedule, or rostered player', async () => {
    const none = createTestJobDeps({ provider: new FixtureDataProvider() });
    expect(await syncGameDayInjuries(none, none.clock)).toMatchObject({ reason: 'no_injury_source' });
    const bare = createTestJobDeps();
    (bare.provider as StubProvider).injuries = [];
    expect(await syncGameDayInjuries(bare, bare.clock)).toMatchObject({ reason: 'no_nfl_state' });
    await bare.reference.nflState.put({ ...nflState({ seasonType: 'pre' }), updatedAt: SUNDAY }, null);
    expect(await syncGameDayInjuries(bare, bare.clock)).toMatchObject({ reason: 'not_regular_season' });

    const { deps } = await setup('2025-09-07T15:30:00.000Z');
    await deps.reference.schedule.putSeason(2025, [], {}, new Date(SUNDAY));
    expect(await syncGameDayInjuries(deps, deps.clock)).toMatchObject({ reason: 'no_schedule' });
    await deps.reference.schedule.putSeason(
      2025,
      [game({ gameId: '2025_01_NYG_DAL', kickoff: SUNDAY, homeTeam: 'NYG', awayTeam: 'DAL' })],
      {},
      new Date(SUNDAY)
    );
    expect(await syncGameDayInjuries(deps, deps.clock)).toMatchObject({ reason: 'nobody_rostered' });
  });
});
