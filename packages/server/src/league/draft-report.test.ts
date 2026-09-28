import type { DraftPick } from '@fantasy/core';
import type { PlayerSeasonLines } from '@fantasy/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, league as leagueFixture, START, type Harness } from '../../test/support/harness.js';
import { newTeam } from './seats.js';
import type { Player } from '../players/model.js';
import type { DraftRecord, League, Matchup } from '../repos/types.js';
import {
  computedJudgements,
  computedReport,
  draftReportInputs,
  type DraftReportInputs
} from './draft-report.js';

/**
 * Report card inputs from awkward data: a drafted player missing from the directory, one with only
 * last season's stats, one whose projection skips a week, a bye, a team that no longer exists, and
 * an open human seat.
 */

const L = 'lg-report-unit';
let h: Harness;
let league: League;
let inputs: DraftReportInputs;

const player = (id: string, position: Player['position'], team: string | null): Player => ({
  id,
  name: id.toUpperCase(),
  firstName: id,
  lastName: id,
  team,
  position,
  status: 'active',
  injuryStatus: null,
  aliases: [],
  rank: null,
  updatedAt: START
});

const lines = (playerId: string, season: number, weeks: number[], stats: Record<string, number>) =>
  ({
    playerId,
    season,
    team: 'X',
    weeks: weeks.map((week) => ({ week, stats: { gp: 1, ...stats } }))
  }) satisfies PlayerSeasonLines;

function pick(
  overall: number,
  teamId: string,
  playerId: string,
  position: DraftPick['positions'][number],
  adp: number | null
): DraftPick {
  return {
    overall,
    round: Math.ceil(overall / 4),
    pick: ((overall - 1) % 4) + 1,
    teamId,
    playerId,
    positions: [position],
    madeAt: START,
    auto: false,
    adp
  };
}

beforeAll(async () => {
  h = await createHarness({
    backend: 'memory',
    players: [
      player('qb1', 'QB', 'CIN'),
      player('rb1', 'RB', 'DAL'),
      player('wr1', 'WR', 'SF'),
      player('qb2', 'QB', 'SF'),
      player('k1', 'K', null)
    ]
  });
  const base = leagueFixture({ id: L, phase: 'regular_season', week: 1 });
  league = {
    ...base,
    settings: {
      ...base.settings,
      teamCount: 4,
      schedule: { ...base.settings.schedule, startWeek: 1, regularSeasonEndWeek: 2 }
    }
  };
  await h.repos.leagues.create(league);
  const settings = league.settings;
  await h.repos.teams.create([
    newTeam({
      leagueId: L,
      id: 't1',
      draftSlot: 1,
      settings,
      now: new Date(START),
      owner: { userId: 'u1', name: 'Alice', teamName: 'Alpha' }
    }),
    newTeam({ leagueId: L, id: 't2', draftSlot: 2, settings, now: new Date(START) }),
    newTeam({ leagueId: L, id: 't3', draftSlot: 3, settings, now: new Date(START) })
    // t4 drafted, then its team record went away.
  ]);
  const matchup = (id: string, week: number, kind: Matchup['kind'], home: string, away: string): Matchup => ({
    id,
    leagueId: L,
    week,
    kind,
    homeTeamId: home,
    awayTeamId: away,
    homeScore: null,
    awayScore: null,
    status: 'scheduled'
  });
  await h.repos.schedule.putMatchups([
    ...[1, 2].flatMap((week) => [
      matchup(`W0${week}-1`, week, 'regular', 't1', 't2'),
      matchup(`W0${week}-2`, week, 'regular', 't3', 't4')
    ]),
    // Playoff games are not part of the projection.
    matchup('P15-1', 15, 'playoff', 't1', 't3')
  ]);
  const reference = h.services.data.reference;
  await reference.nflState.put(
    {
      season: 2026,
      seasonType: 'pre',
      week: 1,
      displayWeek: 1,
      leagueSeason: 2026,
      previousSeason: 2025,
      seasonStartDate: '2026-09-10',
      updatedAt: 'x'
    },
    null
  );
  await reference.schedule.putSeason(2026, [], { CIN: 2 }, new Date(START));
  const meta = { updatedAt: 'x', weeks: [1], hash: 'h' };
  await reference.seasons.put({ ...meta, kind: 'projections', season: 2026, players: 2 }, [
    // qb1 projects week 1 only; week 2 is his bye.
    lines('qb1', 2026, [1], { pass_yd: 300 }),
    // rb1 projects week 1 only; week 2 falls back to his average.
    lines('rb1', 2026, [1], { rush_yd: 100 })
  ]);
  await reference.seasons.put({ ...meta, kind: 'stats', season: 2025, players: 1 }, [
    lines('wr1', 2025, [1, 2], { rec_yd: 50 })
  ]);
  const record: DraftRecord = {
    leagueId: L,
    state: {
      teamIds: ['t1', 't2', 't3', 't4'],
      rounds: 2,
      pickSeconds: 90,
      positionLimits: {},
      tradedPicks: [],
      picks: [
        pick(1, 't1', 'qb1', 'QB', 3),
        pick(2, 't2', 'rb1', 'RB', 1),
        pick(3, 't3', 'wr1', 'WR', null),
        pick(4, 't4', 'ghost', 'TE', 9),
        { ...pick(5, 't4', 'qb2', 'QB', 20), reason: 'Upside.' },
        pick(6, 't3', 'k1', 'K', 200)
      ]
    },
    status: 'complete',
    startedAt: START,
    deadline: null,
    pausedRemainingSeconds: null,
    completedAt: START,
    updatedAt: START,
    version: 1
  };
  inputs = await draftReportInputs(h.services, league, record);
});

