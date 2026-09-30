import type { Difficulty } from './difficulty.js';

/**
 * Per-league weekly spend guard (issue #93). Each agent seat contributes an allowance by difficulty;
 * the league's ceiling is their sum, clamped to a floor and a hard cap. When a league's estimated
 * spend for the week reaches the ceiling, agents switch to deterministic fallbacks until the week
 * rolls over. Amounts are USD estimates computed from the catalog's estimated prices.
 */
export const DIFFICULTY_WEEKLY_BUDGET_USD: Readonly<Record<Difficulty, number>> = {
  rookie: 0.05,
  amateur: 0.15,
  pro: 0.5,
  all_pro: 1.5,
  hall_of_famer: 4
};

/** No league gets less than this, so a league of rookies still has room to act. */
export const LEAGUE_WEEKLY_BUDGET_FLOOR_USD = 0.25;
/** No league gets more than this, whatever its difficulty mix. */
export const LEAGUE_WEEKLY_BUDGET_CAP_USD = 20;

/** The weekly ceiling for a league whose agent seats have these difficulties. */
export function leagueWeeklyBudgetUsd(difficulties: readonly Difficulty[]): number {
  const sum = difficulties.reduce((total, d) => total + DIFFICULTY_WEEKLY_BUDGET_USD[d], 0);
  const clamped = Math.min(LEAGUE_WEEKLY_BUDGET_CAP_USD, Math.max(LEAGUE_WEEKLY_BUDGET_FLOOR_USD, sum));
  return Math.round(clamped * 100) / 100;
}

const cents = (n: number) => Math.round(n * 100) / 100;

export interface LeagueAiBudget {
  /** The soft weekly ceiling: the commissioner's budget, or the automatic one from difficulties. */
  ceilingUsd: number;
  /** True when the ceiling comes from the difficulty mix rather than the commissioner. */
  automatic: boolean;
  /** Extra spend allowed past the ceiling (0 when overage is off). */
  overageUsd: number;
  /** Where agents stop using models: the ceiling plus the overage. */
  limitUsd: number;
}

/**
 * The league's weekly spend limits from its AI settings (#93): the commissioner's budget when set,
 * otherwise `leagueWeeklyBudgetUsd` of the seats' difficulties, plus any allowed overage.
 */
export function leagueAiBudget(
  ai: { weeklyBudgetUsd: number | null; overageUsd: number } | undefined,
  difficulties: readonly Difficulty[]
): LeagueAiBudget {
  const set = ai?.weeklyBudgetUsd ?? null;
  const ceilingUsd = set === null ? leagueWeeklyBudgetUsd(difficulties) : cents(set);
  const overageUsd = cents(ai?.overageUsd ?? 0);
  return { ceilingUsd, automatic: set === null, overageUsd, limitUsd: cents(ceilingUsd + overageUsd) };
}

/**
 * One agent's share of a ceiling: its difficulty's allowance, scaled so the league's seats share
 * the ceiling in proportion to their difficulties. With the automatic ceiling (unclamped) that is
 * the difficulty's allowance itself.
 */
export function agentAllowanceUsd(
  difficulty: Difficulty,
  difficulties: readonly Difficulty[],
  ceilingUsd: number
): number {
  const total = difficulties.reduce((sum, d) => sum + DIFFICULTY_WEEKLY_BUDGET_USD[d], 0);
  if (total <= 0) return 0;
  return cents((ceilingUsd * DIFFICULTY_WEEKLY_BUDGET_USD[difficulty]) / total);
}
