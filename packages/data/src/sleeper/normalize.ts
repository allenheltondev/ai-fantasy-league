import { normalizeName, normalizeNameNoSuffix, uniqueNonEmpty } from '../names.js';
import type {
  InjuryStatus,
  NflState,
  Player,
  SeasonType,
  StatLine,
  StatMap,
  TrendingEntry
} from '../types.js';
import type {
  SleeperPlayer,
  SleeperPlayers,
  SleeperState,
  SleeperTrending,
  SleeperWeekStats
} from './schemas.js';

const INJURY_STATUS: Record<string, InjuryStatus> = {
  questionable: 'Questionable',
  doubtful: 'Doubtful',
  out: 'Out',
  ir: 'IR',
  pup: 'PUP',
  sus: 'Suspended',
  suspended: 'Suspended',
  na: 'NA'
};

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function normalizeInjuryStatus(raw: string | null | undefined): {
  injuryStatus: InjuryStatus | null;
  injuryStatusRaw?: string;
} {
  const value = clean(raw);
  if (value === null) return { injuryStatus: null };
  const known = INJURY_STATUS[value.toLowerCase()];
  return known ? { injuryStatus: known } : { injuryStatus: 'Other', injuryStatusRaw: value };
}

export function normalizePlayer(raw: SleeperPlayer): Player {
  const firstName = clean(raw.first_name) ?? '';
  const lastName = clean(raw.last_name) ?? '';
  const name = clean(raw.full_name) ?? (`${firstName} ${lastName}`.trim() || raw.player_id);
  const position = clean(raw.position);
  const team = clean(raw.team);
  const searchNames = uniqueNonEmpty([
    normalizeName(name),
    normalizeNameNoSuffix(name),
    ...(position === 'DEF'
      ? [normalizeName(lastName), normalizeName(firstName), raw.player_id.toLowerCase()]
      : [])
  ]);
  const gsisId = clean(raw.gsis_id);
  const jersey = raw.number === null || raw.number === undefined ? NaN : Number(raw.number);
  const player: Player = {
    id: raw.player_id,
    name,
    firstName,
    lastName,
    team,
    position,
    fantasyPositions: raw.fantasy_positions ?? (position ? [position] : []),
    status: clean(raw.status),
    ...normalizeInjuryStatus(raw.injury_status),
    depthChartOrder: raw.depth_chart_order ?? null,
    depthChartPosition: clean(raw.depth_chart_position),
    active: raw.active ?? false,
    searchNames
  };
  if (gsisId) player.gsisId = gsisId;
  if (typeof raw.age === 'number') player.age = raw.age;
  if (typeof raw.years_exp === 'number') player.yearsExp = raw.years_exp;
  if (Number.isFinite(jersey)) player.number = jersey;
  return player;
}

/** Normalizes the players map, sorted by id so output is deterministic. */
export function normalizePlayers(raw: SleeperPlayers): Player[] {
  return Object.entries(raw)
    .map(([key, p]) => normalizePlayer({ ...p, player_id: p.player_id || key }))
    .sort((a, b) => compareIds(a.id, b.id));
}

const SEASON_TYPES: Record<string, SeasonType> = {
  pre: 'pre',
  regular: 'regular',
  post: 'post',
  off: 'off'
};

export function normalizeState(raw: SleeperState): NflState {
  const season = Number(raw.season);
  return {
    season,
    seasonType: SEASON_TYPES[raw.season_type] ?? 'off',
    week: raw.week,
    displayWeek: raw.display_week ?? raw.week,
    leagueSeason: raw.league_season ? Number(raw.league_season) : season,
    previousSeason: raw.previous_season ? Number(raw.previous_season) : season - 1,
    seasonStartDate: clean(raw.season_start_date)
  };
}

export function normalizeStatMap(raw: Record<string, number | null>): StatMap {
  const stats: StatMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== null && Number.isFinite(value)) stats[key] = value;
  }
  return stats;
}

/** Weekly stats or projections → stat lines, sorted by player id. Empty stat maps are dropped. */
export function normalizeWeekStats(raw: SleeperWeekStats, season: number, week: number): StatLine[] {
  const lines: StatLine[] = [];
  for (const [playerId, values] of Object.entries(raw)) {
    const stats = normalizeStatMap(values);
    if (Object.keys(stats).length > 0) lines.push({ playerId, season, week, stats });
  }
  return lines.sort((a, b) => compareIds(a.playerId, b.playerId));
}

export function normalizeTrending(raw: SleeperTrending): TrendingEntry[] {
  return raw.map((t) => ({ playerId: t.player_id, count: t.count }));
}

/** Numeric ids sort numerically, then team-code ids alphabetically. */
export function compareIds(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na !== nb) return na ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
