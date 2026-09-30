import { URGENCY_LEVELS, type UrgencyLevel } from '@fantasy/core';
import type { SimArchive } from '../archive/format.js';
import { runSeasonScenario, type ScenarioOptions, type ScenarioRun } from '../scenarios/season-scenarios.js';
import {
  BASELINE_CADENCES,
  ablationsOf,
  seasonMetrics,
  type BaselineConfig,
  type SeasonMetrics
} from './baseline.js';

/**
 * Longer-season calibration of situational adaptation (#217, ADR 005) and player attachments (#216,
 * ADR 006), for #248. The season scenario replays a full regular season and its playoffs from the
 * 2025 archive with the scripted model, for `full`, `no_situation`, and `no_attachments` on the
 * same seeds (model, personas, difficulty, rosters, clock, and seeds held fixed), and reports:
 *
 * - Exposure: how often each situational state and roster-pressure state was actually read by an
 *   agent task (the runner's `agent situation` log line, which the replay exposes through
 *   `observe`), per task and per agent-week, and how often the label changed. A state reading past
 *   the league's week (`throughWeek > week`) is a hindsight violation.
 * - Attachments: every premium a trade decision applied (the `agent attachment adjustment` log
 *   line), how often a pressing need waived it, and at season's end what is held, what departed,
 *   and how often results revised a conviction.
 * - Decisions and outcomes: the baseline's season metrics (churn, offers, trades, invalid
 *   attempts, messages, model calls, estimated cost), the agents' points and wins, and trade
 *   scouting against offers by archetype.
 *
 * Scripted policy only: prose and model judgment are not exercised. The numbers are for matched
 * comparison; they set no thresholds on their own.
 */

export const CALIBRATION_CONFIGS = [
  'full',
  'no_situation',
  'no_attachments'
] as const satisfies readonly BaselineConfig[];
export type CalibrationConfig = (typeof CALIBRATION_CONFIGS)[number];

/** Weeks replayed: the 2025 archive's regular season and this league's playoffs. */
export const CALIBRATION_WEEKS = 17;
export const CALIBRATION_SEEDS = ['cal-1', 'cal-2', 'cal-3', 'cal-4', 'cal-5'] as const;

export interface Exposure {
  /** Agent tasks that read a situation. */
  tasks: number;
  byUrgency: Record<UrgencyLevel, number>;
  /** Distinct agent-weeks in each state (a week counts once per state it was seen in). */
  agentWeeks: Record<UrgencyLevel, number>;
  byBasis: Record<string, number>;
  reasons: Record<string, number>;
  /** Times an agent's label changed from one task to its next. */
  transitions: number;
  /** Tasks that saw at least one position short, or thin. */
  short: number;
  thin: number;
  /** Situation reads past the league's week: must be 0. */
  hindsight: number;
}

export interface AttachmentUse {
  /** Decisions an attachment premium touched, and where. */
  adjustments: number;
  byUse: Record<string, number>;
  /** Those that raised the bar, and those where a pressing need waived it. */
  raised: number;
  overrides: number;
  meanAdjustment: number;
  /** At season's end, across agents. */
  held: number;
  departed: number;
  drafted: number;
  tradedFor: number;
  revisedDown: number;
  revisedUp: number;
  /** Held attachments whose player is not on the agent's roster: must be 0. */
  staleHeld: number;
}

export interface CalibrationRun {
  config: CalibrationConfig;
  seed: string;
  weeks: number;
  season: SeasonMetrics;
  exposure: Exposure;
  attachments: AttachmentUse;
  /** Agent teams' mean points for and wins, and whether an agent won the title. */
  outcomes: { pointsFor: number; wins: number; agentChampion: boolean };
  /** Per archetype: agents, check-ins, those that shopped for a trade, and offers the agents sent. */
  scouting: Record<string, { agents: number; checkIns: number; shopped: number; offers: number }>;
}

export interface CalibrationReport {
  seeds: string[];
  weeks: number;
  configs: CalibrationConfig[];
  runs: CalibrationRun[];
}

const zero = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const round2 = (x: number) => Math.round(x * 100) / 100;

export interface SituationLine {
  teamId: string;
  week: number | null;
  throughWeek: number | null;
  urgency: UrgencyLevel;
  basis: string;
  reasons: string[];
  pressure: string[];
}
export interface AttachmentLine {
  use: string;
  adjustment: number;
  override: boolean;
}

