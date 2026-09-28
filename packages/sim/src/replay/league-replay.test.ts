import { describe, expect, it } from 'vitest';
import { FixedClock, yahooDefaultSettings } from '@fantasy/core';
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
import { championOf, readAudit, replayLeague } from './league-replay.js';
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
    expect(report.human.actions.make_draft_pick).toBeGreaterThanOrEqual(16);
    expect(report.agents.totals.byKind.draft_pick).toBe(7 * 16);
    expect(report.agents.totals.byKind.lineup).toBeGreaterThan(0);
    expect(report.agents.totals.byKind.waivers).toBeGreaterThan(0);
    expect(report.agents.totals.costUsd).toBeGreaterThan(0);
    expect(Object.keys(report.agents.byModel).length).toBeGreaterThan(0);
    expect(report.decisions).toHaveLength(report.agents.totals.tasks);
    expect(model.transcript.length).toBe(report.agents.totals.tasks);

    // The jobs ran on their cadences, and deferred events (pick deadlines, lock warnings) fired.
    expect(report.events.jobRuns.advanceSeason).toBeGreaterThan(100);
    expect(report.events.jobRuns.processWaivers).toBeGreaterThan(10);
    expect(report.events.deferredReleased).toBeGreaterThan(0);
    expect(report.events.delivered['Lineup Lock Approaching']).toBeGreaterThan(0);
    expect(report.chat.byKind.system).toBeGreaterThan(0);
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
