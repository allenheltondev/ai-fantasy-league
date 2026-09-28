import type { LeagueSettings, StandingsRow } from '@fantasy/core';
import type {
  AgentTaskRecord,
  InMemoryEventPublisher,
  League,
  LoopFailure,
  LoopStats,
  Services
} from '@fantasy/server';
import type { ReplayCheck, ReplayInvariant } from './checks.js';
import type { HumanStandIn } from './human.js';

export interface WeekTiming {
  /** Null for the draft. */
  week: number | null;
  label: 'draft' | 'regular' | 'playoffs';
  /** Wall-clock time the step took. */
  wallMs: number;
  /** Simulated time at the end of the step. */
  simTo: string;
  /** Events delivered during the step. */
  events?: number;
}

export interface AgentTotals {
  tasks: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LeagueReplayReport {
  kind: 'league-replay';
  season: number;
  seed: string;
  /** The agents' model client (`fake` for the scripted model). */
  model: string;
  leagueId: string;
  /** The league's phase at the end (`complete` when it played through its playoffs). */
  phase: string;
  settings: {
    teamCount: number;
    startWeek: number;
    regularSeasonEndWeek: number;
    playoffWeeks: number[];
    faabBudget: number;
  };
  teams: {
    id: string;
    name: string;
    seat: 'human' | 'agent';
    agent: { personalityId: string; difficulty: string; archetype: string } | null;
    finalFaab: number;
  }[];
  draft: { order: string[]; picks: number; autoPicks: Record<string, number> };
  champion: string | null;
  standings: StandingsRow[];
  weeks: {
    week: number;
    kind: 'regular' | 'playoffs';
    matchups: {
      homeTeamId: string;
      awayTeamId: string;
      homeScore: number | null;
      awayScore: number | null;
    }[];
    invariants: ReplayCheck[];
  }[];
  transactions: {
    type: string;
    week: number;
    teamId: string;
    add: string | null;
    drop: string | null;
    cost: number | null;
  }[];
  agents: { totals: AgentTotals; byTeam: Record<string, AgentTotals>; byModel: Record<string, AgentTotals> };
  /** Every agent decision, oldest first: the trigger, what it did, and why. */
  decisions: {
    at: string;
    teamId: string;
    kind: string;
    trigger: string;
    status: string;
    action: string;
    summary: string;
    costUsd: number;
  }[];
  human: { teamId: string; actions: Record<string, number>; refused: { operation: string; code: string }[] };
  chat: { messages: number; byKind: Record<string, number> };
  events: {
    delivered: Record<string, number>;
    deferredReleased: number;
    jobRuns: Record<string, number>;
    failures: { at: string; handler: string; detailType: string | null; error: string }[];
  };
  dataAccess: { reads: number; byMethod: Record<string, number>; futureAccessAttempts: number };
  timings: WeekTiming[];
  wallMs: number;
  /** Every invariant violation (empty for a clean replay). */
  violations: { week: number; name: ReplayInvariant; message: string }[];
  /** What the replay could not cover yet. */
  notes: string[];
}

const empty = (): AgentTotals => ({
  tasks: 0,
  byKind: {},
  byStatus: {},
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0
});

function add(t: AgentTotals, task: AgentTaskRecord, usage?: AgentTaskRecord['usage'][number]): void {
  t.tasks++;
  t.byKind[task.kind] = (t.byKind[task.kind] ?? 0) + 1;
  t.byStatus[task.status] = (t.byStatus[task.status] ?? 0) + 1;
  const rows = usage === undefined ? task.usage : [usage];
  for (const u of rows) {
    t.costUsd = Math.round((t.costUsd + u.estimatedCostUsd) * 1_000_000) / 1_000_000;
    t.inputTokens += u.inputTokens;
    t.outputTokens += u.outputTokens;
  }
}

const sorted = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

async function chatCounts(services: Services, leagueId: string): Promise<LeagueReplayReport['chat']> {
  const byKind: Record<string, number> = {};
  let messages = 0;
  let cursor: string | undefined;
  do {
    const page = await services.repos.chat.list(leagueId, {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor })
    });
    for (const m of page.messages) {
      messages++;
      byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return { messages, byKind: sorted(byKind) };
}

export async function buildLeagueReport(input: {
  seed: string;
  season: number;
  league: League;
  settings: LeagueSettings;
  playedWeeks: readonly number[];
  playoffWeeks: readonly number[];
  human: HumanStandIn;
  services: Services;
  events: InMemoryEventPublisher;
  loopStats: LoopStats;
  failures: readonly LoopFailure[];
  checks: ReadonlyMap<number, ReplayCheck[]>;
  standings: StandingsRow[];
  champion: string | null;
  timings: WeekTiming[];
  dataAccess: LeagueReplayReport['dataAccess'];
  model: string;
  wallMs: number;
}): Promise<LeagueReplayReport> {
  const { repos } = input.services;
  const { league, settings } = input;
  const teams = (await repos.teams.list(league.id)).sort(
    (a, b) => a.draftSlot - b.draftSlot || a.id.localeCompare(b.id)
  );
  const seats = new Map((await repos.agents.listSeats(league.id)).map((s) => [s.teamId, s.config]));
  const draft = await repos.drafts.get(league.id);
  const autoPicks: Record<string, number> = {};
  for (const p of draft?.state.picks ?? []) if (p.auto) autoPicks[p.teamId] = (autoPicks[p.teamId] ?? 0) + 1;

  const tasks = (await repos.agents.listTasks(league.id, { limit: Number.MAX_SAFE_INTEGER })).sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.taskId.localeCompare(b.taskId)
  );
  const totals = empty();
  const byTeam: Record<string, AgentTotals> = {};
  const byModel: Record<string, AgentTotals> = {};
  for (const task of tasks) {
    add(totals, task);
    add((byTeam[task.teamId] ??= empty()), task);
    for (const u of task.usage) add((byModel[u.modelKey] ??= empty()), task, u);
  }

