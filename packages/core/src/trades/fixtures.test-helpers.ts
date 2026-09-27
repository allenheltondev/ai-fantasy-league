import type { Position } from '../rules/positions.js';
import { yahooDefaultSettings, type LeagueSettings } from '../rules/settings.js';
import type { RosteredPlayer, TeamRosters, TradeContext } from './trade.js';

export const settings: LeagueSettings = yahooDefaultSettings(8);

export function rp(
  playerId: string,
  position: Position,
  nflTeam: string | null = 'KC',
  extra: Partial<RosteredPlayer> = {}
): RosteredPlayer {
  return { playerId, positions: [position], status: 'active', nflTeam, slot: 'BN', ...extra };
}

/** `n` bench players for `team`, all on NFL team `nflTeam`. */
export function squad(team: string, n: number, nflTeam = 'KC'): RosteredPlayer[] {
  return Array.from({ length: n }, (_, i) => rp(`${team}${i}`, 'WR', nflTeam));
}

export const NOW = '2026-10-01T12:00:00.000Z';

export function context(rosters: TeamRosters, extra: Partial<TradeContext> = {}): TradeContext {
  return { now: NOW, currentWeek: 5, rosters, ...extra };
}
