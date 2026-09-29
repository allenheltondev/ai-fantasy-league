import { FIXED_ROOM_IDS, matchupRoomId, type LeagueSettings, type StandingsRow } from '@fantasy/core';
import { AGENT_CHAT_BUDGETS } from '@fantasy/server';
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
  /**
   * Trade offers by who made them (agents on their own, through trade_proposal, or the human
   * stand-in; counters included), every offer's final status, and the veto votes cast.
   */
  trades: {
    offers: { byAgents: number; byHuman: number; toAgents: number };
    byStatus: Record<string, number>;
    vetoVotes: number;
  };
  /** Messages by author kind, and by room: each fixed room by id, then all `matchup` and `dm` rooms. */
  chat: {
    messages: number;
    byKind: Record<string, number>;
    byRoom: Record<string, number>;
    /** Agent messages by room kind (#153). */
    agentByRoom: Record<string, number>;
    /** Agent-to-agent retorts (`replyToAgentDepth` 1 or more). */
    retorts: number;
    /**
     * Chat volume per agent (#196): messages per 7-day block from the first agent message, and the
     * most in any 24 hours (the budget window); `leagueMaxPerDay` is the most the league's agents
     * posted together in 24 hours.
     */
    byAgent: Record<string, { messages: number; perWeek: number[]; maxPerDay: number }>;
    leagueMaxPerDay: number;
  };
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

