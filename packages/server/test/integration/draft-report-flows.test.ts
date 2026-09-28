import type { PlayerSeasonLines } from '@fantasy/data';
import { gamesPerTeam } from '@fantasy/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleLeagueEvent } from '../../src/events/handlers.js';
import {
  computedJudgements,
  computedReport,
  draftReportInputs,
  reconcileReport
} from '../../src/league/draft-report.js';
import { registry } from '../../src/operations/index.js';
import { fixtureDraftPool } from '../../src/players/fixtures.js';
import { createHarness, type Harness } from '../support/harness.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE, BOB, CAROL, seedLeague } from '../support/leagues.js';

/**
 * The draft report card (post-draft grades and projected standings) over HTTP (DynamoDB Local): its
 * inputs from a real draft, projections, and schedule; the computed fallback; reconciling judged
 * records so they add up; and who may read it.
 */

const L = 'lg-report';
let h: Harness;
let alice: Caller;
let carol: Caller;

interface ReportView {
  status: string;
  source: string | null;
  summary: string | null;
  teams: {
    teamId: string;
    teamName: string;
    yours: boolean;
    grade: string;
    projectedWins: number;
    projectedLosses: number;
    projectedRank: number;
  }[];
}
const reportCard = async (caller: Caller) =>
  data<ReportView>(await caller.get(`/leagues/${L}/draft/report-card`));

async function expire(pick: number) {
  const draft = await h.repos.drafts.get(L);
  h.clock.set(new Date(new Date(draft?.deadline ?? h.clock.now()).getTime() + 1000));
  return handleLeagueEvent(h.services, {
    id: `deadline-${pick}`,
    source: 'fantasy',
    'detail-type': 'Draft Pick Deadline',
    detail: { leagueId: L, pick }
  });
}

/** 17 weeks of projections that fall off with rank, off on the team's bye. */
function projection(playerId: string, team: string | null, rank: number): PlayerSeasonLines {
  const yards = Math.max(10, 160 - rank);
  const bye = team === 'CIN' ? 10 : team === 'DAL' ? 7 : null;
  return {
    playerId,
    season: 2026,
    team: team ?? 'X',
    weeks: Array.from({ length: 17 }, (_, i) => i + 1)
      .filter((week) => week !== bye)
      .map((week) => ({ week, stats: { rec_yd: yards, rush_yd: yards / 2, fgm: 2, pass_yd: yards * 2 } }))
  };
}

beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo', registry, players: fixtureDraftPool });
  alice = as(h, ALICE);
  carol = as(h, CAROL);
  await seedLeague(h.repos, { id: L, owners: [ALICE, BOB] });
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
  await reference.schedule.putSeason(2026, [], { CIN: 10, DAL: 7 }, new Date('2026-05-01'));
  const ranked = fixtureDraftPool.filter((p) => p.rank !== null);
  await reference.seasons.put(
    { updatedAt: 'x', weeks: [1], hash: 'h', kind: 'projections', season: 2026, players: ranked.length },
    ranked.map((p) => projection(p.id, p.team, p.rank!))
  );
  const started = await alice.post(`/leagues/${L}/draft/start`, {});
  expect(started.status, JSON.stringify(started.body)).toBe(200);
});

afterAll(() => h.close());

describe('the draft report card', () => {
  it('waits for the last pick, and only league members may read it', async () => {
    expect(await reportCard(alice)).toEqual({
      status: 'draft_in_progress',
      source: null,
      summary: null,
      generatedAt: null,
      teams: []
    });
    expect(errorCode(await carol.get(`/leagues/${L}/draft/report-card`))).toBe('FORBIDDEN');
  });

  it('builds grading inputs from the finished draft, and publishes records that add up', async () => {
    for (let guard = 0; guard < 200; guard++) {
      const draft = await h.repos.drafts.get(L);
      if (draft?.status === 'complete') break;
      await expire(draft!.state.picks.length + 1);
    }
    expect(await reportCard(alice)).toMatchObject({ status: 'grading', teams: [] });

    const league = (await h.repos.leagues.get(L))!;
    const record = (await h.repos.drafts.get(L))!;
    const inputs = await draftReportInputs(h.services, league, record);
    expect(inputs.teams.map((t) => t.teamId)).toEqual(record.state.teamIds);
    const weeks = inputs.lastWeek - inputs.firstWeek + 1;
    expect(inputs.schedule).toHaveLength(weeks * 4);
    for (const team of inputs.teams) {
      expect(team.picks).toHaveLength(16);
      expect(team.projectedPoints).toBeGreaterThan(0);
      expect(team.weeklyAverage).toBeCloseTo(team.projectedPoints / weeks, 0);
    }
    // Expected wins sum to the number of matchups.
    expect(inputs.teams.reduce((a, t) => a + t.expectedWins, 0)).toBeCloseTo(inputs.schedule.length, 0);
    const first = inputs.teams[0]!.picks[0]!;
    expect(first).toMatchObject({ overall: 1, round: 1, positionRank: expect.stringMatching(/^[A-Z]+\d+$/) });
    expect(first.projectedPoints).toBeGreaterThan(0);

    // Judged records that are impossible (everyone 14-0) still come out balanced.
    const judged = computedJudgements(inputs).map((j) => ({ ...j, projectedWins: weeks }));
    const teams = reconcileReport(inputs, judged)!;
    const games = gamesPerTeam(
      inputs.teams.map((t) => t.teamId),
      inputs.schedule
    );
    expect(teams.reduce((a, t) => a + t.projectedWins, 0)).toBe(inputs.schedule.length);
    expect(teams.reduce((a, t) => a + t.projectedLosses, 0)).toBe(inputs.schedule.length);
    for (const t of teams) expect(t.projectedWins + t.projectedLosses).toBe(games.get(t.teamId));
    expect(teams.map((t) => t.projectedRank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Missing or duplicated teams are rejected.
    expect(reconcileReport(inputs, judged.slice(1))).toBeNull();
    expect(reconcileReport(inputs, [...judged.slice(1), judged[1]!])).toBeNull();

    const computed = computedReport(inputs, h.clock.now().toISOString(), 'kill_switch');
    expect(computed).toMatchObject({ status: 'ready', source: 'computed', fallbackReason: 'kill_switch' });
    const wins = computed.teams.map((t) => t.projectedWins);
    expect([...wins].sort((a, b) => b - a)).toEqual(wins);
    await h.repos.drafts.putReport(computed);

    const view = await reportCard(alice);
    expect(view).toMatchObject({
      status: 'ready',
      source: 'computed',
      summary: expect.stringContaining('team to beat')
    });
    expect(view.teams.map((t) => t.projectedRank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(view.teams.filter((t) => t.yours).map((t) => t.teamId)).toEqual(['team-1']);
    expect(view.teams.find((t) => t.teamId === 'team-1')?.teamName).toBe("Alice's Team");
  });
});
