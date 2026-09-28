import { scorePlayer, yahooDefaultSettings } from '@fantasy/core';
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

function toPlayer(p: SimPlayer, week: number, withInjuries: boolean, rank: number | undefined): Player {
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
  if (rank !== undefined) player.searchRank = rank;
  return player;
}

const RANK_SETTINGS = yahooDefaultSettings();

/**
 * A stand-in for Sleeper's `search_rank` (the consensus rank the draft pool and autopick sort by),
 * which has no history: players ranked by their mean projected half-PPR points over every week
 * projected up to and including `week`. It is captured with that week's projections, so it only
 * uses what was known then. Players never projected get no rank.
 */
export function projectionRanks(archive: SimArchive, week: number): Map<string, number> {
  const sums = new Map<string, { total: number; n: number }>();
  for (const w of archive.manifest.weeks) {
    if (w > week) continue;
    for (const [id, stats] of Object.entries(archive.weeks[w]?.projections.lines ?? {})) {
      const s = sums.get(id) ?? { total: 0, n: 0 };
      sums.set(id, { total: s.total + scorePlayer(RANK_SETTINGS, stats).points, n: s.n + 1 });
    }
  }
  const ordered = [...sums]
    .map(([id, s]) => ({ id, mean: s.total / s.n }))
    .sort((a, b) => b.mean - a.mean || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Map(ordered.map((r, i) => [r.id, i + 1]));
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
    const ranks = projectionRanks(archive, week);
    players.push({
      capturedAt: w.playersCapturedAt,
      data: archive.players.map((p) => toPlayer(p, week, false, ranks.get(p.id)))
    });
    players.push({
      capturedAt: w.injuriesCapturedAt,
      data: archive.players.map((p) => toPlayer(p, week, true, ranks.get(p.id)))
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
