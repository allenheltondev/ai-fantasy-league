import { leagueWeeklyBudgetUsd } from '@fantasy/core';
import { z } from 'zod';
import type { AgentRepository, AgentUsageRow } from '../../repos/agents.js';
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
    byAgent: z.array(TotalsSchema.extend({ agentId: z.string() })),
    byModel: z.array(TotalsSchema.extend({ modelKey: z.string() }))
  })
  .describe('Estimated agent model spend for one league week. Prices are estimates, not billing data.');
export type LeagueBudget = z.infer<typeof LeagueBudgetSchema>;

const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

function totals<K extends 'agentId' | 'modelKey'>(rows: readonly AgentUsageRow[], key: K) {
  const out = new Map<string, z.infer<typeof TotalsSchema>>();
  for (const row of rows) {
    const t = out.get(row[key]) ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, tasks: 0 };
    out.set(row[key], {
      costUsd: round(t.costUsd + row.costUsd),
      inputTokens: t.inputTokens + row.inputTokens,
      outputTokens: t.outputTokens + row.outputTokens,
      tasks: t.tasks + row.tasks
    });
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, t]) => ({ [key]: id, ...t }));
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
    byAgent: totals(rows, 'agentId') as LeagueBudget['byAgent'],
    byModel: totals(rows, 'modelKey') as LeagueBudget['byModel']
  };
}