async function chatCounts(services: Services, league: League): Promise<LeagueReplayReport['chat']> {
  const byKind: Record<string, number> = {};
  const byRoom: Record<string, number> = {};
  const agentByRoom: Record<string, number> = {};
  let messages = 0;
  let retorts = 0;
  const agentPosts: { teamId: string; at: number }[] = [];
  const matchups = await services.repos.schedule.listMatchups(league.id);
  const teams = await services.repos.teams.list(league.id);
  const dms = new Set<string>();
  for (const team of teams)
    for (const id of await services.repos.chat.dmRooms(league.id, team.id)) dms.add(id);
  const rooms: [string, string][] = [
    ...FIXED_ROOM_IDS.map((id): [string, string] => [id, id]),
    ...matchups.map((m): [string, string] => [matchupRoomId(league.season, m.week, m.id), 'matchup']),
    ...[...dms].map((id): [string, string] => [id, 'dm'])
  ];
  for (const [roomId, label] of rooms) {
    let cursor: string | undefined;
    do {
      const page = await services.repos.chat.list(league.id, roomId, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor })
      });
      for (const m of page.messages) {
        messages++;
        byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
        byRoom[label] = (byRoom[label] ?? 0) + 1;
        if (m.kind === 'agent') {
          agentByRoom[label] = (agentByRoom[label] ?? 0) + 1;
          agentPosts.push({ teamId: m.author.teamId as string, at: Date.parse(m.createdAt) });
        }
        if ((m.replyToAgentDepth ?? 0) > 0) retorts++;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
  }
  return {
    messages,
    byKind: sorted(byKind),
    byRoom: sorted(byRoom),
    agentByRoom: sorted(agentByRoom),
    retorts,
    ...agentVolume(agentPosts)
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The most posts in any 24 hours (each post starts a window). */
function maxPerDay(times: readonly number[]): number {
  const sortedTimes = [...times].sort((a, b) => a - b);
  let most = 0;
  let from = 0;
  for (let i = 0; i < sortedTimes.length; i++) {
    while ((sortedTimes[i] as number) - (sortedTimes[from] as number) >= DAY_MS) from++;
    most = Math.max(most, i - from + 1);
  }
  return most;
}

/** Agent chat volume (#196): per agent, per 7-day block and in the busiest 24 hours. */
export function agentVolume(
  posts: readonly { teamId: string; at: number }[]
): Pick<LeagueReplayReport['chat'], 'byAgent' | 'leagueMaxPerDay'> {
  const start = Math.min(...posts.map((p) => p.at));
  const byAgent: LeagueReplayReport['chat']['byAgent'] = {};
  for (const teamId of new Set(posts.map((p) => p.teamId))) {
    const mine = posts.filter((p) => p.teamId === teamId).map((p) => p.at);
    const perWeek: number[] = [];
    for (const at of mine) {
      const week = Math.floor((at - start) / (7 * DAY_MS));
      while (perWeek.length <= week) perWeek.push(0);
      perWeek[week] = (perWeek[week] as number) + 1;
    }
    byAgent[teamId] = { messages: mine.length, perWeek, maxPerDay: maxPerDay(mine) };
  }
  return { byAgent: sorted(byAgent), leagueMaxPerDay: maxPerDay(posts.map((p) => p.at)) };
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
  const offers = await repos.trades.list(league.id);
  const byStatus: Record<string, number> = {};
  for (const o of offers) byStatus[o.trade.status] = (byStatus[o.trade.status] ?? 0) + 1;
  const byAgents = offers.filter((o) => seats.has(o.trade.sides[0].teamId)).length;
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
    trades: {
      offers: {
        byAgents,
        byHuman: offers.length - byAgents,
        toAgents: offers.filter((o) => seats.has(o.trade.sides[1].teamId)).length
      },
      byStatus: sorted(byStatus),
      vetoVotes: offers.reduce((n, o) => n + o.trade.vetoVotes.length, 0)
    },
    chat: await chatCounts(input.services, league),
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
      'Check-ins: three times a day every agent looks at its team (check_in, #195): a deterministic pre-check skips the model when nothing is worth a look; otherwise it may set its lineup, add or claim a player, or offer a trade.',
      'Social (#196): at a check-in an agent may also rename its team, post on a league board about news that concerns it, talk about its matchup in the matchup room, or send a DM tied to a goal (a trade to pitch, an offer to follow up); how often depends on its personality (chattiness) and the chat budgets. The fake model posts canned lines.',
      'Trades: agents shop for trades once a week at the rollover (trade_proposal, paced by their archetype), and at check-ins when their appetite roll passes, and answer offers through trade_response; in league-vote review, agents outside a trade vote on it (trade_vote). The human stand-in offers one bench swap a week before the deadline and never answers offers, so offers to it expire.',
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
    '| Team | Seat | Tasks | Draft | Lineup | Waivers | Check-ins | Chat | Fallbacks | Cost |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...report.teams.map((t) => {
      const a = report.agents.byTeam[t.id] ?? empty();
      const chat = (a.byKind.chat_reply ?? 0) + (a.byKind.chat_moment ?? 0);
      const seat =
        t.agent === null ? t.seat : `${t.agent.personalityId}, ${t.agent.difficulty}, ${t.agent.archetype}`;
      return `| ${team(t.id)} | ${seat} | ${a.tasks} | ${a.byKind.draft_pick ?? 0} | ${a.byKind.lineup ?? 0} | ${a.byKind.waivers ?? 0} | ${a.byKind.check_in ?? 0} | ${chat} | ${a.byStatus.fallback ?? 0} | ${money(a.costUsd)} |`;
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
      )}). Trade offers: ${report.trades.offers.byAgents} by agents, ${report.trades.offers.byHuman} by the human (${Object.entries(
      report.trades.byStatus
    )
      .map(([status, n]) => `${status} ${n}`)
      .join(
        ', '
      )}); veto votes ${report.trades.vetoVotes}. Chat messages: ${report.chat.messages} (${Object.entries(
      report.chat.byKind
    )
      .map(([k, n]) => `${k} ${n}`)
      .join(', ')}; by room: ${Object.entries(report.chat.byRoom)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ')}; agents by room: ${
      Object.entries(report.chat.agentByRoom)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ') || 'none'
    }; agent-to-agent retorts ${report.chat.retorts}).`,
    '',
    `Agent chat volume (#196; budgets ${AGENT_CHAT_BUDGETS.agentPerDay} per agent and ${AGENT_CHAT_BUDGETS.leaguePerDay} per league in any 24 hours; the league's busiest 24 hours: ${report.chat.leagueMaxPerDay}):`,
    '',
    '| Team | Messages | Per week | Busiest 24h |',
    '|---|---|---|---|',
    ...Object.entries(report.chat.byAgent).map(
      ([id, v]) => `| ${team(id)} | ${v.messages} | ${v.perWeek.join(', ')} | ${v.maxPerDay} |`
    ),
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
