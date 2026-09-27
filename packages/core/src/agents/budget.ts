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
