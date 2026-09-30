import { AGENT_ABLATIONS, ScriptedModelClient, type AgentAblation, type ModelClient } from '@fantasy/agents';
import type { SimArchive } from '../archive/format.js';
import { withoutSections, type ModelRun, type PromptTransform } from '../scenarios/recording-model.js';
import {
  checkScenarios,
  runSeasonScenario,
  type ScenarioCheck,
  type ScenarioOptions,
  type ScenarioRun
} from '../scenarios/season-scenarios.js';
import { BudgetedModel, PinnedModel } from './budget.js';
import { CLAIM_KINDS, checkClaims, tallyClaims, type ClaimKind, type ClaimTally } from './claims.js';
import { RUBRICS, ledgerOf, scoreRubrics, type RubricName, type RubricScore } from './rubrics.js';

/**
 * The opt-in live-model evaluation (#211): the season scenario run with a real model under matched
 * conditions and several seeds, scored against the rubrics, next to ablations:
 *
 * - `full`: the live model with everything production gives it;
 * - `no_memory`: the live model without its league memory (the prompt's memory section removed);
 * - `persona_only`: the live model with its persona but no memory and no strategy or difficulty
 *   guidance ("How you play" removed);
 * - `deterministic`: no model at all, the scripted policy every task falls back to.
 *
 * Every live call goes through one `BudgetedModel`, so the whole evaluation stays under its cap;
 * a run the budget cut short is marked. The CLI (`src/cli/eval.ts`) refuses to start without
 * `FANTASY_LIVE_EVAL=1` and `--budget-usd` (`liveEvalRefusal`), and nothing in the test suite calls
 * a live model: docs/agent-eval.md.
 */

export const EVAL_CONDITIONS = ['full', 'no_memory', 'persona_only', 'deterministic'] as const;
/**
 * Epic #219's runtime ablations (`@fantasy/agents` ablations.ts): the live model with one part of
 * the managers' new state switched off. Opt-in by name (`--conditions no_situation,...`); the
 * default conditions are still the four above. Their offline twin is `eval/baseline.ts`.
 */
export const STATE_CONDITIONS = AGENT_ABLATIONS;
export type EvalCondition = (typeof EVAL_CONDITIONS)[number] | AgentAblation;

const identity: PromptTransform = (p) => p;

/** How each condition changes the prompt (a state ablation changes the runtime instead). */
export const CONDITION_PROMPTS: Readonly<Record<EvalCondition, PromptTransform>> = {
  full: identity,
  no_memory: withoutSections('What you remember'),
  persona_only: withoutSections('What you remember', 'How you play'),
  deterministic: identity,
  ...(Object.fromEntries(STATE_CONDITIONS.map((c) => [c, identity])) as Record<
    AgentAblation,
    PromptTransform
  >)
};

const isStateCondition = (c: EvalCondition): c is AgentAblation =>
  (STATE_CONDITIONS as readonly string[]).includes(c);

export interface LiveEvalOptions {
  archive: SimArchive;
  seeds: readonly string[];
  conditions: readonly EvalCondition[];
  /** The live model (conditions other than `deterministic`). */
  model: ModelClient;
  /** Play every seat on this catalog model (matched conditions); seats keep their own tiers when omitted. */
  modelKey?: string;
  /** The hard cap for the whole evaluation, in dollars. */
  budgetUsd: number;
  weeks?: number;
  log?: (line: string) => void;
  /** The scenario runner (tests pass a stand-in; the real one replays the season). */
  runScenario?: (options: ScenarioOptions) => Promise<ScenarioRun>;
}