/** Collects the log lines the calibration reads (a cheap substring test before parsing). */
export function observer() {
  const situations: SituationLine[] = [];
  const adjustments: AttachmentLine[] = [];
  const observe = (line: string) => {
    if (line.includes('"agent situation"')) situations.push(JSON.parse(line) as SituationLine);
    else if (line.includes('"agent attachment adjustment"'))
      adjustments.push(JSON.parse(line) as AttachmentLine);
  };
  return { situations, adjustments, observe };
}

export function exposureOf(lines: readonly SituationLine[]): Exposure {
  const out: Exposure = {
    tasks: lines.length,
    byUrgency: zero(URGENCY_LEVELS),
    agentWeeks: zero(URGENCY_LEVELS),
    byBasis: {},
    reasons: {},
    transitions: 0,
    short: 0,
    thin: 0,
    hindsight: 0
  };
  const weeks = new Set<string>();
  const last = new Map<string, UrgencyLevel>();
  for (const l of lines) {
    out.byUrgency[l.urgency]++;
    const key = `${l.teamId}|${l.week}|${l.urgency}`;
    if (!weeks.has(key)) {
      weeks.add(key);
      out.agentWeeks[l.urgency]++;
    }
    out.byBasis[l.basis] = (out.byBasis[l.basis] ?? 0) + 1;
    for (const r of l.reasons) out.reasons[r] = (out.reasons[r] ?? 0) + 1;
    const before = last.get(l.teamId);
    if (before !== undefined && before !== l.urgency) out.transitions++;
    last.set(l.teamId, l.urgency);
    if (l.pressure.some((p) => p.endsWith(':short'))) out.short++;
    if (l.pressure.some((p) => p.endsWith(':thin'))) out.thin++;
    if (l.week !== null && l.throughWeek !== null && l.throughWeek > l.week) out.hindsight++;
  }
  return out;
}

export function attachmentUseOf(
  run: Pick<ScenarioRun, 'attachments' | 'rosters'>,
  lines: readonly AttachmentLine[]
): AttachmentUse {
  const byUse: Record<string, number> = {};
  for (const l of lines) byUse[l.use] = (byUse[l.use] ?? 0) + 1;
  const raised = lines.filter((l) => l.adjustment > 0);
  const prefs = Object.entries(run.attachments).flatMap(([teamId, a]) =>
    a.preferences.map((p) => ({ teamId, p }))
  );
  const held = prefs.filter((x) => x.p.status === 'held');
  return {
    adjustments: lines.length,
    byUse,
    raised: raised.length,
    overrides: lines.filter((l) => l.override).length,
    meanAdjustment:
      raised.length === 0 ? 0 : round2(raised.reduce((a, l) => a + l.adjustment, 0) / raised.length),
    held: held.length,
    departed: prefs.length - held.length,
    drafted: prefs.filter((x) => x.p.sources.some((s) => s.kind === 'drafted')).length,
    tradedFor: prefs.filter((x) => x.p.sources.some((s) => s.kind === 'traded_for')).length,
    revisedDown: prefs.reduce((a, x) => a + x.p.revisions.filter((r) => r.to < r.from).length, 0),
    revisedUp: prefs.reduce((a, x) => a + x.p.revisions.filter((r) => r.to > r.from).length, 0),
    staleHeld: held.filter((x) => !(run.rosters[x.teamId] ?? []).includes(x.p.playerId)).length
  };
}

export function scoutingOf(
  run: Pick<ScenarioRun, 'report' | 'tasks' | 'trades'>
): CalibrationRun['scouting'] {
  const out: CalibrationRun['scouting'] = {};
  for (const team of run.report.teams) {
    if (team.agent === null) continue;
    const a = (out[team.agent.archetype] ??= { agents: 0, checkIns: 0, shopped: 0, offers: 0 });
    const checkIns = run.tasks.filter((t) => t.teamId === team.id && t.kind === 'check_in');
    a.agents++;
    a.checkIns += checkIns.length;
    // A check-in that did not roll to shop says so; one that shopped offered or found nothing.
    a.shopped += checkIns.filter(
      (t) => !(t.reasoningSummary ?? '').includes('Not shopping for trades today')
    ).length;
    a.offers += run.trades.filter((t) => t.trade.sides[0].teamId === team.id).length;
  }
  return out;
}

export interface CalibrationOptions {
  archive: SimArchive;
  seeds: readonly string[];
  configs?: readonly CalibrationConfig[];
  weeks?: number;
  log?: (line: string) => void;
  runScenario?: (options: ScenarioOptions) => Promise<ScenarioRun>;
}

