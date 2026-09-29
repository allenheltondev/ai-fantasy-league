import { describe, expect, it } from 'vitest';
import { FixedClock, isGenericTeamName, yahooDefaultSettings } from '@fantasy/core';
import { ScriptedModelClient } from '@fantasy/agents';
import {
  InMemoryEventPublisher,
  createInMemoryRepos,
  createServices,
  silentLogger,
  type League
} from '@fantasy/server';
import { replaySettings } from '../runner/settings.js';
import { fixtureArchive } from '../../test/helpers.js';
import { SimulationError } from '../runner/run-season.js';
import { REPLAY_INVARIANTS } from './checks.js';
import { addViolation, championOf, readAudit, replayLeague } from './league-replay.js';
import { renderLeagueReport, type LeagueReplayReport } from './report.js';

/**
 * The short replay CI runs on the committed 4-week fixture: the real server operations, jobs, and
 * event handlers, and seven agents on the fake model, all on the simulated clock. The full 2025
 * season (and a week-4 start) run nightly (.github/workflows/nightly-sim.yaml).
 */

function expectClean(report: LeagueReplayReport, weeks: number[]): void {
  expect(report.events.failures).toEqual([]);
  expect(report.violations).toEqual([]);
  expect(report.dataAccess.futureAccessAttempts).toBe(0);
  expect(report.phase).toBe('complete');
  expect(report.weeks.map((w) => w.week)).toEqual(weeks);
  for (const w of report.weeks) {
    expect(w.invariants.map((c) => c.name).sort()).toEqual([...REPLAY_INVARIANTS].sort());
    expect(w.matchups.every((m) => m.homeScore !== null && m.awayScore !== null)).toBe(true);
  }
  expect(report.events.delivered['Week Provisionally Final']).toBe(weeks.length);
  expect(report.events.delivered['Week Official Final']).toBe(weeks.length);
}