export interface Latency {
  calls: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface EvalRunResult {
  condition: EvalCondition;
  seed: string;
  /** The model client and the Bedrock ids the runs used. */
  model: { client: string; modelIds: string[] };
  /** Each agent seat's configuration (matched across conditions by the seed). */
  config: { teamId: string; personalityId: string; difficulty: string; archetype: string }[];
  outcomes: {
    champion: string | null;
    standings: { teamId: string; wins: number; losses: number; pointsFor: number }[];
    tasksByStatus: Record<string, number>;
    tradesProcessed: number;
    violations: number;
  };
  /** Tasks the deterministic fallback decided, over all tasks that ran. */
  fallbackRate: number;
  modelErrors: number;
  latency: Latency;
  usage: { inputTokens: number; outputTokens: number; estimated: boolean; costUsd: number };
  rubrics: RubricScore[];
  /** Claim-level fidelity (#247, claims.ts): per kind, how many were judged, supported, and wrong. */
  claims: Record<ClaimKind, ClaimTally>;
  /** Every chat line of the run, oldest first, for human review (`[time] room author: text`). */
  transcript: string[];
  /** The scenario's hard checks, as observed (a live model may fail them). */
  checks: ScenarioCheck[];
  /** The budget ran out during this run: its later tasks fell back. */
  budgetExhausted: boolean;
}

export interface EvalReport {
  seeds: string[];
  conditions: EvalCondition[];
  weeks: number;
  budgetUsd: number;
  spentUsd: number;
  modelKey: string | null;
  runs: EvalRunResult[];
  /** Runs not started because the budget was already spent. */
  skipped: { condition: EvalCondition; seed: string }[];
  /**
   * Per condition: each rubric's mean over the completed runs (null when never judged), with its
   * total n; `samples` counts those runs, and `excluded` the runs the budget cut short (#247: a
   * truncated run never counts as a live sample).
   */
  summary: Record<
    string,
    Record<RubricName, { mean: number | null; n: number }> & {
      fallbackRate: number;
      samples: number;
      excluded: number;
      claims: Record<ClaimKind, { n: number; supported: number }>;
    }
  >;
}

export function latencyOf(runs: readonly ModelRun[]): Latency {
  const ms = runs.map((r) => r.latencyMs).sort((a, b) => a - b);
  const at = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? 0;
  return { calls: ms.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: ms.at(-1) ?? 0 };
}

function summarize(
  run: ScenarioRun,
  condition: EvalCondition,
  seed: string,
  client: string,
  exhausted: boolean
): EvalRunResult {
  const { report } = run;
  const totals = report.agents.totals;
  const ran = totals.tasks - (totals.byStatus.skipped ?? 0);
  return {
    condition,
    seed,
    model: { client, modelIds: [...new Set(run.runs.map((r) => r.modelId))].sort() },
    config: report.teams.flatMap((t) => (t.agent === null ? [] : [{ teamId: t.id, ...t.agent }])),
    outcomes: {
      champion: report.champion,
      standings: report.standings.map((s) => ({
        teamId: s.teamId,
        wins: s.wins,
        losses: s.losses,
        pointsFor: s.pointsFor
      })),
      tasksByStatus: totals.byStatus,
      tradesProcessed: run.trades.filter((t) => t.trade.status === 'processed').length,
      violations: report.violations.length
    },
    fallbackRate: ran === 0 ? 0 : Math.round(((totals.byStatus.fallback ?? 0) / ran) * 1000) / 1000,
    modelErrors: run.runs.filter((r) => r.error !== null).length,
    latency: latencyOf(run.runs),
    usage: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      estimated: run.runs.some((r) => r.usage?.estimated !== false),
      costUsd: totals.costUsd
    },
    rubrics: scoreRubrics(run),
    claims: tallyClaims(checkClaims(ledgerOf(run))),
    transcript: [...run.chat]
      .map((c) => c.message)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(
        (m) =>
          `[${m.createdAt.slice(5, 16)}] ${m.roomId} ${m.author.name} (${m.kind}${m.author.teamId === null ? '' : `, ${m.author.teamId}`}): ${m.text}`
      ),
    checks: checkScenarios(run),
    budgetExhausted: exhausted
  };
}

