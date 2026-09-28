import { DIFFICULTY_WEEKLY_BUDGET_USD, leagueWeeklyBudgetUsd } from '@fantasy/core';
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
    ceilingUsd: z.number().describe("Weekly ceiling from the agent seats' difficulty mix (estimate)."),
    spentUsd: z.number().describe('Estimated spend so far this week.'),
    remainingUsd: z.number(),
    exceeded: z
      .boolean()
      .describe('When true, agents use deterministic fallbacks until the week rolls over.'),
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
            "This agent's share of the ceiling, from its difficulty; null for a seat that no longer exists."
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

/** Spend per agent seat (every seat, even one that has spent nothing), with its allowance. */
function agentTotals(
  rows: readonly AgentUsageRow[],
  seats: readonly AgentSeatRecord[]
): LeagueBudget['byAgent'] {
  const spent = sumBy(rows, 'agentId');
  const ids = [...new Set([...seats.map((s) => s.agentId), ...spent.keys()])].sort();
  return ids.map((agentId) => {
    const seat = seats.find((s) => s.agentId === agentId);
    return {
      agentId,
      teamId: seat?.teamId ?? null,
      allowanceUsd: seat === undefined ? null : DIFFICULTY_WEEKLY_BUDGET_USD[seat.config.difficulty],
      ...(spent.get(agentId) ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, tasks: 0 })
    };
  });
}

/** The league's week number for rollups: the current NFL week, or 0 before the season. */
export function budgetWeek(league: League): number {
  return league.week ?? 0;
}

/** This week's estimated spend against the league's ceiling (issue #93). */
export async function leagueBudget(
  agents: AgentRepository,
  league: League,
  week = budgetWeek(league)
): Promise<LeagueBudget> {
  const [rows, seats] = await Promise.all([agents.weekUsage(league.id, week), agents.listSeats(league.id)]);
  const ceilingUsd = leagueWeeklyBudgetUsd(seats.map((s) => s.config.difficulty));
  const spentUsd = round(rows.reduce((sum, r) => sum + r.costUsd, 0));
  return {
    week,
    ceilingUsd,
    spentUsd,
    remainingUsd: round(Math.max(0, ceilingUsd - spentUsd)),
    exceeded: spentUsd >= ceilingUsd,
    byAgent: agentTotals(rows, seats),
    byModel: [...sumBy(rows, 'modelKey').entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([modelKey, t]) => ({ modelKey, ...t }))
  };
}
