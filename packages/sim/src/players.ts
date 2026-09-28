import {
  normalizePlayerStatus,
  normalizePosition,
  type Position,
  type RosterPlayer,
  type WeekGames
} from '@fantasy/core';
import type { Player, ScheduledGame } from '@fantasy/data';

/** The rules' view of a data-layer player: fantasy positions, normalized status, and NFL team. */
export function toRosterPlayer(p: Player): RosterPlayer {
  const positions: Position[] = [];
  for (const raw of [...p.fantasyPositions, ...(p.position ? [p.position] : [])]) {
    const pos = normalizePosition(raw);
    if (pos && !positions.includes(pos)) positions.push(pos);
  }
  return {
    playerId: p.id,
    name: p.name,
    positions,
    status: normalizePlayerStatus(p.injuryStatus, p.status),
    nflTeam: p.team
  };
}

/** A week's regular-season games keyed by team (a team with no entry is on bye). */
export function weekGames(schedule: readonly ScheduledGame[], week: number): WeekGames {
  const games: Record<string, { kickoff: string }> = {};
  for (const g of schedule) {
    if (g.seasonType !== 'regular' || g.week !== week) continue;
    games[g.homeTeam] = { kickoff: g.kickoff };
    games[g.awayTeam] = { kickoff: g.kickoff };
  }
  return games;
}

/** Sorts strings by code unit (locale-independent), for deterministic output. */
export function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
