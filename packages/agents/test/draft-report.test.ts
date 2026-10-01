import { gamesPerTeam, getModel } from '@fantasy/core';
import { handleLeagueEvent, type DraftReportCard } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import {
  DRAFT_REPORT_AGENT_ID,
  DRAFT_REPORT_CLAIM_MS,
  DRAFT_REPORT_MODELS,
  gradeDraft,
  type DraftJudgement
} from '../src/draft-report.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { OFF_SWITCH, type KillSwitch } from '../src/kill-switch.js';
import { agentSubscribers, inProcessAgentDeps } from '../src/loop.js';
import { ModelUnavailableError, withRunUsage, type ModelClient } from '../src/model.js';
import { draftSetup, type DraftSetup } from './draft-support.js';

/** A 4-team league whose draft ran to the end on the pick clock. */
async function drafted(): Promise<DraftSetup> {
  const s = await draftSetup({ teamCount: 4 });
  for (let guard = 0; guard < 200; guard++) {
    const draft = await s.repos.drafts.get(s.leagueId);
    if (draft?.status === 'complete') break;
    s.clock.set(new Date(new Date(draft?.deadline ?? s.clock.now()).getTime() + 1000));
    await handleLeagueEvent(s.services, {
      id: `deadline-${String(draft!.state.picks.length + 1)}`,
      source: 'fantasy',
      'detail-type': 'Draft Pick Deadline',
      detail: { leagueId: s.leagueId, pick: draft!.state.picks.length + 1 }
    });
  }
  return s;
}

const deps = (s: DraftSetup, model: ScriptedModelClient, killSwitch: KillSwitch = OFF_SWITCH) => ({
  services: s.services,
  model,
  killSwitch
});

/** Records add up: every matchup one win and one loss, each team's games, ranks 1..N. */
async function expectBalanced(s: DraftSetup, report: DraftReportCard) {
  const matchups = (await s.repos.schedule.listMatchups(s.leagueId)).filter((m) => m.kind === 'regular');
  const games = gamesPerTeam(
    report.teams.map((t) => t.teamId),
    matchups
  );
  expect(report.teams.reduce((a, t) => a + t.projectedWins, 0)).toBe(matchups.length);
  expect(report.teams.reduce((a, t) => a + t.projectedLosses, 0)).toBe(matchups.length);
  for (const t of report.teams) expect(t.projectedWins + t.projectedLosses).toBe(games.get(t.teamId));
  expect(report.teams.map((t) => t.projectedRank)).toEqual([1, 2, 3, 4]);
  for (let i = 1; i < report.teams.length; i++)
    expect(report.teams[i - 1]!.projectedWins).toBeGreaterThanOrEqual(report.teams[i]!.projectedWins);
}

/** The model's answer, from the grader's own default (the computed judgements), then edited. */
function scripted(edit: (d: DraftJudgement) => DraftJudgement) {
  return new ScriptedModelClient({
    script: (request) => {
      const base = request.fakeScript!().decision as DraftJudgement;
      return { steps: [], decision: edit(base) };
    }
  });
}

