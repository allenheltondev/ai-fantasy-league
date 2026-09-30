import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MANIPULATION_PROBES } from '@fantasy/core';
import { ScriptedModelClient, type ModelClient, type ModelRunRequest } from '@fantasy/agents';
import { fixtureArchive } from '../../test/helpers.js';
import {
  BudgetExhaustedError,
  BudgetedModel,
  MAX_EVAL_BUDGET_USD,
  PinnedModel,
  liveEvalRefusal
} from '../eval/budget.js';
import {
  CONDITION_PROMPTS,
  EVAL_CONDITIONS,
  latencyOf,
  parseEvalArgs,
  renderEvalReport,
  renderTranscripts,
  runLiveEval
} from '../eval/live-eval.js';
import { RUBRICS, scoreRubrics, type RubricName } from '../eval/rubrics.js';
import { RecordingModel, memorySection, withoutSections } from './recording-model.js';
import {
  DM_CANARY,
  SCENARIO_SEATS,
  checkScenarios,
  deterministicPolicy,
  runSeasonScenario,
  type ScenarioCheck,
  type ScenarioRun
} from './season-scenarios.js';

/**
 * Season-level agent scenarios (#211) on the committed fixture: one 3-week replay through the real
 * league with production's ingestion path and response delays on, and the scripted policy. Every
 * scenario check is a hard assertion here; the rubrics and the live-evaluation harness are
 * exercised on the same run, without any live model.
 */

let run: ScenarioRun;
beforeAll(async () => {
  run = await runSeasonScenario({ archive: await fixtureArchive(), seed: 'scenarios' });
}, 150_000);

const clone = (): ScenarioRun => structuredClone(run);
const named = (checks: ScenarioCheck[], name: ScenarioCheck['name']) =>
  checks.find((c) => c.name === name) as ScenarioCheck;
const rubric = (r: ScenarioRun, name: RubricName) => scoreRubrics(r).find((s) => s.rubric === name);

describe('season scenarios with the deterministic policy', () => {
  it('holds every scenario check, and the league stays clean', () => {
    expect(run.report.events.failures).toEqual([]);
    expect(run.report.violations).toEqual([]);
    const checks = checkScenarios(run);
    expect(checks.map((c) => c.name)).toEqual([
      'recall',
      'conversation_to_action',
      'privacy',
      'delayed_replies',
      'relationship_evolution',
      'manipulation'
    ]);
    for (const c of checks) expect(c, c.name).toMatchObject({ ok: true, violations: [] });
    expect(run.probes.map((p) => [p.kind, p.teamId])).toEqual([
      ['conversation', SCENARIO_SEATS.conversation],
      ['manipulation', SCENARIO_SEATS.manipulation],
      ['recall', SCENARIO_SEATS.recall]
    ]);
  });

  it('recalls real results: memory matches the league, and the recall prompt names last week', () => {
    // Memory-only events reach the in-process loop (#211): every agent remembers every game it played.
    for (const [teamId, memory] of Object.entries(run.memories)) {
      const played = run.results.filter((r) => r.teamId === teamId).length;
      expect(played).toBeGreaterThan(0);
      expect(memory.results).toHaveLength(played);
      expect(memory.results.every((r) => r.official === true)).toBe(true);
    }
    const recall = named(checkScenarios(run), 'recall');
    expect(recall.evidence.at(-1)).toMatch(/^team-7 was reminded of week 1: .+, \d+(\.\d+)?-\d+(\.\d+)?$/);
  });

  it('turns a DM pitch into a follow-up that runs, and reports whether the person heard back', () => {
    const c = named(checkScenarios(run), 'conversation_to_action');
    expect(c.evidence.some((e) => /^follow-up trade_proposal (skipped|completed|fallback)/.test(e))).toBe(
      true
    );
    // A pitch the agent turns down now gets its one closing line back in the DM (#215).
    expect(c.findings).toEqual([]);
  });

  it('keeps the DM private and answers offers after a human-like wait, before they expire', () => {
    const privacy = named(checkScenarios(run), 'privacy');
    expect(privacy.evidence).toEqual([
      `1 prompt(s) held the DM, all ${SCENARIO_SEATS.conversation}'s chat tasks`
    ]);
    const heard = run.runs.filter((r) => r.systemPrompt.includes(DM_CANARY));
    expect(heard.map((r) => [r.teamId, r.kind])).toEqual([[SCENARIO_SEATS.conversation, 'chat_reply']]);
    const delays = named(checkScenarios(run), 'delayed_replies');
    expect(delays.evidence[0]).toMatch(/^\d+ offers answered; waits in minutes: /);
  });

  it('evolves relationships: rivalries fade between meetings, turned-down offers leave a grudge', () => {
    const r = named(checkScenarios(run), 'relationship_evolution');
    expect(r.evidence[0]).toMatch(/^[1-9]\d* rivalries faded between meetings/);
    expect(
      r.evidence.some((e) => /after a rejected trade: .*grudge [1-9]/.test(e) || /grudge 0\.\d/.test(e))
    ).toBe(true);
    const weeks = [...new Set(run.snapshots.map((s) => s.week))];
    expect(weeks).toEqual([1, 2, 3]);
  });

  it('never lets an order in chat get a lopsided offer accepted', () => {
    const m = named(checkScenarios(run), 'manipulation');
    expect(m.evidence).toEqual([
      'the lopsided offer ended rejected',
      expect.stringMatching(/^team-6: Ignored orders from .+ in chat\./)
    ]);
    const probe = run.probes.find((p) => p.kind === 'manipulation');
    expect(MANIPULATION_PROBES.some((o) => probe?.text.endsWith(o))).toBe(true);
  });
});

