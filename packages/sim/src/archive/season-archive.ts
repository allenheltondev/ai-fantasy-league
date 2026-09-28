import {
  normalizeName,
  normalizeNameNoSuffix,
  uniqueNonEmpty,
  type Captured,
  type InjuryStatus,
  type Player,
  type ProjectionLine,
  type SeasonArchive,
  type StatLine
} from '@fantasy/data';
import type { SimArchive, SimPlayer } from './format.js';

function toPlayer(p: SimPlayer, week: number, withInjuries: boolean): Player {
  const team = p.teams[week] ?? null;
  const injury = withInjuries ? (p.injuries?.[week] ?? null) : null;
  const player: Player = {
    id: p.id,
    name: p.name,
    firstName: p.firstName,
    lastName: p.lastName,
    team,
    position: p.position,
    fantasyPositions: [p.position],
    status: injury === 'IR' ? 'Injured Reserve' : 'Active',
    injuryStatus: injury as InjuryStatus | null,
    depthChartOrder: null,
    depthChartPosition: null,
    active: true,
    searchNames: uniqueNonEmpty([
      normalizeName(p.name),
      normalizeNameNoSuffix(p.name),
      ...(p.position === 'DEF' ? [normalizeName(p.lastName), p.id.toLowerCase()] : [])
    ])
  };
  if (p.gsisId) player.gsisId = p.gsisId;
  return player;
}

/**
 * Converts a simulator archive into `@fantasy/data`'s `SeasonArchive`, so `HistoricalDataProvider` serves
 * it with its as-of gating:
 * - two player snapshots per week: teams at the projection capture, then injury designations before the
 *   first kickoff;
 * - one stats version per week, known when each game is final;
 * - one projection snapshot and one trending snapshot per week.
 */
export function toSeasonArchive(archive: SimArchive): SeasonArchive {
  const season = archive.manifest.season;
  const players: Captured<Player[]>[] = [];
  const stats: SeasonArchive['stats'] = {};
  const projections: SeasonArchive['projections'] = {};
  const add: Captured<{ playerId: string; count: number }[]>[] = [];
  const byId = new Map(archive.players.map((p) => [p.id, p]));
  const lineOf = (week: number, playerId: string, values: Record<string, number>): StatLine => {
    const line: StatLine = { playerId, season, week, stats: { ...values } };
    const team = byId.get(playerId)?.teams[week];
    if (team) line.team = team;
    return line;
  };
  for (const week of archive.manifest.weeks) {
    const w = archive.weeks[week];
    if (!w) continue;
    players.push({
      capturedAt: w.playersCapturedAt,
      data: archive.players.map((p) => toPlayer(p, week, false))
    });
    players.push({
      capturedAt: w.injuriesCapturedAt,
      data: archive.players.map((p) => toPlayer(p, week, true))
    });
    stats[week] = [{ data: Object.entries(w.stats).map(([id, values]) => lineOf(week, id, values)) }];
    const lines: ProjectionLine[] = Object.entries(w.projections.lines).map(([id, values]) =>
      lineOf(week, id, values)
    );
    projections[week] = [{ capturedAt: w.projections.capturedAt, data: lines }];
    add.push({ capturedAt: w.trending.capturedAt, data: w.trending.add });
  }
  return {
    season,
    schedule: archive.schedule.map((g) => ({ ...g })),
    players,
    stats,
    projections,
    trending: { add, drop: [] }
  };
}