  const matchups = await repos.schedule.listMatchups(league.id);
  const weeks = input.playedWeeks.map((week) => ({
    week,
    kind: input.playoffWeeks.includes(week) ? ('playoffs' as const) : ('regular' as const),
    matchups: matchups
      .filter((m) => m.week === week)
      .map((m) => ({
        homeTeamId: m.homeTeamId,
        awayTeamId: m.awayTeamId,
        homeScore: m.homeScore,
        awayScore: m.awayScore
      })),
    invariants: input.checks.get(week) ?? []
  }));
  const violations = weeks.flatMap((w) =>
    w.invariants.flatMap((c) => c.violations.map((message) => ({ week: w.week, name: c.name, message })))
  );
  const transactions = (await repos.waivers.listTransactionsSince(league.id, '')).map((t) => ({
    type: t.type,
    week: t.week,
    teamId: t.teamId,
    add: t.addPlayerId,
    drop: t.dropPlayerId,
    cost: t.cost
  }));

  return {
    kind: 'league-replay',
    season: input.season,
    seed: input.seed,
    model: input.model,
    leagueId: league.id,
    phase: league.phase,
    settings: {
      teamCount: settings.teamCount,
      startWeek: settings.schedule.startWeek,
      regularSeasonEndWeek: settings.schedule.regularSeasonEndWeek,
      playoffWeeks: [...input.playoffWeeks],
      faabBudget: settings.waivers.faabBudget
    },
    teams: teams.map((t) => {
      const config = seats.get(t.id);
      return {
        id: t.id,
        name: t.name,
        seat: t.seatType,
        agent:
          config === undefined
            ? null
            : {
                personalityId: config.personalityId,
                difficulty: config.difficulty,
                archetype: config.archetype
              },
        finalFaab: t.faabRemaining
      };
    }),
    draft: {
      order: [...(draft?.state.teamIds ?? [])],
      picks: draft?.state.picks.length ?? 0,
      autoPicks: sorted(autoPicks)
    },
    champion: input.champion,
    standings: input.standings,
    weeks,
    transactions,
    agents: { totals, byTeam: sorted(byTeam), byModel: sorted(byModel) },
    decisions: tasks.map((t) => ({
      at: t.startedAt,
      teamId: t.teamId,
      kind: t.kind,
      trigger: t.trigger.detailType,
      status: t.status,
      action: t.finalAction,
      summary: t.reasoningSummary,
      costUsd: t.costUsd
    })),
    human: {
      teamId: input.human.teamId,
      actions: sorted(input.human.actions),
      refused: input.human.refused
    },
    chat: await chatCounts(input.services, league.id),
    events: {
      delivered: sorted(input.loopStats.delivered),
      deferredReleased: input.loopStats.released,
      jobRuns: sorted(input.loopStats.jobRuns),
      failures: input.failures.map((f) => ({
        at: f.at,
        handler: f.handler,
        detailType: f.detailType,
        error: f.error instanceof Error ? f.error.message : String(f.error)
      }))
    },
    dataAccess: input.dataAccess,
    timings: input.timings,
    wallMs: input.wallMs,
    violations,
    notes: [
      'Trades: the human stand-in offers one bench swap a week before the deadline and agents answer through trade_response; agents do not propose trades on their own (no trigger for it yet).',
      'The champion is the one the league stored with its playoff bracket; the replay checks it against the stored playoff games replayed through core `advanceBracket`.'
    ]
  };
}

