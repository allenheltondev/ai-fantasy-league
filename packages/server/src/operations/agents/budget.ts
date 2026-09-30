import { DIFFICULTY_WEEKLY_BUDGET_USD, agentAllowanceUsd, leagueAiBudget } from '@fantasy/core';
import { z } from 'zod';
import type { AgentRepository, AgentSeatRecord, AgentUsageRow } from '../../repos/agents.js';
import type { League } from '../../repos/types.js';

const TotalsSchema = z.object({
  costUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  tasks: z.number()
});

export const LeagueBudgetSchema = z
  .object({
    week: z.number().int(),
    ceilingUsd: z
      .number()
      .describe(
        "Weekly ceiling (estimate): the commissioner's `ai.weeklyBudgetUsd`, or automatic from the agent seats' difficulty mix."
      ),
    automatic: z.boolean().describe("True when the ceiling comes from the seats' difficulties."),
    overageUsd: z
      .number()
      .describe('Extra spend the commissioner allows past the ceiling (`ai.overageUsd`); 0 when off.'),
    limitUsd: z.number().describe('Where agents stop using models: the ceiling plus the overage.'),
    spentUsd: z.number().describe('Estimated spend so far this week.'),
    remainingUsd: z.number().describe('Left before the ceiling.'),
    overage: z
      .boolean()
      .describe('True once spend passed the ceiling but not the limit: agents run on overage.'),
    exceeded: z
      .boolean()
      .describe(
        'When true (spend reached the limit), agents use deterministic fallbacks until the week rolls over.'
      ),
    byAgent: z.array(
      TotalsSchema.extend({
        agentId: z.string(),
        teamId: z
          .string()
          .nullable()
          .describe('The team the agent plays; null for a seat that no longer exists.'),
        allowanceUsd: z
          .number()
          .nullable()
          .describe(
            "This agent's share of the ceiling, by its difficulty; null for a seat that no longer exists."
          )
      })
    ),
    byModel: z.array(TotalsSchema.extend({ modelKey: z.string() }))
  })
  .describe('Estimated agent model spend for one league week. Prices are estimates, not billing data.');
export type LeagueBudget = z.infer<typeof LeagueBudgetSchema>;

const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

type Totals = z.infer<typeof TotalsSchema>;

function sumBy(rows: readonly AgentUsageRow[], key: 'agentId' | 'modelKey'): Map<string, Totals> {
  const out = new Map<string, Totals>();
  for (const row of rows) {
    const t = out.get(row[key]) ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, tasks: 0 };
    out.set(row[key], {
      costUsd: round(t.costUsd + row.costUsd),
      inputTokens: t.inputTokens + row.inputTokens,
      outputTokens: t.outputTokens + row.outputTokens,
      tasks: t.tasks + row.tasks
    });
  }
  return out;
}

/**
 * Spend per agent seat (every seat, even one that has spent nothing), with its allowance: its
 * difficulty's, or with a commissioner's ceiling its difficulty's share of that.
 */
function agentTotals(
  rows: readonly AgentUsageRow[],
  seats: readonly AgentSeatRecord[],
  ceiling: { ceilingUsd: number; automatic: boolean }
): LeagueBudget['byAgent'] {
  const difficulties = seats.map((s) => s.config.difficulty);
  const spent = sumBy(rows, 'agentId');
  const ids = [...new Set([...seats.map((s) => s.agentId), ...spent.keys()])].sort();
  return ids.map((agentId) => {
    const seat = seats.find((s) => s.agentId === agentId);
    return {
      agentId,
      teamId: seat?.teamId ?? null,
      allowanceUsd:
        seat === undefined
          ? null
          : ceiling.automatic
            ? DIFFICULTY_WEEKLY_BUDGET_USD[seat.config.difficulty]
            : agentAllowanceUsd(seat.config.difficulty, difficulties, ceiling.ceilingUsd),
      ...(spent.get(agentId) ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, tasks: 0 })
    };
  });
}

/** The league's week number for rollups: the current NFL week, or 0 before the season. */
export function budgetWeek(league: League): number {
  return league.week ?? 0;
}

/** This week's estimated spend against the league's ceiling and overage (issue #93). */
export async function leagueBudget(
  agents: AgentRepository,
  league: League,
  week = budgetWeek(league)
): Promise<LeagueBudget> {
  const [rows, seats] = await Promise.all([agents.weekUsage(league.id, week), agents.listSeats(league.id)]);
  const limits = leagueAiBudget(
    league.settings.ai,
    seats.map((s) => s.config.difficulty)
  );
  const spentUsd = round(rows.reduce((sum, r) => sum + r.costUsd, 0));
  const exceeded = spentUsd >= limits.limitUsd;
  return {
    week,
    ...limits,
    spentUsd,
    remainingUsd: round(Math.max(0, limits.ceilingUsd - spentUsd)),
    overage: !exceeded && spentUsd >= limits.ceilingUsd,
    exceeded,
    byAgent: agentTotals(rows, seats, limits),
    byModel: [...sumBy(rows, 'modelKey').entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([modelKey, t]) => ({ modelKey, ...t }))
  };
}

export const SeasonSpendSchema = z
  .object({
    spentUsd: z.number().describe('Estimated spend over every budget week so far.'),
    weeks: z.array(z.object({ week: z.number().int(), spentUsd: z.number(), tasks: z.number() }))
  })
  .describe(
    'Estimated spend by budget week, week 0 being everything before week 1 (setup and the draft). Estimates, not billing data.'
  );
export type SeasonSpend = z.infer<typeof SeasonSpendSchema>;

/** The league's estimated spend in every budget week from 0 through the current one. */
export async function seasonSpend(agents: AgentRepository, league: League): Promise<SeasonSpend> {
  const current = budgetWeek(league);
  const weeks = await Promise.all(
    Array.from({ length: current + 1 }, async (_, week) => {
      const rows = await agents.weekUsage(league.id, week);
      return {
        week,
        spentUsd: round(rows.reduce((sum, r) => sum + r.costUsd, 0)),
        tasks: rows.reduce((sum, r) => sum + r.tasks, 0)
      };
    })
  );
  return { spentUsd: round(weeks.reduce((sum, w) => sum + w.spentUsd, 0)), weeks };
}
