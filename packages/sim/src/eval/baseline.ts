import { AGENT_ABLATIONS, type AgentAblation } from '@fantasy/agents';
import type { AgentSeatConfig } from '@fantasy/core';
import { AGENT_CHAT_BUDGETS, type TradeRecord } from '@fantasy/server';
import {
  checkAcceptance,
  choiceProfile,
  runTradeInterestScenario,
  type AcceptanceRun,
  type ChoiceProfile
} from '../acceptance/trade-interest.js';
import type { SimArchive } from '../archive/format.js';
import { runSeasonScenario, type ScenarioOptions, type ScenarioRun } from '../scenarios/season-scenarios.js';

/**
 * The epic #219 baseline (docs/evaluations/epic-219-baseline.md): the managers' new state against
 * matched runs with one part of it switched off (`@fantasy/agents` ablations), all on the scripted
 * model, offline and deterministic. Two layers:
 *
 * - **Season**: #211's season scenario (the real league, three fixture weeks, the stand-in's DM
 *   pitch, lopsided offer with orders, and recall question) for every configuration and seed,
 *   measured for roster churn, invalid actions, trade offers, message volume and cost, unanswered
 *   questions, repeated lines, duplicates, and how far archetypes differ.
 * - **Acceptance**: the trade-interest scenario (`acceptance/trade-interest.ts`) for a balanced, a
 *   cautious, and a trade-happy manager in every configuration: which checks hold, and whether
 *   the cautious and eager managers still choose differently.
 *
 * It records numbers; it sets no thresholds. The only assertions made on it (sim tests) are
 * invariants: chat stays inside its budgets, no offer or reply is duplicated, the league stays
 * clean.
 */

export const BASELINE_CONFIGS = ['full', ...AGENT_ABLATIONS] as const;
export type BaselineConfig = (typeof BASELINE_CONFIGS)[number];

/** The ablations a configuration switches on. */
export const ablationsOf = (config: BaselineConfig): AgentAblation[] => (config === 'full' ? [] : [config]);

/** Seeds for CI (each one replays a season per configuration) and the checked-in report. */
export const CI_SEEDS = ['base-1', 'base-2'] as const;
export const REPORT_SEEDS = ['base-1', 'base-2', 'base-3'] as const;

/** Faster job cadences for matched replays: live scoring every 30 minutes instead of 2. */
export const BASELINE_CADENCES = {
  ingestStats: 'rate(30 minutes)',
  scoreLiveWeek: 'rate(30 minutes)',
  syncNflState: 'rate(1 hour)'
} as const;

/** The acceptance scenario's managers: one personality, three archetypes, no valuation noise. */
export const ACCEPTANCE_MANAGERS: readonly AgentSeatConfig[] = [
  { personalityId: 'smug-veteran', difficulty: 'hall_of_famer', archetype: 'balanced' },
  { personalityId: 'smug-veteran', difficulty: 'hall_of_famer', archetype: 'analytics_only' },
  { personalityId: 'smug-veteran', difficulty: 'hall_of_famer', archetype: 'trade_happy' }
];

export interface SeasonMetrics {
  config: BaselineConfig;
  seed: string;
  agents: number;
  /** Roster churn by agents: free-agent and waiver adds, drops, and processed trades. */
  adds: number;
  drops: number;
  tradesProcessed: number;
  /** Mutations the league refused an agent (a tool call that failed). */
  invalidActions: number;
  offersSent: number;
  offersAccepted: number;
  agentMessages: number;
  /** The most one agent posted in any 24 hours, and the league's agents together. */
  maxAgentPerDay: number;
  leagueMaxPerDay: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** The stand-in's messages to agents, and those no agent ever answered. */
  questions: number;
  unansweredQuestions: number;
  /** An agent line identical to one it posted before, anywhere. */
  repeatedLines: number;
  /** The same line posted twice in answer to one message. */
  duplicateReplies: number;
  /** An agent offer made while the same swap was still open. */
  duplicateOffers: number;
  /** Invariant violations and event-loop failures. */
  violations: number;
  loopFailures: number;
  /** Per archetype: agents, and per-agent means of offers, adds, and messages. */
  byArchetype: Record<string, { agents: number; offers: number; adds: number; messages: number }>;
}

export interface AcceptanceMetrics {
  config: BaselineConfig;
  archetype: string;
  checksPassed: number;
  checksTotal: number;
  failed: string[];
  profile: ChoiceProfile;
  modelCalls: number;
  costUsd: number;
}

export interface BaselineReport {
  seeds: string[];
  weeks: number;
  configs: BaselineConfig[];
  season: SeasonMetrics[];
  acceptance: AcceptanceMetrics[];
}