const money = (n: number): string => `$${n.toFixed(4)}`;

/** A readable season recap: standings, the champion, agent activity and cost, and per-week timing. */
export function renderLeagueReport(report: LeagueReplayReport): string {
  const name = new Map(report.teams.map((t) => [t.id, t.name]));
  const team = (id: string | null) => (id === null ? 'none' : `${name.get(id) ?? id} (${id})`);
  const lines: string[] = [
    `# ${report.season} season replay`,
    '',
    `Seed \`${report.seed}\`, model \`${report.model}\`, ${report.settings.teamCount} teams, weeks ${report.settings.startWeek}-${report.settings.regularSeasonEndWeek} regular season, playoffs ${report.settings.playoffWeeks.join(', ') || 'none'}.`,
    '',
    `**Champion:** ${team(report.champion)}. League phase at the end: \`${report.phase}\`.`,
    '',
    `**Invariants:** ${report.violations.length === 0 ? 'all held' : `${report.violations.length} violation(s)`}. Handler failures: ${report.events.failures.length}. Future data reads blocked: ${report.dataAccess.futureAccessAttempts}.`,
    '',
    '## Standings',
    '',
    '| # | Team | W-L-T | PF | PA |',
    '|---|---|---|---|---|',
    ...report.standings.map(
      (r) =>
        `| ${r.rank} | ${team(r.teamId)} | ${r.wins}-${r.losses}-${r.ties} | ${r.pointsFor.toFixed(2)} | ${r.pointsAgainst.toFixed(2)} |`
    ),
    '',
    '## Agents',
    '',
    `${report.agents.totals.tasks} tasks, estimated cost ${money(report.agents.totals.costUsd)}.`,
    '',
    '| Team | Seat | Tasks | Draft | Lineup | Waivers | Chat | Fallbacks | Cost |',
    '|---|---|---|---|---|---|---|---|---|',
    ...report.teams.map((t) => {
      const a = report.agents.byTeam[t.id] ?? empty();
      const chat = (a.byKind.chat_reply ?? 0) + (a.byKind.chat_moment ?? 0);
      const seat =
        t.agent === null ? t.seat : `${t.agent.personalityId}, ${t.agent.difficulty}, ${t.agent.archetype}`;
      return `| ${team(t.id)} | ${seat} | ${a.tasks} | ${a.byKind.draft_pick ?? 0} | ${a.byKind.lineup ?? 0} | ${a.byKind.waivers ?? 0} | ${chat} | ${a.byStatus.fallback ?? 0} | ${money(a.costUsd)} |`;
    }),
    '',
    `Human stand-in (${report.human.teamId}): ${Object.entries(report.human.actions)
      .map(([op, n]) => `${op} ${n}`)
      .join(', ')}; refused ${report.human.refused.length}.`,
    '',
    `Transactions: ${report.transactions.length} (${Object.entries(
      report.transactions.reduce<Record<string, number>>(
        (n, t) => ({ ...n, [t.type]: (n[t.type] ?? 0) + 1 }),
        {}
      )
    )
      .map(([type, n]) => `${type} ${n}`)
      .join(
        ', '
      )}). Trades proposed ${report.events.delivered['Trade Proposed'] ?? 0}, processed ${report.events.delivered['Trade Processed'] ?? 0}. Chat messages: ${report.chat.messages} (${Object.entries(
      report.chat.byKind
    )
      .map(([k, n]) => `${k} ${n}`)
      .join(', ')}).`,
    '',
    '## Weeks',
    '',
    '| Week | Kind | Invariants | Wall ms | Events | Sim time at end |',
    '|---|---|---|---|---|---|',
    ...report.timings.map((t) => {
      const w = report.weeks.find((x) => x.week === t.week);
      const ok = w === undefined ? '' : w.invariants.every((c) => c.ok) ? 'ok' : 'VIOLATED';
      return `| ${t.week ?? 'draft'} | ${t.label} | ${ok} | ${t.wallMs} | ${t.events ?? ''} | ${t.simTo} |`;
    }),
    '',
    `Total wall time ${report.wallMs} ms, ${report.dataAccess.reads} archive reads.`
  ];
  if (report.violations.length > 0) {
    lines.push(
      '',
      '## Violations',
      '',
      ...report.violations.map((v) => `- week ${v.week} \`${v.name}\`: ${v.message}`)
    );
  }
  if (report.events.failures.length > 0) {
    lines.push(
      '',
      '## Handler failures',
      '',
      ...report.events.failures.map((f) => `- ${f.at} ${f.handler} (${f.detailType ?? 'job'}): ${f.error}`)
    );
  }
  lines.push('', '## Notes', '', ...report.notes.map((n) => `- ${n}`), '');
  return lines.join('\n');
}
