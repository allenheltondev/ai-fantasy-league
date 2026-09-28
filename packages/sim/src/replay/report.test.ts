import { FixedClock, yahooDefaultSettings } from '@fantasy/core';
import {
  InMemoryEventPublisher,
  createInMemoryRepos,
  createServices,
  newTeam,
  silentLogger,
  type AgentTaskRecord,
  type League
} from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import { HumanStandIn, operationRunner } from './human.js';
import { buildLeagueReport, renderLeagueReport } from './report.js';

const NOW = new Date('2025-09-10T12:00:00.000Z');

describe('league replay report', () => {
  it('reports an unfinished league with violations, handler failures, and agent spend', async () => {
    const settings = yahooDefaultSettings(4);
    const repos = createInMemoryRepos();
    const events = new InMemoryEventPublisher();
    const services = createServices({ clock: new FixedClock(NOW), repos, events, log: silentLogger });
    const league: League = {
      id: 'lg',
      name: 'Report',
      season: 2025,
      phase: 'playoffs',
      week: 15,
      settings,
      commissionerId: 'u',
      commissionerName: 'U',
      createdBy: 'u',
      scheduleSeed: 'lg',
      deadlines: {
        draftStartsAt: null,
        nextLineupLockAt: null,
        nextWaiverRunAt: null,
        tradeDeadlineAt: null
      },
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      version: 1
    };
    await repos.teams.create([
      newTeam({ leagueId: 'lg', id: 'team-2', draftSlot: 2, settings, now: NOW }),
      newTeam({ leagueId: 'lg', id: 'team-1', draftSlot: 1, settings, now: NOW })
    ]);
    const task: AgentTaskRecord = {
      taskId: 't1',
      leagueId: 'lg',
      teamId: 'team-2',
      agentId: 'lg.team-2',
      kind: 'lineup',
      trigger: { detailType: 'Lineup Lock Approaching', eventId: 'e1' },
      week: 1,
      startedAt: NOW.toISOString(),
      status: 'fallback',
      fallbackReason: 'model_error',
      toolsCalled: [],
      finalAction: 'set_lineup',
      reasoningSummary: 'Optimizer lineup.',
      latencyMs: 1,
      usage: [
        { modelKey: 'haiku', inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0.01, estimatedTokens: true }
      ],
      costUsd: 0.01,
      finishedAt: NOW.toISOString()
    };
    await repos.agents.completeTask(task, new Date('2026-01-01T00:00:00.000Z'));
    const human = new HumanStandIn(
      { type: 'user', sub: 'h', email: null, name: 'H' },
      'team-1',
      operationRunner(services),
      services
    );
    const report = await buildLeagueReport({
      seed: 's',
      season: 2025,
      league,
      settings,
      playedWeeks: [1, 15],
      playoffWeeks: [15],
      human,
      services,
      events,
      loopStats: { delivered: {}, released: 0, jobRuns: {}, failures: [] },
      failures: [
        {
          at: NOW.toISOString(),
          handler: 'agent-task',
          eventId: 'e',
          detailType: 'Agent Action Requested',
          error: new Error('boom')
        },
        { at: NOW.toISOString(), handler: 'advanceSeason', eventId: null, detailType: null, error: 'bad' }
      ],
      checks: new Map([
        [1, [{ name: 'no_shared_players', ok: false, violations: ['a is on team-1 and team-2'] }]]
      ]),
      standings: [],
      champion: null,
      timings: [
        { week: null, label: 'draft', wallMs: 1, simTo: NOW.toISOString() },
        { week: 1, label: 'regular', wallMs: 2, simTo: NOW.toISOString(), events: 3 },
        { week: 15, label: 'playoffs', wallMs: 2, simTo: NOW.toISOString(), events: 1 }
      ],
      dataAccess: { reads: 0, byMethod: {}, futureAccessAttempts: 0 },
      model: 'fake',
      wallMs: 5
    });
    expect(report.teams.map((t) => t.id)).toEqual(['team-1', 'team-2']);
    expect(report.draft).toEqual({ order: [], picks: 0, autoPicks: {} });
    expect(report.agents.byModel.haiku).toMatchObject({ tasks: 1, costUsd: 0.01, inputTokens: 10 });
    expect(report.agents.totals.byStatus).toEqual({ fallback: 1 });
    expect(report.weeks.map((w) => w.invariants.length)).toEqual([1, 0]);
    expect(report.violations).toEqual([
      { week: 1, name: 'no_shared_players', message: 'a is on team-1 and team-2' }
    ]);
    expect(report.events.failures.map((f) => f.error)).toEqual(['boom', 'bad']);

    const md = renderLeagueReport(report);
    expect(md).toContain('**Champion:** none');
    expect(md).toContain('1 violation(s)');
    expect(md).toContain('- week 1 `no_shared_players`: a is on team-1 and team-2');
    expect(md).toContain('advanceSeason (job): bad');
    expect(md).toContain('| 1 | regular | VIOLATED |');
    expect(md).toContain('| 15 | playoffs | ok |');

    const bare = renderLeagueReport({
      ...report,
      settings: { ...report.settings, playoffWeeks: [] },
      weeks: []
    });
    expect(bare).toContain('playoffs none');
  });
});