export interface BaselineOptions {
  archive: SimArchive;
  seeds: readonly string[];
  configs?: readonly BaselineConfig[];
  weeks?: number;
  /** Skip the season layer (acceptance only). */
  seasons?: boolean;
  log?: (line: string) => void;
  /** Stand-ins for tests; the real ones replay the season and run the acceptance scenario. */
  runScenario?: (options: ScenarioOptions) => Promise<ScenarioRun>;
  runAcceptance?: typeof runTradeInterestScenario;
}

const OPEN_UNTIL_CLOSED = new Set(['proposed']);
const TAKEN = new Set(['accepted', 'in_review', 'processed']);

/** When a trade stopped being open: its first history step after the offer, or never. */
function closedAt(trade: TradeRecord['trade']): number {
  const end = trade.history.find((h) => !OPEN_UNTIL_CLOSED.has(h.status));
  return end === undefined ? Number.POSITIVE_INFINITY : Date.parse(end.at);
}

const swapOf = (t: TradeRecord['trade']) =>
  `${t.sides[0].teamId}:${[...t.sides[0].sends].sort().join()}>${t.sides[1].teamId}:${[...t.sides[1].sends].sort().join()}`;

/** Offers from `agents` made while the same swap from the same team was still open. */
export function duplicateOffers(trades: readonly TradeRecord[], agents: ReadonlySet<string>): number {
  const mine = trades
    .map((t) => t.trade)
    .filter((t) => agents.has(t.sides[0].teamId))
    .sort((a, b) => a.proposedAt.localeCompare(b.proposedAt));
  let n = 0;
  mine.forEach((t, i) => {
    const at = Date.parse(t.proposedAt);
    if (mine.slice(0, i).some((e) => swapOf(e) === swapOf(t) && closedAt(e) > at)) n++;
  });
  return n;
}