/** Every configuration on every seed (seeds outer), measured as the module comment says. */
export async function runCalibration(options: CalibrationOptions): Promise<CalibrationReport> {
  const configs = [...(options.configs ?? CALIBRATION_CONFIGS)];
  const weeks = options.weeks ?? CALIBRATION_WEEKS;
  const runScenario = options.runScenario ?? runSeasonScenario;
  const runs: CalibrationRun[] = [];
  for (const seed of options.seeds)
    for (const config of configs) {
      options.log?.(`calibration ${config} / ${seed}`);
      const seen = observer();
      const run = await runScenario({
        archive: options.archive,
        seed,
        weeks,
        jobCadences: BASELINE_CADENCES,
        ablations: ablationsOf(config),
        observe: seen.observe
      });
      const agents = new Set(run.report.teams.filter((t) => t.agent !== null).map((t) => t.id));
      const rows = run.report.standings.filter((s) => agents.has(s.teamId));
      runs.push({
        config,
        seed,
        weeks,
        season: seasonMetrics(run, config, seed),
        exposure: exposureOf(seen.situations),
        attachments: attachmentUseOf(run, seen.adjustments),
        outcomes: {
          pointsFor: round2(rows.reduce((a, s) => a + s.pointsFor, 0) / Math.max(1, rows.length)),
          wins: round2(rows.reduce((a, s) => a + s.wins, 0) / Math.max(1, rows.length)),
          agentChampion: run.report.champion !== null && agents.has(run.report.champion)
        },
        scouting: scoutingOf(run)
      });
    }
  return { seeds: [...options.seeds], weeks, configs, runs };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const mean = (xs: readonly number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(Math.abs(x) < 10 ? 2 : 1));
const sd = (xs: readonly number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

/**
 * A metric for a configuration: for `full`, the mean ± spread over seeds and each seed; for an
 * ablation, its mean and the matched change from `full` (seed by seed), with how many seeds went up
 * and down.
 */
export function matchedRow(
  report: CalibrationReport,
  config: CalibrationConfig,
  pick: (r: CalibrationRun) => number
): string {
  const mine = report.runs.filter((r) => r.config === config);
  const values = mine.map(pick);
  if (config === 'full') return `${fmt(mean(values))} ± ${fmt(sd(values))} (${values.map(fmt).join(' / ')})`;
  const deltas = mine.map((r) => {
    const base = report.runs.find((x) => x.config === 'full' && x.seed === r.seed);
    return base === undefined ? 0 : pick(r) - pick(base);
  });
  const up = deltas.filter((d) => d > 0).length;
  const down = deltas.filter((d) => d < 0).length;
  return `${fmt(mean(values))} (Δ ${mean(deltas) >= 0 ? '+' : ''}${fmt(mean(deltas))} ± ${fmt(sd(deltas))}; up ${up}, down ${down} of ${deltas.length})`;
}

export const CALIBRATION_METRICS: readonly [string, (r: CalibrationRun) => number][] = [
  ['Agent points for (mean per agent)', (r) => r.outcomes.pointsFor],
  ['Agent wins (mean per agent)', (r) => r.outcomes.wins],
  ['Adds (churn)', (r) => r.season.adds],
  ['Offers sent', (r) => r.season.offersSent],
  ['Trades processed', (r) => r.season.tradesProcessed],
  ['Invalid action attempts', (r) => r.season.invalidActions],
  ['Agent messages', (r) => r.season.agentMessages],
  ['Model calls', (r) => r.season.modelCalls],
  ['Est. cost (USD, scripted)', (r) => r.season.costUsd]
];

function summed(
  runs: readonly CalibrationRun[],
  of: (r: CalibrationRun) => Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of runs) for (const [k, v] of Object.entries(of(r))) out[k] = (out[k] ?? 0) + v;
  return out;
}

export function renderCalibrationReport(report: CalibrationReport): string {
  const lines: string[] = [
    `Seeds ${report.seeds.join(', ')}; ${report.weeks} league weeks of the 2025 archive; scripted model; configurations ${report.configs.join(', ')}. Matched: a seed fixes the draft, the seats' personalities, difficulties, and archetypes, and the clock, so an ablation's change from \`full\` is taken seed by seed.`,
    '',
    '### Decisions and outcomes',
    '',
    `| Metric | ${report.configs.join(' | ')} |`,
    `|---|${report.configs.map(() => '---').join('|')}|`
  ];
  for (const [label, pick] of CALIBRATION_METRICS)
    lines.push(`| ${label} | ${report.configs.map((c) => matchedRow(report, c, pick)).join(' | ')} |`);

  const full = report.runs.filter((r) => r.config === 'full');
  const sum = (f: (r: CalibrationRun) => number) => full.reduce((a, r) => a + f(r), 0);
  lines.push(
    '',
    '### Situational exposure (`full`, summed over seeds)',
    '',
    'Agent tasks that read each state, and distinct agent-weeks in it.',
    '',
    '| State | Tasks | Agent-weeks |',
    '|---|---|---|'
  );
  for (const u of URGENCY_LEVELS)
    lines.push(`| ${u} | ${sum((r) => r.exposure.byUrgency[u])} | ${sum((r) => r.exposure.agentWeeks[u])} |`);
  const basis = summed(full, (r) => r.exposure.byBasis);
  const reasons = Object.entries(summed(full, (r) => r.exposure.reasons)).sort((a, b) => b[1] - a[1]);
  lines.push(
    '',
    `Situation reads: ${sum((r) => r.exposure.tasks)} (exact ${basis.exact ?? 0}, heuristic ${basis.heuristic ?? 0}, none ${basis.none ?? 0}); label changes ${sum((r) => r.exposure.transitions)}; tasks seeing a position short ${sum((r) => r.exposure.short)}, thin ${sum((r) => r.exposure.thin)}; reads past the league's week (hindsight) ${sum((r) => r.exposure.hindsight)}.`,
    '',
    `Reasons read: ${reasons.map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`,
    '',
    '### Attachments (`full`, summed over seeds)',
    ''
  );
  const uses = Object.entries(summed(full, (r) => r.attachments.byUse));
  lines.push(
    `Decisions an attachment touched: ${sum((r) => r.attachments.adjustments)} (${uses.map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}); raised the bar ${sum((r) => r.attachments.raised)} (mean +${fmt(mean(full.map((r) => r.attachments.meanAdjustment)))} per raise, over run means); a pressing need waived it ${sum((r) => r.attachments.overrides)}.`,
    '',
    `At season's end: ${sum((r) => r.attachments.held)} held, ${sum((r) => r.attachments.departed)} departed; sources drafted ${sum((r) => r.attachments.drafted)}, traded-for ${sum((r) => r.attachments.tradedFor)}; revisions down ${sum((r) => r.attachments.revisedDown)}, up ${sum((r) => r.attachments.revisedUp)}; held but off the roster (must be 0) ${sum((r) => r.attachments.staleHeld)}.`,
    '',
    '### Trade scouting by archetype (`full`, summed over seeds)',
    '',
    '| Archetype | Agents | Check-ins | Shopped | Offers | Offers per shop |',
    '|---|---|---|---|---|---|'
  );
  const scout = new Map<string, { agents: number; checkIns: number; shopped: number; offers: number }>();
  for (const r of full)
    for (const [k, v] of Object.entries(r.scouting)) {
      const e = scout.get(k) ?? { agents: 0, checkIns: 0, shopped: 0, offers: 0 };
      scout.set(k, {
        agents: e.agents + v.agents,
        checkIns: e.checkIns + v.checkIns,
        shopped: e.shopped + v.shopped,
        offers: e.offers + v.offers
      });
    }
  for (const [k, v] of [...scout.entries()].sort(
    (a, b) => b[1].shopped / b[1].agents - a[1].shopped / a[1].agents
  ))
    lines.push(
      `| ${k} | ${v.agents} | ${v.checkIns} | ${v.shopped} | ${v.offers} | ${v.shopped === 0 ? '–' : fmt(round2(v.offers / v.shopped))} |`
    );
  const breaches = report.runs.flatMap((r) =>
    [
      r.season.violations > 0 ? `${r.config}/${r.seed}: ${r.season.violations} invariant violations` : null,
      r.season.loopFailures > 0
        ? `${r.config}/${r.seed}: ${r.season.loopFailures} event-loop failures`
        : null,
      r.season.invalidActions > 0
        ? `${r.config}/${r.seed}: ${r.season.invalidActions} refused actions`
        : null,
      r.exposure.hindsight > 0 ? `${r.config}/${r.seed}: ${r.exposure.hindsight} hindsight reads` : null,
      // Without attachments nothing refreshes them, so departures stay unrecorded by design.
      r.config !== 'no_attachments' && r.attachments.staleHeld > 0
        ? `${r.config}/${r.seed}: ${r.attachments.staleHeld} stale attachments`
        : null
    ].filter((x): x is string => x !== null)
  );
  lines.push(
    '',
    `Integrity: ${breaches.length === 0 ? 'no invariant violation, event-loop failure, refused action, hindsight read, or stale attachment in any run.' : breaches.join('; ')}`
  );
  return `${lines.join('\n')}\n`;
}