function summaryOf(runs: readonly EvalRunResult[]): EvalReport['summary'] {
  const out: EvalReport['summary'] = {};
  for (const condition of new Set(runs.map((r) => r.condition))) {
    const all = runs.filter((r) => r.condition === condition);
    // A run the budget cut short fell back part way: it is not a sample of the live model.
    const mine = all.filter((r) => !r.budgetExhausted);
    const rubrics = Object.fromEntries(
      RUBRICS.map((name) => {
        const scored = mine.flatMap((r) => r.rubrics.filter((s) => s.rubric === name && s.score !== null));
        const n = scored.reduce((a, s) => a + s.n, 0);
        const mean =
          scored.length === 0
            ? null
            : Math.round((scored.reduce((a, s) => a + (s.score as number), 0) / scored.length) * 1000) / 1000;
        return [name, { mean, n }];
      })
    ) as Record<RubricName, { mean: number | null; n: number }>;
    const fallbackRate =
      mine.length === 0
        ? 0
        : Math.round((mine.reduce((a, r) => a + r.fallbackRate, 0) / mine.length) * 1000) / 1000;
    const claims = Object.fromEntries(
      CLAIM_KINDS.map((k) => [
        k,
        {
          n: mine.reduce((a, r) => a + r.claims[k].n, 0),
          supported: mine.reduce((a, r) => a + r.claims[k].supported, 0)
        }
      ])
    ) as Record<ClaimKind, { n: number; supported: number }>;
    out[condition] = {
      ...rubrics,
      fallbackRate,
      samples: mine.length,
      excluded: all.length - mine.length,
      claims
    };
  }
  return out;
}

/** Runs every condition on every seed (seeds outer, so a budget cut leaves matched pairs), and scores them. */
export async function runLiveEval(options: LiveEvalOptions): Promise<EvalReport> {
  const runScenario = options.runScenario ?? runSeasonScenario;
  const weeks = options.weeks ?? 3;
  const pinned =
    options.modelKey === undefined ? options.model : new PinnedModel(options.model, options.modelKey);
  const budget = new BudgetedModel(pinned, options.budgetUsd);
  const runs: EvalRunResult[] = [];
  const skipped: EvalReport['skipped'] = [];
  for (const seed of options.seeds) {
    for (const condition of options.conditions) {
      const live = condition !== 'deterministic';
      if (live && budget.exhausted) {
        skipped.push({ condition, seed });
        continue;
      }
      const refusedBefore = budget.refused;
      options.log?.(`${condition} / ${seed}: running`);
      const run = await runScenario({
        archive: options.archive,
        seed,
        weeks,
        model: live ? budget : new ScriptedModelClient(),
        transform: CONDITION_PROMPTS[condition],
        ...(isStateCondition(condition) ? { ablations: [condition] } : {})
      });
      const result = summarize(
        run,
        condition,
        seed,
        live ? budget.name : 'fake',
        budget.refused > refusedBefore
      );
      runs.push(result);
      options.log?.(
        `${condition} / ${seed}: ${result.rubrics.map((r) => `${r.rubric} ${r.score ?? '-'}`).join(', ')}; spent $${budget.spentUsd.toFixed(4)}`
      );
    }
  }
  return {
    seeds: [...options.seeds],
    conditions: [...options.conditions],
    weeks,
    budgetUsd: options.budgetUsd,
    spentUsd: Math.round(budget.spentUsd * 1_000_000) / 1_000_000,
    modelKey: options.modelKey ?? null,
    runs,
    skipped,
    summary: summaryOf(runs)
  };
}

const cell = (v: number | null) => (v === null ? '–' : v.toFixed(2));

/** Every run's chat, for human review: one section per run. */
export function renderTranscripts(report: EvalReport): string {
  const lines = ['# Agent evaluation transcripts', ''];
  for (const r of report.runs)
    lines.push(
      `## ${r.condition} / ${r.seed}${r.budgetExhausted ? ' (budget ran out: not a live sample)' : ''}`,
      '',
      ...r.transcript.map((t) => `- ${t.replace(/\n/g, ' ')}`),
      ''
    );
  return `${lines.join('\n')}\n`;
}