afterAll(() => h.close());

describe('draftReportInputs', () => {
  it('projects each week from projections, byes, averages, and last season', () => {
    const [t1, t2, t3] = inputs.teams;
    expect(inputs.schedule).toHaveLength(4);
    // qb1: 300 passing yards in week 1 (12 points under the default scoring), 0 on his week-2 bye.
    expect(t1!.projectedPoints).toBe(12);
    expect(t1!.picks[0]).toMatchObject({
      name: 'QB1',
      nflTeam: 'CIN',
      bye: 2,
      positionRank: 'QB1',
      value: -2
    });
    // rb1: 10 points in week 1 and his 10-point average in week 2.
    expect(t2!.projectedPoints).toBe(20);
    // wr1 has no projection, so last season's points per game carry him.
    expect(t3!.picks[0]).toMatchObject({
      projectedPoints: null,
      lastSeasonPoints: 10,
      value: null,
      positionRank: null
    });
    expect(t3!.projectedPoints).toBe(10);
  });

  it('keeps going for a missing player and a missing team', () => {
    const t4 = inputs.teams[3]!;
    expect(t4).toMatchObject({
      teamId: 't4',
      name: 't4',
      seatType: 'human',
      managerName: null,
      draftSlot: 4
    });
    expect(t4.picks[0]).toMatchObject({ name: 'ghost', position: 'TE', nflTeam: null, bye: null });
    expect(t4.picks[1]).toMatchObject({ reason: 'Upside.' });
    expect(inputs.teams.map((t) => t.managerName)).toEqual(['Alice', null, null, null]);
  });

  it('writes computed judgements with strengths and weaknesses, and a summary', () => {
    const judged = computedJudgements(inputs);
    expect(judged.find((j) => j.teamId === 't1')?.strengths[0]).toMatch(/Strong at quarterback/);
    // t4 took a reach and nothing strong.
    const t4 = judged.find((j) => j.teamId === 't4')!;
    expect(t4.weaknesses.join(' ')).toMatch(/before his ADP/);
    const t2 = judged.find((j) => j.teamId === 't2')!;
    expect(t2.strengths.join(' ')).toMatch(/after his ADP|Strong at/);
    const report = computedReport(inputs, START, 'kill_switch');
    expect(report.teams.reduce((a, t) => a + t.projectedWins, 0)).toBe(4);
    expect(report.summary).toMatch(/team to beat/);
    expect(computedReport({ ...inputs, teams: [], schedule: [] }, START, 'x').summary).toBe(
      'No teams to grade.'
    );
  });
});