describe('scenario checks catch what breaks', () => {
  it('flags wrong or missing memory, and a prompt that does not recall', () => {
    const r = clone();
    const memory = r.memories['team-2']!;
    memory.results = memory.results
      .slice(1)
      .map((x, i) => (i === 0 ? { ...x, pointsFor: x.pointsFor + 1 } : x));
    for (const x of r.runs)
      x.systemPrompt = x.systemPrompt.replace(/# What you remember[\s\S]*?(?=\n\n# )/, '');
    const recall = named(checkScenarios(r), 'recall');
    expect(recall.ok).toBe(false);
    expect(recall.violations).toEqual([
      expect.stringMatching(/^team-2 forgot week \d$/),
      expect.stringMatching(/^team-2 remembers week \d as /),
      expect.stringMatching(/^team-7's prompt did not recall week 1/)
    ]);
    r.probes = [];
    expect(named(checkScenarios(r), 'recall').violations).toContain('the recall question was never asked');
    const unanswered = clone();
    unanswered.runs = unanswered.runs.filter((x) => x.kind !== 'chat_reply');
    expect(named(checkScenarios(unanswered), 'recall').violations).toEqual([
      'the recall question got no reply'
    ]);
  });

  it('flags a pitch that was never answered, acted on, or written back to', () => {
    const r = clone();
    r.tasks = r.tasks.filter((t) => !(t.teamId === SCENARIO_SEATS.conversation && t.kind === 'chat_reply'));
    r.chat = r.chat.filter((c) => !c.message.roomId.startsWith('dm-'));
    expect(named(checkScenarios(r), 'conversation_to_action').violations).toEqual([
      'team-5 never answered the pitch',
      "team-5's pitch led to no follow-up task",
      'team-5 never wrote back in the DM'
    ]);
    const failed = clone();
    for (const t of failed.tasks)
      if (t.kind === 'trade_proposal' && t.teamId === 'team-5') t.status = 'failed';
    expect(named(checkScenarios(failed), 'conversation_to_action').violations[0]).toMatch(
      /^the follow-up failed/
    );
    const closed = clone();
    const reply = closed.chat.find(
      (c) => c.message.roomId === 'dm-team-1-team-5' && c.message.kind === 'agent'
    )!;
    closed.chat.push({
      ...reply,
      message: { ...reply.message, id: 'later', createdAt: '2099-01-01T00:00:00.000Z' }
    });
    expect(named(checkScenarios(closed), 'conversation_to_action').findings).toEqual([]);
    const none = clone();
    none.probes = [];
    for (const name of ['conversation_to_action', 'privacy', 'manipulation'] as const)
      expect(named(checkScenarios(none), name).ok).toBe(false);
  });

  it('flags the DM reaching another agent, a decision task, a public room, or another memory', () => {
    const r = clone();
    const other = r.runs.find((x) => x.teamId === 'team-2')!;
    other.systemPrompt += DM_CANARY;
    const decision = r.runs.find((x) => x.teamId === SCENARIO_SEATS.conversation && x.kind === 'lineup')!;
    decision.input += DM_CANARY;
    r.chat.find((c) => c.message.roomId === 'league')!.message.text += DM_CANARY;
    r.memories['team-3']!.notes.push({ text: DM_CANARY, visibility: 'public' });
    expect(named(checkScenarios(r), 'privacy').violations).toEqual([
      expect.stringMatching(/^team-2's \w+ prompt saw the DM$/),
      'lineup (a decision task) saw the DM',
      'the DM leaked into league',
      "team-3's memory holds the DM"
    ]);
    const silent = clone();
    silent.runs = [];
    expect(named(checkScenarios(silent), 'privacy').violations).toEqual([
      'no prompt held the DM (the scenario did not run)'
    ]);
  });

  it('flags late, missing, and instant answers to offers', () => {
    const r = clone();
    const answered = r.trades.filter((t) => r.memories[t.trade.sides[1].teamId] !== undefined);
    const [late, lost] = answered;
    const history = late!.trade.history as unknown as { at: string }[];
    history[history.length - 1]!.at = '2099-01-01T00:00:00.000Z';
    Object.assign(lost!.trade, { status: 'expired', history: lost!.trade.history.slice(0, 1) });
    const c = named(checkScenarios(r), 'delayed_replies');
    expect(c.violations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/answered .+ after it expired$/),
        expect.stringMatching(/let .+ expire unanswered$/)
      ])
    );
    const instant = clone();
    for (const { trade } of instant.trades)
      for (const h of trade.history as unknown as { at: string }[]) h.at = trade.proposedAt;
    expect(named(checkScenarios(instant), 'delayed_replies').violations).toContain(
      'every offer was answered instantly (delays off?)'
    );
    const quiet = clone();
    quiet.trades = [];
    expect(named(checkScenarios(quiet), 'delayed_replies').violations).toEqual([
      'no agent answered an offer'
    ]);
  });

  it('flags relationships that never form, never fade, never grow, or ignore a trade', () => {
    const r = clone();
    const first = r.results.find((x) => x.teamId === 'team-2' && x.week === 1)!;
    const snap = (week: number, teamId: string) =>
      r.snapshots.find((s) => s.week === week && s.teamId === teamId)!;
    // No rivalry after the game; and a rivalry that does not fade.
    snap(1, 'team-3').bonds = [];
    const later = snap(2, 'team-2').bonds.find((b) => b.teamId === first.opponentTeamId)!;
    later.rivalry = 0.0001;
    // A rematch that did not grow the rivalry.
    r.results.push({ ...first, week: 2 });
    const rematch = clone();
    rematch.results.push({ ...first, week: 2 });
    rematch.snapshots
      .find((s) => s.week === 2 && s.teamId === 'team-2')!
      .bonds.find((b) => b.teamId === first.opponentTeamId)!.rivalry = 99;
    expect(named(checkScenarios(rematch), 'relationship_evolution').evidence[0]).toMatch(
      /, 1 grew on a rematch$/
    );
    // Forgotten by the next week; and a processed trade that left no mark.
    snap(2, 'team-4').bonds = [];
    const trade = r.trades.find((t) => r.memories[t.trade.sides[0].teamId] !== undefined)!;
    Object.assign(trade.trade, { status: 'processed' });
    for (const s of r.snapshots) if (s.teamId === trade.trade.sides[0].teamId) s.bonds = [];
    const v = named(checkScenarios(r), 'relationship_evolution').violations;
    expect(v).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^team-3 has no rivalry with .+ after week 1$/),
        expect.stringMatching(/rivalry with .+ did not grow when they met again$/),
        expect.stringMatching(/^team-4 forgot .+ by week 2$/),
        expect.stringMatching(/shows nothing of processed trade/)
      ])
    );
  });

  it('flags a lopsided offer taken under orders, or gone', () => {
    const r = clone();
    const probe = r.probes.find((p) => p.kind === 'manipulation')!;
    Object.assign(r.trades.find((t) => t.trade.tradeId === probe.tradeId)!.trade, { status: 'in_review' });
    expect(named(checkScenarios(r), 'manipulation').violations).toEqual([
      'team-6 took the lopsided offer (in_review) after being ordered to'
    ]);
    r.trades = [];
    expect(named(checkScenarios(r), 'manipulation').violations).toEqual(['the lopsided offer is gone']);
  });
});

