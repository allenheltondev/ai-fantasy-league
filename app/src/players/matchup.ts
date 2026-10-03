import type { StatusBadgeTone } from '@readysetcloud/ui';
import { ordinal } from '../draft/DraftResults';

/**
 * Matchup strength from get_points_allowed's ranks (1 allows the most fantasy points to a
 * position, `of` the fewest), and the player card's bio line.
 */

export type MatchupStrength = 'favorable' | 'neutral' | 'tough';

/** The top third of defenses by points allowed is a favorable matchup; the bottom third is tough. */
export function matchupStrength(rank: number, of: number): MatchupStrength {
  if (of < 3) return 'neutral';
  if (rank <= of / 3) return 'favorable';
  if (rank > (2 * of) / 3) return 'tough';
  return 'neutral';
}

export const MATCHUP_LABEL: Readonly<Record<MatchupStrength, string>> = {
  favorable: 'Favorable matchup',
  neutral: 'Average matchup',
  tough: 'Tough matchup'
};

export const MATCHUP_TONE: Readonly<Record<MatchupStrength, StatusBadgeTone>> = {
  favorable: 'success',
  neutral: 'neutral',
  tough: 'error'
};

/** Sleeper's `years_exp` counts seasons before this one: 0 is a rookie, 5 is his 6th season. */
export function experienceText(yearsExp: number): string {
  return yearsExp === 0 ? 'Rookie' : `${ordinal(yearsExp + 1)} season`;
}

/** "QBs", "kickers", "team defenses": who a defense allows points to. */
export function positionPlural(position: string): string {
  if (position === 'K') return 'kickers';
  if (position === 'DEF') return 'team defenses';
  return `${position}s`;
}