describe('the draft report card grader', () => {
  it('grades a finished draft with the model once, records its spend, and publishes records that add up', async () => {
    const s = await drafted();
    const model = new ScriptedModelClient();
    const report = (await gradeDraft(deps(s, model), s.leagueId))!;
    expect(report).toMatchObject({ status: 'ready', source: 'model', modelKey: DRAFT_REPORT_MODELS[0] });
    expect(report.summary).toMatch(/fake analyst/);
    await expectBalanced(s, report);
    expect(await s.repos.drafts.getReport(s.leagueId)).toEqual(report);

    // One structured call, no tools, with every team and the league's matchup total in the prompt.
    expect(model.transcript).toHaveLength(1);
    const run = model.transcript[0]!;
    expect(run.modelId).toBe(getModel(DRAFT_REPORT_MODELS[0]!).bedrockId);
    expect(run.toolNames).toEqual([]);
    const teams = await s.repos.teams.list(s.leagueId);
    for (const team of teams) expect(run.input).toContain(`teamId ${team.id}`);
    expect(run.input).toMatch(/Projected wins must sum to \d+\./);
    expect(run.systemPrompt).toMatch(/A\+ \(best\) to F- \(worst\)/);

    const league = (await s.repos.leagues.get(s.leagueId))!;
    const usage = await s.repos.agents.weekUsage(s.leagueId, league.week!);
    expect(usage.filter((u) => u.agentId === DRAFT_REPORT_AGENT_ID)).toEqual([
      expect.objectContaining({ modelKey: DRAFT_REPORT_MODELS[0], tasks: 1 })
    ]);

    // A redelivered `Draft Completed` does not grade again.
    expect(await gradeDraft(deps(s, model), s.leagueId)).toEqual(report);
    expect(model.transcript).toHaveLength(1);
  });

  it('reconciles an impossible answer: every team undefeated, all ranked first', async () => {
    const s = await drafted();
    const model = scripted((d) => ({
      ...d,
      teams: d.teams.map((t) => ({ ...t, projectedWins: 17, projectedRank: 1 }))
    }));
    const report = (await gradeDraft(deps(s, model), s.leagueId))!;
    expect(report.source).toBe('model');
    await expectBalanced(s, report);
  });

  it('keeps the model’s ranking among teams level on wins', async () => {
    const s = await drafted();
    const teams = await s.repos.teams.list(s.leagueId);
    const order = teams.map((t) => t.id).reverse();
    const model = scripted((d) => ({
      ...d,
      teams: d.teams.map((t) => ({ ...t, projectedWins: 1, projectedRank: order.indexOf(t.teamId) + 1 }))
    }));
    const report = (await gradeDraft(deps(s, model), s.leagueId))!;
    await expectBalanced(s, report);
    const byWins = new Map<number, string[]>();
    for (const t of report.teams)
      byWins.set(t.projectedWins, [...(byWins.get(t.projectedWins) ?? []), t.teamId]);
    for (const ids of byWins.values())
      expect(ids).toEqual([...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  });

  it('falls back to computed grades when the answer leaves a team out', async () => {
    const s = await drafted();
    const model = scripted((d) => ({ ...d, teams: d.teams.slice(1) }));
    const report = (await gradeDraft(deps(s, model), s.leagueId))!;
    expect(report).toMatchObject({ source: 'computed', fallbackReason: 'incomplete_answer', modelKey: null });
    await expectBalanced(s, report);
  });

  it('uses computed grades without calling a model when the kill switch is on or the budget is spent', async () => {
    const s = await drafted();
    const model = new ScriptedModelClient();
    const off = await gradeDraft(deps(s, model, { engaged: async () => true }), s.leagueId);
    expect(off).toMatchObject({ source: 'computed', fallbackReason: 'kill_switch' });
    expect(model.transcript).toHaveLength(0);

    const t = await drafted();
    const league = (await t.repos.leagues.get(t.leagueId))!;
    await t.repos.agents.addUsage({
      leagueId: t.leagueId,
      week: league.week!,
      agentId: 'someone',
      modelKey: 'claude-opus-5',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 1000,
      tasks: 1
    });
    expect(await gradeDraft(deps(t, model), t.leagueId)).toMatchObject({
      source: 'computed',
      fallbackReason: 'budget_exceeded'
    });
    expect(model.transcript).toHaveLength(0);
  });

  it('tries the next model when one is unavailable, and falls back when a model errors', async () => {
    const s = await drafted();
    const first = getModel(DRAFT_REPORT_MODELS[0]!).bedrockId;
    const model = new ScriptedModelClient({
      fail: (id) => (id === first ? new ModelUnavailableError('throttled') : undefined)
    });
    expect(await gradeDraft(deps(s, model), s.leagueId)).toMatchObject({
      source: 'model',
      modelKey: DRAFT_REPORT_MODELS[1]
    });

    const t = await drafted();
    const broken = new ScriptedModelClient({ fail: () => new Error('bad output') });
    expect(await gradeDraft(deps(t, broken), t.leagueId)).toMatchObject({
      source: 'computed',
      fallbackReason: 'model_error'
    });
    // The failed attempt still counts against the budget.
    const league = (await t.repos.leagues.get(t.leagueId))!;
    const usage = await t.repos.agents.weekUsage(t.leagueId, league.week!);
    expect(usage.find((u) => u.agentId === DRAFT_REPORT_AGENT_ID)?.costUsd).toBeGreaterThan(0);

    const u = await drafted();
    const down = new ScriptedModelClient({ fail: () => new ModelUnavailableError('down') });
    expect(await gradeDraft(deps(u, down), u.leagueId)).toMatchObject({
      source: 'computed',
      fallbackReason: 'models_unavailable'
    });
  });

  it('charges what a failed run reported, and the estimate when a run times out', async () => {
    const s = await drafted();
    const first = getModel(DRAFT_REPORT_MODELS[0]!).bedrockId;
    const model = new ScriptedModelClient({
      fail: (id) =>
        withRunUsage(
          id === first ? new ModelUnavailableError('throttled') : new Error('bad output'),
          id === first
            ? { inputTokens: 1000, outputTokens: 100, estimated: false }
            : { inputTokens: 2000, outputTokens: 200, estimated: false }
        ) as Error
    });
    expect(await gradeDraft(deps(s, model), s.leagueId)).toMatchObject({
      source: 'computed',
      fallbackReason: 'model_error'
    });
    const league = (await s.repos.leagues.get(s.leagueId))!;
    const usage = (await s.repos.agents.weekUsage(s.leagueId, league.week!)).filter(
      (u) => u.agentId === DRAFT_REPORT_AGENT_ID
    );
    // Both runs are charged what Bedrock reported, not the prompt plus the whole response limit.
    expect(usage.map((u) => [u.modelKey, u.inputTokens, u.outputTokens]).sort()).toEqual(
      [
        [DRAFT_REPORT_MODELS[0], 1000, 100],
        [DRAFT_REPORT_MODELS[1], 2000, 200]
      ].sort()
    );

    const t = await drafted();
    const hangs: ModelClient = {
      name: 'hangs',
      run: (request) =>
        new Promise((_, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason as Error))
        )
    };
    expect(
      await gradeDraft(
        { services: t.services, model: hangs, killSwitch: OFF_SWITCH, modelTimeoutMs: 5 },
        t.leagueId
      )
    ).toMatchObject({ source: 'computed', fallbackReason: 'timeout' });
    const timedOut = (await t.repos.agents.weekUsage(t.leagueId, league.week!)).find(
      (u) => u.agentId === DRAFT_REPORT_AGENT_ID
    );
    expect(timedOut?.outputTokens).toBeGreaterThan(0);
  });

  it('releases its claim when grading crashes, so the retry grades the draft', async () => {
    const s = await drafted();
    const listMatchups = s.repos.schedule.listMatchups.bind(s.repos.schedule);
    s.repos.schedule.listMatchups = async () => {
      throw new Error('table down');
    };
    const model = new ScriptedModelClient();
    await expect(gradeDraft(deps(s, model), s.leagueId)).rejects.toThrow('table down');
    expect(await s.repos.drafts.getReport(s.leagueId)).toMatchObject({
      status: 'grading',
      claimedUntil: '1970-01-01T00:00:00.000Z'
    });
    s.repos.schedule.listMatchups = listMatchups;
    expect(await gradeDraft(deps(s, model), s.leagueId)).toMatchObject({ status: 'ready', source: 'model' });
  });

  it('holds a live claim against a second grader', async () => {
    const s = await drafted();
    const model = new ScriptedModelClient();
    const now = s.clock.now();
    await s.repos.drafts.claimReport(
      {
        leagueId: s.leagueId,
        status: 'grading',
        claimedUntil: new Date(now.getTime() + DRAFT_REPORT_CLAIM_MS).toISOString(),
        source: null,
        fallbackReason: null,
        modelKey: null,
        summary: '',
        teams: [],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      },
      now.toISOString()
    );
    expect(await gradeDraft(deps(s, model), s.leagueId)).toMatchObject({ status: 'grading' });
    expect(model.transcript).toHaveLength(0);
    // Once the claim lapses (the first grader's Lambda died), the next delivery takes over.
    s.clock.advance(DRAFT_REPORT_CLAIM_MS + 1000);
    expect(await gradeDraft(deps(s, model), s.leagueId)).toMatchObject({ status: 'ready' });
  });

  it('does nothing before the draft is complete', async () => {
    const s = await draftSetup({ teamCount: 4 });
    expect(await gradeDraft(deps(s, new ScriptedModelClient()), s.leagueId)).toBeNull();
    expect(await gradeDraft(deps(s, new ScriptedModelClient()), 'no-such-league')).toBeNull();
    expect(await s.repos.drafts.getReport(s.leagueId)).toBeNull();
  });

  it('runs as an event-loop subscriber on Draft Completed', async () => {
    const s = await drafted();
    const subscriber = agentSubscribers(inProcessAgentDeps(s.services, new ScriptedModelClient())).find(
      (sub) => sub.name === 'draft-report'
    )!;
    expect(subscriber.detailTypes).toEqual(['Draft Completed']);
    const completed = s.events.events.find((e) => e.detailType === 'Draft Completed')!;
    await subscriber.handle({
      id: 'e1',
      source: 'fantasy',
      'detail-type': completed.detailType,
      detail: completed.detail
    });
    expect(await s.repos.drafts.getReport(s.leagueId)).toMatchObject({ status: 'ready', source: 'model' });
  });
});