/** The evaluation as markdown: the summary by condition, then each run. */
export function renderEvalReport(report: EvalReport): string {
  const lines = [
    '# Agent evaluation (live model)',
    '',
    `Seeds: ${report.seeds.join(', ')}. Weeks: ${report.weeks}. Model: ${report.modelKey ?? 'each seat’s own tier'}. Budget $${report.budgetUsd}, spent $${report.spentUsd.toFixed(4)} (estimated from the catalog).`,
    '',
    'Scores are means over the completed runs (n = items judged; a run the budget cut short is excluded and counted apart). Heuristic rubrics; see docs/agent-eval.md for their limits.',
    '',
    `| Condition | Samples | ${RUBRICS.join(' | ')} | Fallback rate |`,
    `|---|---|${RUBRICS.map(() => '---').join('|')}|---|`
  ];
  for (const [condition, s] of Object.entries(report.summary)) {
    lines.push(
      `| ${condition} | ${s.samples}${s.excluded > 0 ? ` (+${s.excluded} cut short)` : ''} | ${RUBRICS.map((r) => `${cell(s[r].mean)} (n ${s[r].n})`).join(' | ')} | ${s.fallbackRate} |`
    );
  }
  lines.push(
    '',
    'Claims supported / judged, by kind (claims.ts; n = 0 means none was made, not that none would be wrong):',
    '',
    `| Condition | ${CLAIM_KINDS.join(' | ')} |`,
    `|---|${CLAIM_KINDS.map(() => '---').join('|')}|`
  );
  for (const [condition, s] of Object.entries(report.summary))
    lines.push(
      `| ${condition} | ${CLAIM_KINDS.map((k) => `${s.claims[k].supported}/${s.claims[k].n}`).join(' | ')} |`
    );
  if (report.skipped.length > 0)
    lines.push(
      '',
      `Skipped (budget spent): ${report.skipped.map((s) => `${s.condition}/${s.seed}`).join(', ')}.`
    );
  lines.push('', '## Runs', '');
  for (const r of report.runs) {
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
    lines.push(
      `- **${r.condition} / ${r.seed}** (${r.model.client}${r.model.modelIds.length > 0 ? `: ${r.model.modelIds.join(', ')}` : ''}): champion ${r.outcomes.champion ?? '–'}, fallback rate ${r.fallbackRate}, ${r.latency.calls} model calls (p50 ${r.latency.p50Ms} ms, p95 ${r.latency.p95Ms} ms), ${r.usage.inputTokens} in / ${r.usage.outputTokens} out tokens${r.usage.estimated ? ' (estimated)' : ''}, $${r.usage.costUsd}. Checks failed: ${failed.join(', ') || 'none'}.${r.budgetExhausted ? ' **Budget ran out during this run.**' : ''}`
    );
  }
  return `${lines.join('\n')}\n`;
}

/** What the CLI asks for (`--seeds a,b --conditions full,no_memory --budget-usd 5 --model nova-lite --weeks 3`). */
export interface EvalArgs {
  seeds: string[];
  conditions: EvalCondition[];
  budgetUsd: number | undefined;
  modelKey: string | undefined;
  weeks: number;
}

export function parseEvalArgs(args: Map<string, string | true>): EvalArgs {
  const list = (key: string, fallback: readonly string[]) => {
    const raw = args.get(key);
    return typeof raw === 'string'
      ? raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [...fallback];
  };
  const conditions = list('conditions', EVAL_CONDITIONS);
  const known: readonly string[] = [...EVAL_CONDITIONS, ...STATE_CONDITIONS];
  const unknown = conditions.filter((c) => !known.includes(c));
  if (unknown.length > 0)
    throw new Error(`Unknown condition(s) ${unknown.join(', ')}. Use: ${known.join(', ')}.`);
  const budget = args.get('budget-usd');
  const model = args.get('model');
  const weeks = Number(args.get('weeks') ?? 3);
  if (!Number.isInteger(weeks) || weeks < 3) throw new Error('--weeks needs a whole number of at least 3.');
  return {
    seeds: list('seeds', ['eval-1', 'eval-2']),
    conditions: conditions as EvalCondition[],
    budgetUsd: typeof budget === 'string' ? Number(budget) : undefined,
    modelKey: typeof model === 'string' ? model : undefined,
    weeks
  };
}