describe('replayLeague: the real league on the simulated clock', () => {
  it('drafts, plays, and finishes a 3-week season with 7 agents and the human stand-in', async () => {
    const lines: string[] = [];
    const model = new ScriptedModelClient();
    const report = await replayLeague({
      archive: await fixtureArchive(),
      seed: 'ci',
      weeks: 3,
      model,
      log: (l) => lines.push(l)
    });

    expectClean(report, [1, 2, 3]);
    expect(lines).toHaveLength(3);
    expect(report.settings).toMatchObject({
      teamCount: 8,
      startWeek: 1,
      regularSeasonEndWeek: 2,
      playoffWeeks: [3]
    });
    expect(report.champion).not.toBeNull();
    expect(report.standings).toHaveLength(8);
    expect(report.draft.picks).toBe(8 * 16);

    // Seat 1 is the scripted human; the other seven are agents that acted through the router and runner.
    expect(report.teams.filter((t) => t.seat === 'human').map((t) => t.id)).toEqual(['team-1']);
    expect(report.teams.filter((t) => t.agent !== null)).toHaveLength(7);
    // Every AI manager named its team at the kickoff, and no two picked the same name (#194).
    const agentNames = report.teams.filter((t) => t.agent !== null).map((t) => t.name);
    expect(agentNames.filter((n) => isGenericTeamName(n))).toEqual([]);
    expect(new Set(agentNames).size).toBe(7);
    expect(report.human.actions.make_draft_pick).toBeGreaterThanOrEqual(16);
    expect(report.agents.totals.byKind.draft_pick).toBe(7 * 16);
    expect(report.agents.totals.byKind.lineup).toBeGreaterThan(0);
    expect(report.agents.totals.byKind.waivers).toBeGreaterThan(0);
    // The weekly waiver look comes after the new week's projections, so agents find pickups.
    expect(report.transactions.length).toBeGreaterThan(0);
    expect(report.agents.totals.costUsd).toBeGreaterThan(0);
    // The human offers a trade before the deadline, and agents shop for trades on their own at the
    // rollover; every offer to an agent is answered through its task.
    expect(report.human.actions.propose_trade).toBeGreaterThan(0);
    expect(report.agents.totals.byKind.trade_proposal).toBeGreaterThan(0);
    expect(report.trades.offers.byAgents).toBeGreaterThan(0);
    // Agent-to-agent deals get accepted and go to league review, where the other agents vote.
    expect(report.agents.totals.byKind.trade_vote).toBeGreaterThan(0);
    expect(report.decisions.some((d) => d.kind === 'trade_response' && d.action === 'accept_trade')).toBe(
      true
    );
    expect(report.agents.totals.byKind.trade_response).toBe(report.trades.offers.toAgents);
    expect(Object.keys(report.agents.byModel).length).toBeGreaterThan(0);
    expect(report.decisions).toHaveLength(report.agents.totals.tasks);
    // Tasks with nothing to decide (no trade worth offering, a vote to let a trade pass) skip the model.
    // The draft report card grader makes one more run when the draft completes.
    expect(model.transcript.length).toBe(
      report.agents.totals.tasks - (report.agents.totals.byStatus.skipped ?? 0) + 1
    );

    // The jobs ran on their cadences, and deferred events (pick deadlines, lock warnings) fired.
    expect(report.events.jobRuns.advanceSeason).toBeGreaterThan(100);
    expect(report.events.jobRuns.processWaivers).toBeGreaterThan(10);
    // Three check-ins a day (#195): every agent looks at its team, and some of them act.
    expect(report.events.jobRuns.managerCheckIns).toBeGreaterThan(20);
    expect(report.agents.totals.byKind.check_in).toBeGreaterThan(7 * 20);
    expect(report.decisions.some((d) => d.kind === 'check_in' && d.action.includes('claim_waiver'))).toBe(
      true
    );
    expect(report.events.deferredReleased).toBeGreaterThan(0);
    expect(report.events.delivered['Lineup Lock Approaching']).toBeGreaterThan(0);
    expect(report.chat.byKind.system).toBeGreaterThan(0);
    // League news lands in its rooms (#144): draft picks in #draft, week finals in #league and in
    // every matchup room.
    expect(report.chat.byRoom.draft).toBeGreaterThan(0);
    expect(report.chat.byRoom.league).toBeGreaterThan(0);
    expect(report.chat.byRoom.matchup).toBeGreaterThan(0);
    expect(Object.values(report.chat.byRoom).reduce((a, b) => a + b, 0)).toBe(report.chat.messages);
    // Agent chat by room (#153), and retorts never outnumber agent messages.
    expect(Object.values(report.chat.agentByRoom).reduce((a, b) => a + b, 0)).toBe(
      report.chat.byKind.agent ?? 0
    );
    expect(report.chat.retorts).toBeLessThanOrEqual(report.chat.byKind.agent ?? 0);
    expect(report.timings.map((t) => t.label)).toEqual(['draft', 'regular', 'regular', 'playoffs']);

    const markdown = renderLeagueReport(report);
    expect(markdown).toContain('# 2025 season replay');
    expect(markdown).toContain('**Invariants:** all held');
  });

  it('starts a league mid-season through the server cycle, and gives the same league for the same seed', async () => {
    // No `weeks`: the replay runs through the archive's last week (4).
    const options = { archive: await fixtureArchive(), seed: 'mid', startWeek: 2 };
    const first = await replayLeague(options);
    expectClean(first, [2, 3, 4]);
    expect(first.settings.startWeek).toBe(2);
    expect(first.timings[0]?.simTo.startsWith('2025-09-')).toBe(true);

    const again = await replayLeague(options);
    const stable = (r: LeagueReplayReport) => ({
      ...r,
      wallMs: 0,
      timings: r.timings.map((t) => ({ ...t, wallMs: 0 }))
    });
    expect(stable(again)).toEqual(stable(first));
  });

  it('starts a scheduled draft by itself when the clock reaches its time', async () => {
    const report = await replayLeague({
      archive: await fixtureArchive(),
      seed: 'scheduled',
      weeks: 3,
      scheduledDraft: true
    });
    expectClean(report, [1, 2, 3]);
    expect(report.timings[0]?.label).toBe('draft');
  });

  it('refuses weeks the archive does not cover', async () => {
    await expect(
      replayLeague({ archive: await fixtureArchive(), seed: 'x', startWeek: 3, weeks: 3 })
    ).rejects.toThrow(SimulationError);
  });

  it('refuses settings that cannot form a season', async () => {
    const settings = replaySettings(8, 1, 3);
    await expect(
      replayLeague({
        archive: await fixtureArchive(),
        seed: 'x',
        weeks: 3,
        settings: { ...settings, schedule: { startWeek: 3, regularSeasonEndWeek: 2 } }
      })
    ).rejects.toThrow(SimulationError);
  });

  it('adds late findings to a week, joining a check of the same name', () => {
    const checks = new Map([
      [1, [{ name: 'week_scored_once' as const, ok: true, violations: [] as string[] }]]
    ]);
    addViolation(checks, 1, 'week_scored_once', 'went official 0 times');
    addViolation(checks, 1, 'standings_match', 'champion differs');
    addViolation(checks, 2, 'standings_match', 'x');
    expect(checks.get(1)).toEqual([
      { name: 'week_scored_once', ok: false, violations: ['went official 0 times'] },
      { name: 'standings_match', ok: false, violations: ['champion differs'] }
    ]);
    expect(checks.get(2)).toEqual([{ name: 'standings_match', ok: false, violations: ['x'] }]);
  });

  it('audits every archive read and reports each future read once', async () => {
    const archive = await fixtureArchive();
    const audit = readAudit(archive);
    audit.onRead({ method: 'getPlayers', asOf: '2025-09-01T00:00:00.000Z' });
    audit.onRead({
      method: 'getSchedule',
      asOf: '2025-09-01T00:00:00.000Z',
      season: 2025,
      finalGameIds: [archive.schedule[0]!.gameId]
    });
    expect(audit.reads).toBe(2);
    expect(audit.byMethod).toEqual({ getPlayers: 1, getSchedule: 1 });
    expect(audit.takeFuture()).toEqual([
      `2025-09-01T00:00:00.000Z: ${archive.schedule[0]!.gameId} served as final at 2025-09-01T00:00:00.000Z before it ended`
    ]);
    expect(audit.takeFuture()).toEqual([]);
  });

  it('finds no champion for an unfinished league or a bracket it cannot rebuild', async () => {
    const repos = createInMemoryRepos();
    const services = createServices({
      clock: new FixedClock('2025-12-30T00:00:00.000Z'),
      repos,
      events: new InMemoryEventPublisher(),
      log: silentLogger
    });
    const settings = yahooDefaultSettings(4);
    const league = { id: 'lg', phase: 'complete', settings } as League;
    const row = (teamId: string, rank: number) => ({ teamId, rank });
    const standings = [row('a', 1), row('b', 2), row('c', 3), row('d', 4)] as never[];
    expect(await championOf(services, { ...league, phase: 'playoffs' }, standings, [15, 16, 17])).toBeNull();
    expect(await championOf(services, league, standings.slice(0, 1), [15, 16, 17])).toBeNull();
    // No playoff games stored: the first playoff week cannot advance the bracket.
    expect(
      await championOf(services, league, standings, settings.playoffs.startWeek === 15 ? [15, 16] : [])
    ).toBeNull();
  });
});