/** The season metrics of one run (see `SeasonMetrics`). */
export function seasonMetrics(run: ScenarioRun, config: BaselineConfig, seed: string): SeasonMetrics {
  const { report } = run;
  const seats = report.teams.filter((t) => t.agent !== null);
  const agents = new Set(seats.map((t) => t.id));
  const mineTx = report.transactions.filter((t) => agents.has(t.teamId) && t.type !== 'trade');
  const messages = run.chat
    .map((c) => c.message)
    .filter((m) => m.kind === 'agent' && m.author.teamId !== null);
  const seen = new Map<string, number>();
  let repeatedLines = 0;
  for (const m of messages) {
    const key = `${m.author.teamId}|${m.text}`;
    if ((seen.get(key) ?? 0) > 0) repeatedLines++;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const replies = new Map<string, number>();
  for (const m of messages.filter((x) => x.replyToId !== undefined)) {
    const key = `${m.author.teamId}|${m.replyToId}|${m.text}`;
    replies.set(key, (replies.get(key) ?? 0) + 1);
  }
  const offers = run.trades.map((t) => t.trade).filter((t) => agents.has(t.sides[0].teamId));
  const unanswered = run.probes.filter(
    (p) => !messages.some((m) => m.roomId === p.roomId && m.author.teamId === p.teamId && m.createdAt >= p.at)
  );
  const lines = run.tasks.flatMap((t) => t.usage);
  const byArchetype: SeasonMetrics['byArchetype'] = {};
  for (const seat of seats) {
    const a = (byArchetype[seat.agent?.archetype as string] ??= {
      agents: 0,
      offers: 0,
      adds: 0,
      messages: 0
    });
    a.agents++;
    a.offers += offers.filter((t) => t.sides[0].teamId === seat.id).length;
    a.adds += mineTx.filter((t) => t.teamId === seat.id && t.add !== null).length;
    a.messages += messages.filter((m) => m.author.teamId === seat.id).length;
  }
  for (const a of Object.values(byArchetype)) {
    a.offers = round2(a.offers / a.agents);
    a.adds = round2(a.adds / a.agents);
    a.messages = round2(a.messages / a.agents);
  }
  return {
    config,
    seed,
    agents: agents.size,
    adds: mineTx.filter((t) => t.add !== null).length,
    drops: mineTx.filter((t) => t.drop !== null).length,
    tradesProcessed: run.trades.filter((t) => t.trade.status === 'processed').length,
    invalidActions: run.tasks.flatMap((t) => t.toolsCalled).filter((c) => c.mutation && !c.ok).length,
    offersSent: offers.length,
    offersAccepted: offers.filter((t) => TAKEN.has(t.status)).length,
    agentMessages: messages.length,
    maxAgentPerDay: Math.max(0, ...Object.values(report.chat.byAgent).map((a) => a.maxPerDay)),
    leagueMaxPerDay: report.chat.leagueMaxPerDay,
    modelCalls: lines.length,
    inputTokens: lines.reduce((a, u) => a + u.inputTokens, 0),
    outputTokens: lines.reduce((a, u) => a + u.outputTokens, 0),
    costUsd: round6(lines.reduce((a, u) => a + u.estimatedCostUsd, 0)),
    questions: run.probes.length,
    unansweredQuestions: unanswered.length,
    repeatedLines,
    duplicateReplies: [...replies.values()].filter((n) => n > 1).length,
    duplicateOffers: duplicateOffers(run.trades, agents),
    violations: report.violations.length,
    loopFailures: report.events.failures.length,
    byArchetype
  };
}

export function acceptanceMetrics(run: AcceptanceRun, config: BaselineConfig): AcceptanceMetrics {
  const checks = checkAcceptance(run);
  return {
    config,
    archetype: run.config.archetype,
    checksPassed: checks.filter((c) => c.ok).length,
    checksTotal: checks.length,
    failed: checks.filter((c) => !c.ok).map((c) => c.name),
    profile: choiceProfile(run),
    modelCalls: run.usage.modelCalls,
    costUsd: run.usage.costUsd
  };
}

/** Runs every configuration on every seed (seeds outer), then the acceptance scenario per configuration. */
export async function runBaseline(options: BaselineOptions): Promise<BaselineReport> {
  const configs = [...(options.configs ?? BASELINE_CONFIGS)];
  const weeks = options.weeks ?? 3;
  const runScenario = options.runScenario ?? runSeasonScenario;
  const runAcceptance = options.runAcceptance ?? runTradeInterestScenario;
  const season: SeasonMetrics[] = [];
  if (options.seasons !== false) {
    for (const seed of options.seeds) {
      for (const config of configs) {
        options.log?.(`season ${config} / ${seed}`);
        const run = await runScenario({
          archive: options.archive,
          seed,
          weeks,
          jobCadences: BASELINE_CADENCES,
          ablations: ablationsOf(config)
        });
        season.push(seasonMetrics(run, config, seed));
      }
    }
  }
  const acceptance: AcceptanceMetrics[] = [];
  for (const config of configs) {
    for (const manager of ACCEPTANCE_MANAGERS) {
      const run = await runAcceptance({ config: manager, ablations: ablationsOf(config) });
      acceptance.push(acceptanceMetrics(run, config));
    }
  }
  return { seeds: [...options.seeds], weeks, configs, season, acceptance };
}

/** Breaches of the invariants the baseline holds in every configuration (the CI assertions). */
export function baselineInvariantBreaches(m: SeasonMetrics): string[] {
  const out: string[] = [];
  if (m.maxAgentPerDay > AGENT_CHAT_BUDGETS.agentPerDay)
    out.push(`an agent posted ${m.maxAgentPerDay} in a day (budget ${AGENT_CHAT_BUDGETS.agentPerDay})`);
  if (m.leagueMaxPerDay > AGENT_CHAT_BUDGETS.leaguePerDay)
    out.push(
      `the league's agents posted ${m.leagueMaxPerDay} in a day (budget ${AGENT_CHAT_BUDGETS.leaguePerDay})`
    );
  if (m.invalidActions > 0) out.push(`${m.invalidActions} refused agent actions`);
  if (m.duplicateOffers > 0) out.push(`${m.duplicateOffers} duplicate offers`);
  if (m.duplicateReplies > 0) out.push(`${m.duplicateReplies} duplicate replies`);
  if (m.violations > 0) out.push(`${m.violations} invariant violations`);
  if (m.loopFailures > 0) out.push(`${m.loopFailures} event-loop failures`);
  return out;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

type Numeric = Exclude<
  {
    [K in keyof SeasonMetrics]: SeasonMetrics[K] extends number ? K : never;
  }[keyof SeasonMetrics],
  undefined
>;

/** The metric tables, each a row per configuration: the mean over seeds, then each seed's value. */
export const METRIC_TABLES: readonly { title: string; metrics: readonly Numeric[] }[] = [
  { title: 'Roster churn (agents)', metrics: ['adds', 'drops', 'tradesProcessed'] },
  { title: 'Invalid action attempts', metrics: ['invalidActions'] },
  { title: 'Trade offers', metrics: ['offersSent', 'offersAccepted'] },
  {
    title: 'Message volume and cost',
    metrics: ['agentMessages', 'maxAgentPerDay', 'modelCalls', 'inputTokens', 'outputTokens', 'costUsd']
  },
  { title: 'Unanswered human questions', metrics: ['questions', 'unansweredQuestions'] },
  { title: 'Repeated or duplicate lines', metrics: ['repeatedLines', 'duplicateReplies', 'duplicateOffers'] }
];

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function fmt(x: number): string {
  if (Number.isInteger(x)) return String(x);
  return Math.abs(x) < 1 ? String(Number(x.toFixed(4))) : x.toFixed(1);
}

/** The metric's mean for a configuration, and the change from `full` (the baseline row reads "—"). */
export function metricRow(report: BaselineReport, config: BaselineConfig, metric: Numeric): string {
  const mine = report.season.filter((m) => m.config === config);
  const base = mean(report.season.filter((m) => m.config === 'full').map((m) => m[metric]));
  const value = mean(mine.map((m) => m[metric]));
  const delta = config === 'full' ? '—' : `${value - base >= 0 ? '+' : ''}${fmt(value - base)}`;
  return `${fmt(value)} (${delta}; ${mine.map((m) => fmt(m[metric])).join(' / ')})`;
}

export function renderBaselineReport(report: BaselineReport): string {
  const lines: string[] = [];
  const configs = report.configs;
  if (report.season.length > 0) {
    lines.push(
      `Season layer: #211's season scenario, ${report.weeks} fixture weeks, seeds ${report.seeds.join(', ')}, scripted model. Each cell is the mean over seeds, the change from \`full\`, then each seed's value.`,
      ''
    );
    for (const table of METRIC_TABLES) {
      lines.push(`#### ${table.title}`, '', `| Configuration | ${table.metrics.join(' | ')} |`);
      lines.push(`|---|${table.metrics.map(() => '---').join('|')}|`);
      for (const config of configs)
        lines.push(`| ${config} | ${table.metrics.map((m) => metricRow(report, config, m)).join(' | ')} |`);
      lines.push('');
    }
    lines.push(
      '#### Personality differentiation (season)',
      '',
      'Per-agent means by archetype over every seed (offers sent / adds / messages), then the agents counted.',
      '',
      '| Configuration | Archetypes |',
      '|---|---|'
    );
    for (const config of configs) {
      // Weighted by agents: a seed with two agents of an archetype counts twice.
      const merged = new Map<string, { n: number; offers: number; adds: number; messages: number }>();
      for (const m of report.season.filter((x) => x.config === config))
        for (const [archetype, a] of Object.entries(m.byArchetype)) {
          const e = merged.get(archetype) ?? { n: 0, offers: 0, adds: 0, messages: 0 };
          merged.set(archetype, {
            n: e.n + a.agents,
            offers: e.offers + a.offers * a.agents,
            adds: e.adds + a.adds * a.agents,
            messages: e.messages + a.messages * a.agents
          });
        }
      const cells = [...merged.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([k, e]) =>
            `${k} ${fmt(round2(e.offers / e.n))} / ${fmt(round2(e.adds / e.n))} / ${fmt(round2(e.messages / e.n))} (n ${e.n})`
        );
      lines.push(`| ${config} | ${cells.join('; ')} |`);
    }
    lines.push('');
  }
  lines.push(
    '#### Acceptance scenario by configuration',
    '',
    'Checks held (of 7) for the balanced, cautious (`analytics_only`), and trade-happy managers; the marginal pitch outcome and offers sent show whether the cautious and eager managers still choose differently.',
    '',
    '| Configuration | Balanced | Cautious | Trade-happy | Cautious vs trade-happy | Failed checks |',
    '|---|---|---|---|---|---|'
  );
  for (const config of configs) {
    const rows = report.acceptance.filter((a) => a.config === config);
    const of = (archetype: string) => rows.find((r) => r.archetype === archetype);
    const cell = (a: AcceptanceMetrics | undefined) =>
      a === undefined
        ? '–'
        : `${a.checksPassed}/${a.checksTotal} (${a.profile.marginal}, ${a.profile.offersSent} offers)`;
    const cautious = of('analytics_only');
    const eager = of('trade_happy');
    const differ =
      cautious !== undefined &&
      eager !== undefined &&
      (cautious.profile.marginal !== eager.profile.marginal ||
        cautious.profile.offersSent !== eager.profile.offersSent);
    const failed = [...new Set(rows.flatMap((r) => r.failed))].join(', ') || 'none';
    lines.push(
      `| ${config} | ${cell(of('balanced'))} | ${cell(cautious)} | ${cell(eager)} | ${differ ? 'differ' : 'same'} | ${failed} |`
    );
  }
  return `${lines.join('\n')}\n`;
}