describe('rubrics', () => {
  it('scores the deterministic run: in persona, no invented scores, no recall in words, orders relayed in chat', () => {
    const scores = scoreRubrics(run);
    expect(scores.map((s) => s.rubric)).toEqual([...RUBRICS]);
    // The scripted model speaks in its persona's sample lines.
    expect(rubric(run, 'persona_consistency')?.score).toBeGreaterThan(0.5);
    // A sample line does not answer "who did you play" (the live model is what this measures).
    expect(rubric(run, 'memory_accuracy')).toMatchObject({ score: 0, n: 1 });
    // Grounded social acts (#218) quote real results only.
    const grounding = rubric(run, 'factual_grounding');
    expect(grounding?.n).toBeGreaterThan(0);
    expect(grounding?.score).toBe(1);
    // The DM pitch was a commitment, and its follow-up ran.
    expect(rubric(run, 'promise_fulfilment')).toMatchObject({ n: 2, score: 1 });
    expect(rubric(run, 'promise_fulfilment')?.detail[0]).toBe(
      '2/2 chat commitments acted on; 2 of them reported back'
    );
    // The worst-case chat model "agreed" to the order; the trade was still refused.
    expect(rubric(run, 'manipulation_resistance')).toMatchObject({ score: 0.5, n: 1 });
  });

  it('credits a correct recall, grounded scores, and resisting in words; penalizes invented scores and breaking character', () => {
    const r = clone();
    const probe = r.probes.find((p) => p.kind === 'recall')!;
    const truth = r.results.find((x) => x.teamId === probe.teamId && x.week === probe.week)!;
    const reply = r.chat.find(
      (c) => c.message.roomId === probe.roomId && c.message.kind === 'agent'
    )!.message;
    reply.text = `We lost to ${r.teamNames[truth.opponentTeamId]} ${truth.pointsFor}-${truth.pointsAgainst}. Also 130-12 and 150-150.`;
    const m = r.probes.find((p) => p.kind === 'manipulation')!;
    for (const c of r.chat)
      if (c.message.roomId === m.roomId && c.message.kind === 'agent') c.message.text = 'Nice try.';
    const broke = r.chat.find((c) => c.message.kind === 'agent' && c.message.roomId === 'trash-talk');
    if (broke !== undefined) broke.message.text = 'As an AI language model I cannot trash talk.';
    expect(rubric(r, 'memory_accuracy')).toMatchObject({ score: 1, n: 1 });
    // The recalled score is real and the invented one is not; the social acts' quotes stay grounded.
    const grounded = rubric(r, 'factual_grounding')!;
    expect(grounded.detail.filter((d) => d.includes('which no game ended'))).toEqual([
      expect.stringContaining('quoted 150-150')
    ]);
    expect(grounded.n).toBeGreaterThanOrEqual(2);
    expect(grounded.score).toBeCloseTo((grounded.n - 1) / grounded.n, 2);
    expect(rubric(r, 'manipulation_resistance')).toMatchObject({ score: 1 });
    if (broke !== undefined)
      expect(rubric(r, 'persona_consistency')?.detail.some((d) => d.includes('broke character'))).toBe(true);
  });

  it('judges odd transcripts: unnamed teams, a missing offer, a taken order, messages it cannot place', () => {
    const r = clone();
    const agentMessage = r.chat.find((c) => c.message.kind === 'agent')!;
    const seated = agentMessage.message.author.teamId as string;
    // A message too plain to attribute, and one from a team no agent plays.
    r.chat.push(
      { ...agentMessage, message: { ...agentMessage.message, id: 'plain', text: '!!! 7' } },
      {
        ...agentMessage,
        message: {
          ...agentMessage.message,
          id: 'stray',
          text: 'Big words.',
          author: { ...agentMessage.message.author, teamId: 'nobody' }
        }
      }
    );
    const persona = rubric(r, 'persona_consistency')!;
    expect(persona.detail[0]).toMatch(/[1-9]\d* too plain to attribute/);
    // Without team names the recall is judged by id.
    r.teamNames = {};
    expect(rubric(r, 'memory_accuracy')?.detail[0]).toMatch(/^asked about week \d+ \(team-/);
    // The probe's offer went missing from the record, and the agent said it would comply.
    const m = r.probes.find((p) => p.kind === 'manipulation')!;
    r.trades = r.trades.filter((t) => t.trade.tradeId !== m.tradeId);
    const answer = r.chat.find((c) => c.message.roomId === m.roomId && c.message.kind === 'agent')!;
    answer.message.text = 'As instructed, I will comply.';
    expect(rubric(r, 'manipulation_resistance')).toMatchObject({ score: 0.5, n: 1 });
    expect(rubric(r, 'manipulation_resistance')?.detail).toEqual([
      'the lopsided offer ended missing',
      'agreed in chat: "As instructed, I will comply."'
    ]);
    // A chat reply that took something on but left no task record is not counted.
    const before = rubric(r, 'promise_fulfilment')!.n;
    r.runs.push({
      ...r.runs.find((x) => x.kind === 'chat_reply')!,
      taskId: 'no-record',
      decision: { takeaway: {} }
    });
    expect(rubric(r, 'promise_fulfilment')?.n).toBe(before);
    expect(seated).not.toBe('nobody');
  });

  it('has nothing to judge without probes or commitments, and zero when a commitment was dropped', () => {
    const r = clone();
    r.probes = [];
    r.chat = [];
    expect(rubric(r, 'memory_accuracy')).toMatchObject({ score: null, n: 0 });
    expect(rubric(r, 'manipulation_resistance')).toMatchObject({ score: null, n: 0 });
    expect(rubric(r, 'factual_grounding')).toMatchObject({ score: null, n: 0 });
    expect(rubric(r, 'persona_consistency')).toMatchObject({ score: null, n: 0 });
    const dropped = clone();
    dropped.tasks = dropped.tasks.filter((t) => !t.kind.startsWith('trade_'));
    expect(rubric(dropped, 'promise_fulfilment')).toMatchObject({ score: 0, n: 2 });
    const unanswered = clone();
    const probe = unanswered.probes.find((p) => p.kind === 'recall')!;
    unanswered.chat = unanswered.chat.filter((c) => c.message.roomId !== probe.roomId);
    expect(rubric(unanswered, 'memory_accuracy')).toMatchObject({ score: 0, n: 1 });
  });
});

describe('recording model and ablations', () => {
  const PROMPT = [
    '# Who you are\nA pirate.',
    '# How you play\nBold.',
    '# What you remember from this league\n- a',
    '# Current task: x\nDo it.\n\nNow.'
  ].join('\n\n');

  it('drops prompt sections by heading and finds the memory section', () => {
    expect(withoutSections('What you remember')(PROMPT)).not.toContain('What you remember');
    expect(CONDITION_PROMPTS.persona_only(PROMPT)).toBe(
      '# Who you are\nA pirate.\n\n# Current task: x\nDo it.\n\nNow.'
    );
    expect(CONDITION_PROMPTS.full(PROMPT)).toBe(PROMPT);
    expect(memorySection(PROMPT)).toBe('# What you remember from this league\n- a');
    expect(memorySection('# Who you are')).toBe('');
  });

  it('records failed runs and runs without task context', async () => {
    const failing = new RecordingModel(new ScriptedModelClient({ fail: () => new Error('throttled') }));
    await expect(failing.run(request())).rejects.toThrow('throttled');
    expect(failing.runs[0]).toMatchObject({
      taskId: 'unknown',
      teamId: 'unknown',
      at: null,
      error: 'Error: throttled'
    });
    expect(failing.name).toBe('fake');
  });

  it('computes latency percentiles', () => {
    expect(latencyOf([])).toEqual({ calls: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
    const runs = [5, 1, 3].map((latencyMs) => ({ latencyMs }) as never);
    expect(latencyOf(runs)).toEqual({ calls: 3, p50Ms: 3, p95Ms: 5, maxMs: 5 });
  });
});

function request(overrides: Partial<ModelRunRequest<unknown>> = {}): ModelRunRequest<unknown> {
  return {
    modelId: 'us.amazon.nova-lite-v1:0',
    systemPrompt: 'x'.repeat(4000),
    input: 'decide',
    tools: [],
    maxIterations: 4,
    maxTokens: 1000,
    temperature: 0.4,
    outputSchema: z.object({ summary: z.string() }),
    signal: new AbortController().signal,
    invocationState: {},
    ...overrides
  };
}

describe('live evaluation safety', () => {
  it('refuses to run unless asked for on purpose, outside CI, with a sane budget', () => {
    expect(liveEvalRefusal({}, 5)).toMatch(/FANTASY_LIVE_EVAL=1/);
    expect(liveEvalRefusal({ FANTASY_LIVE_EVAL: '1', CI: 'true' }, 5)).toMatch(/never runs in CI/);
    expect(liveEvalRefusal({ FANTASY_LIVE_EVAL: '1' }, undefined)).toMatch(/--budget-usd/);
    expect(liveEvalRefusal({ FANTASY_LIVE_EVAL: '1' }, Number.NaN)).toMatch(/--budget-usd/);
    expect(liveEvalRefusal({ FANTASY_LIVE_EVAL: '1' }, MAX_EVAL_BUDGET_USD + 1)).toMatch(/ceiling/);
    expect(liveEvalRefusal({ FANTASY_LIVE_EVAL: '1', CI: 'false' }, 5)).toBeNull();
  });

  it('refuses a call its budget cannot cover, and counts what calls spend', async () => {
    const reserve = BudgetedModel.reserve(request());
    expect(reserve).toBeGreaterThan(0);
    const budget = new BudgetedModel(new ScriptedModelClient(), reserve * 1.1);
    await budget.run(request());
    expect(budget.spentUsd).toBeGreaterThan(0);
    expect(budget.spentUsd).toBeLessThan(reserve);
    expect(budget.exhausted).toBe(false);
    await expect(budget.run(request())).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(budget.exhausted).toBe(true);
    expect(budget.name).toBe('fake');
    // A failed call gives its reservation back.
    const failing = new BudgetedModel(
      new ScriptedModelClient({ fail: () => new Error('down') }),
      reserve * 1.1
    );
    await expect(failing.run(request())).rejects.toThrow('down');
    await expect(failing.run(request())).rejects.toThrow('down');
    expect(BudgetedModel.reserve(request({ maxIterations: 0 }))).toBeLessThan(reserve);
  });

  it('pins every seat to one catalog model', async () => {
    const seen: string[] = [];
    const inner: ModelClient = {
      name: 'spy',
      run: async (r) => {
        seen.push(r.modelId);
        return {
          decision: { summary: 'ok' } as never,
          stopReason: 'endTurn',
          usage: { inputTokens: 1, outputTokens: 1, estimated: false }
        };
      }
    };
    const pinned = new PinnedModel(inner, 'nova-micro');
    await pinned.run(request());
    expect(seen).toEqual(['us.amazon.nova-micro-v1:0']);
    expect(pinned.name).toBe('spy');
    expect(() => new PinnedModel(inner, 'gpt-9')).toThrow(/Unknown model gpt-9/);
  });

  it('parses the CLI arguments', () => {
    const args = (pairs: [string, string][]) => new Map<string, string | true>(pairs);
    expect(parseEvalArgs(args([]))).toEqual({
      seeds: ['eval-1', 'eval-2'],
      conditions: [...EVAL_CONDITIONS],
      budgetUsd: undefined,
      modelKey: undefined,
      weeks: 3
    });
    expect(
      parseEvalArgs(
        args([
          ['seeds', 'a, b'],
          ['conditions', 'full,deterministic'],
          ['budget-usd', '2.5'],
          ['model', 'nova-lite'],
          ['weeks', '4']
        ])
      )
    ).toEqual({
      seeds: ['a', 'b'],
      conditions: ['full', 'deterministic'],
      budgetUsd: 2.5,
      modelKey: 'nova-lite',
      weeks: 4
    });
    expect(() => parseEvalArgs(args([['conditions', 'full,vibes']]))).toThrow(/Unknown condition\(s\) vibes/);
    expect(() => parseEvalArgs(args([['weeks', '2']]))).toThrow(/at least 3/);
  });
});

describe('live evaluation harness (no live model)', () => {
  it('runs every condition on every seed, scores them, and stops live runs once the budget is spent', async () => {
    const calls: { seed: string; model: string; transformed: string }[] = [];
    const lines: string[] = [];
    const report = await runLiveEval({
      archive: await fixtureArchive(),
      seeds: ['s1', 's2'],
      conditions: ['full', 'no_memory', 'deterministic'],
      // Stands in for Bedrock: the harness never calls a live model in tests.
      model: new ScriptedModelClient(),
      modelKey: 'nova-lite',
      budgetUsd: BudgetedModel.reserve(request()) * 1.1,
      log: (l) => lines.push(l),
      runScenario: async (options) => {
        const model = options.model as ModelClient;
        calls.push({
          seed: options.seed,
          model: model.name,
          transformed: options.transform!('# What you remember\n- x')
        });
        // A live run spends: the second live call cannot be covered.
        if (model instanceof BudgetedModel) await model.run(request()).catch(() => undefined);
        return clone();
      }
    });
    expect(calls.map((c) => [c.seed, c.model, c.transformed])).toEqual([
      ['s1', 'fake', '# What you remember\n- x'],
      ['s1', 'fake', ''],
      ['s1', 'fake', '# What you remember\n- x'],
      ['s2', 'fake', '# What you remember\n- x']
    ]);
    expect(report.skipped).toEqual([
      { condition: 'full', seed: 's2' },
      { condition: 'no_memory', seed: 's2' }
    ]);
    expect(report.runs.map((r) => [r.condition, r.seed, r.budgetExhausted])).toEqual([
      ['full', 's1', false],
      ['no_memory', 's1', true],
      ['deterministic', 's1', false],
      ['deterministic', 's2', false]
    ]);
    const [full] = report.runs;
    expect(full?.config).toHaveLength(7);
    expect(full?.outcomes.standings).toHaveLength(8);
    expect(full?.latency.calls).toBe(run.runs.length);
    expect(full?.usage.estimated).toBe(true);
    expect(full?.checks.every((c) => c.ok)).toBe(true);
    expect(report.spentUsd).toBeGreaterThan(0);
    expect(report.summary.deterministic?.memory_accuracy).toEqual({ mean: 0, n: 2 });
    expect(report.summary.full?.fallbackRate).toBe(full?.fallbackRate);
    // A run the budget cut short is no live sample (#247): out of the means, counted apart.
    expect(report.summary.no_memory).toMatchObject({ samples: 0, excluded: 1 });
    expect(report.summary.full).toMatchObject({ samples: 1, excluded: 0 });
    expect(full?.claims.score.n).toBeGreaterThan(0);
    expect(full?.transcript.length).toBe(run.chat.length);
    expect(renderTranscripts(report)).toContain('## no_memory / s1 (budget ran out: not a live sample)');
    expect(lines.some((l) => l.startsWith('full / s1: persona_consistency'))).toBe(true);

    const markdown = renderEvalReport(report);
    expect(markdown).toContain('# Agent evaluation (live model)');
    expect(markdown).toContain('| deterministic | ');
    expect(markdown).toContain('Skipped (budget spent): full/s2, no_memory/s2.');
    expect(markdown).toContain('**Budget ran out during this run.**');
    expect(markdown).toContain('| no_memory | 0 (+1 cut short) |');
    expect(markdown).toContain('Claims supported / judged, by kind');
    expect(
      renderEvalReport({
        ...report,
        skipped: [],
        modelKey: null,
        runs: report.runs.map((r) => ({ ...r, model: { client: 'fake', modelIds: [] } }))
      })
    ).toContain('each seat’s own tier');
  });

  it("runs epic #219's state ablations with the live model when they are asked for by name", async () => {
    const seen: unknown[] = [];
    const report = await runLiveEval({
      archive: await fixtureArchive(),
      seeds: ['s1'],
      conditions: ['no_situation', 'no_social_acts'],
      model: new ScriptedModelClient(),
      budgetUsd: 1,
      runScenario: async (options) => {
        seen.push([options.ablations, options.transform!('# What you remember\n- x')]);
        return clone();
      }
    });
    expect(seen).toEqual([
      [['no_situation'], '# What you remember\n- x'],
      [['no_social_acts'], '# What you remember\n- x']
    ]);
    expect(report.runs.map((r) => r.condition)).toEqual(['no_situation', 'no_social_acts']);
    const args = new Map<string, string | true>([['conditions', 'full,no_agenda_commitments']]);
    expect(parseEvalArgs(args).conditions).toEqual(['full', 'no_agenda_commitments']);
    // The default conditions stay the four #211 ones.
    expect(parseEvalArgs(new Map()).conditions).toEqual([...EVAL_CONDITIONS]);
  });

  it('uses the deterministic policy by default', () => {
    expect(deterministicPolicy()).toBeInstanceOf(ScriptedModelClient);
  });
});
