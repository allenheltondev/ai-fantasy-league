import { normalizePosition } from '@fantasy/core';
import {
  IdCrosswalk,
  computeByeWeeks,
  csvNumber,
  csvValue,
  parseCsvObjects,
  parseIdMap,
  parseNflverseSchedule,
  parseNflverseWeeklyStats,
  toSleeperTeam,
  type CrosswalkEntry,
  type NflverseStatLine,
  type ScheduledGame,
  type StatMap
} from '@fantasy/data';
import { iso, weekMoments, type WeekMoments } from '../clock/moments.js';
import { DEFENSE_METHOD, TEAM_NAMES, deriveDefenseLines } from './defense.js';
import {
  SIM_ARCHIVE_VERSION,
  type ArchiveInjury,
  type ArchivePosition,
  type ArchiveWeek,
  type SimArchive,
  type SimPlayer
} from './format.js';
import {
  DEFAULT_PROJECTION_OPTIONS,
  averageLines,
  describeProjectionMethod,
  projectWeek,
  trendingAdds,
  type ProjectionOptions
} from './projections.js';

/** Raw source files (CSV text) an archive is built from. Only the schedule, stats, and id map are required. */
export interface ArchiveSources {
  season: number;
  /** nflverse `games.csv` (schedule with kickoffs and final scores). */
  gamesCsv: string;
  /** nflverse `stats_player_week_{season}.csv`. */
  playerStatsCsv: string;
  /** nflverse `stats_player_week_{season - 1}.csv`, for the preseason projection baseline. */
  priorPlayerStatsCsv?: string;
  /** nflverse `stats_team_week_{season}.csv`, for DEF sacks, takeaways, and touchdowns. */
  teamStatsCsv?: string;
  /** nflverse `stats_team_week_{season - 1}.csv`, for the DEF baseline. */
  priorTeamStatsCsv?: string;
  /** dynastyprocess `db_playerids.csv` (Sleeper ↔ GSIS). */
  idMapCsv: string;
  /** nflverse `roster_weekly_{season}.csv`: team and roster status by week, plus Sleeper ids. */
  rostersCsv?: string;
  /** nflverse `injuries_{season}.csv`: game-status designations by week. */
  injuriesCsv?: string;
  /** Source URLs, recorded in the manifest. */
  sourceUrls?: string[];
}

export interface BuildArchiveOptions {
  projection?: ProjectionOptions;
  /** Trending adds kept per week. Default 25. */
  trendingLimit?: number;
}

const OFFENSE: readonly ArchivePosition[] = ['QB', 'RB', 'WR', 'TE', 'K'];

function fantasyPosition(raw: string | null | undefined): ArchivePosition | null {
  const p = raw ? normalizePosition(raw) : null;
  return p !== null && (OFFENSE as readonly string[]).includes(p) ? (p as ArchivePosition) : null;
}

/** Roster statuses that keep a player on his team for the week. */
const ON_TEAM = new Set(['ACT', 'INA', 'RES', 'DEV', 'EXE']);

interface RosterFacts {
  /** week → gsis → team (null when released). */
  teams: Map<number, Map<string, string | null>>;
  /** week → gsis → true when on reserve (IR). */
  reserve: Map<number, Set<string>>;
  sleeperIds: Map<string, string>;
  names: Map<string, { name: string; first: string; last: string; position: string | null }>;
}

function readRosters(csv: string | undefined, season: number): RosterFacts {
  const facts: RosterFacts = {
    teams: new Map(),
    reserve: new Map(),
    sleeperIds: new Map(),
    names: new Map()
  };
  if (!csv) return facts;
  const rows = parseCsvObjects(
    csv,
    ['season', 'team', 'position', 'status', 'full_name', 'gsis_id', 'week', 'game_type'],
    'nflverse roster_weekly'
  );
  for (const row of rows) {
    const gsis = csvValue(row, 'gsis_id');
    const week = csvNumber(row, 'week');
    if (!gsis || week === undefined || csvNumber(row, 'season') !== season) continue;
    if (csvValue(row, 'game_type') !== 'REG') continue;
    const status = csvValue(row, 'status') ?? '';
    const teams = facts.teams.get(week) ?? new Map<string, string | null>();
    facts.teams.set(week, teams);
    teams.set(gsis, ON_TEAM.has(status) ? toSleeperTeam(csvValue(row, 'team')) : null);
    if (status === 'RES') {
      const set = facts.reserve.get(week) ?? new Set<string>();
      set.add(gsis);
      facts.reserve.set(week, set);
    }
    const sleeper = csvValue(row, 'sleeper_id');
    if (sleeper && !facts.sleeperIds.has(gsis)) facts.sleeperIds.set(gsis, sleeper);
    facts.names.set(gsis, {
      name: csvValue(row, 'full_name') ?? gsis,
      first: csvValue(row, 'first_name') ?? '',
      last: csvValue(row, 'last_name') ?? '',
      position: csvValue(row, 'position') ?? null
    });
  }
  return facts;
}

/** week → gsis → designation (Out, Doubtful, Questionable) from the injury report. */
function readInjuries(csv: string | undefined, season: number): Map<number, Map<string, ArchiveInjury>> {
  const out = new Map<number, Map<string, ArchiveInjury>>();
  if (!csv) return out;
  const rows = parseCsvObjects(csv, ['season', 'week', 'gsis_id', 'report_status'], 'nflverse injuries');
  for (const row of rows) {
    const gsis = csvValue(row, 'gsis_id');
    const week = csvNumber(row, 'week');
    const status = csvValue(row, 'report_status');
    if (!gsis || week === undefined || csvNumber(row, 'season') !== season) continue;
    if (csvValue(row, 'season_type') !== undefined && csvValue(row, 'season_type') !== 'REG') continue;
    if (status !== 'Out' && status !== 'Doubtful' && status !== 'Questionable') continue;
    const map = out.get(week) ?? new Map<string, ArchiveInjury>();
    map.set(gsis, status);
    out.set(week, map);
  }
  return out;
}

/** Sleeper ↔ GSIS: the id map first, then Sleeper ids carried by the weekly rosters. */
function buildIdCrosswalk(idMapCsv: string, rosterSleeperIds: ReadonlyMap<string, string>): IdCrosswalk {
  const crosswalk = new IdCrosswalk();
  for (const row of parseIdMap(idMapCsv)) {
    if (row.gsisId && row.sleeperId)
      crosswalk.add({ sleeperId: row.sleeperId, gsisId: row.gsisId, method: 'idmap' });
  }
  for (const [gsisId, sleeperId] of [...rosterSleeperIds].sort(([a], [b]) => a.localeCompare(b))) {
    crosswalk.add({ sleeperId, gsisId, method: 'sleeper' });
  }
  return crosswalk;
}

function splitName(name: string): [string, string] {
  const i = name.indexOf(' ');
  return i < 0 ? [name, ''] : [name.slice(0, i), name.slice(i + 1)];
}

/**
 * Builds a compact season archive from nflverse sources. Pure: all input is passed in, nothing reads the
 * network, the filesystem, or the clock, so the same sources always produce the same archive.
 *
 * Only regular-season weeks whose games are all final are archived. Players are the fantasy-relevant
 * ones (QB, RB, WR, TE, K) with a regular-season stat line this season, or last season and on a roster
 * this season, plus the 32 team defenses.
 */
export function buildSimArchive(sources: ArchiveSources, options: BuildArchiveOptions = {}): SimArchive {
  const { season } = sources;
  const projectionOptions = options.projection ?? DEFAULT_PROJECTION_OPTIONS;
  const schedule: ScheduledGame[] = parseNflverseSchedule(sources.gamesCsv, season);
  const moments = weekMoments(schedule);
  const weeks = [...moments.keys()].filter((w) =>
    schedule.filter((g) => g.seasonType === 'regular' && g.week === w).every((g) => g.status === 'final')
  );

  const rosters = readRosters(sources.rostersCsv, season);
  const injuries = readInjuries(sources.injuriesCsv, season);
  const crosswalk = buildIdCrosswalk(sources.idMapCsv, rosters.sleeperIds);

  const isRegular = (l: NflverseStatLine): boolean => l.seasonType === 'regular';
  const current = parseNflverseWeeklyStats(sources.playerStatsCsv, crosswalk).filter(
    (l) => isRegular(l) && l.season === season && fantasyPosition(l.position) !== null
  );
  const prior = sources.priorPlayerStatsCsv
    ? parseNflverseWeeklyStats(sources.priorPlayerStatsCsv, crosswalk).filter(
        (l) => isRegular(l) && l.season === season - 1 && fantasyPosition(l.position) !== null
      )
    : [];

  // Player universe (keyed by GSIS id).
  const onRosterThisSeason = new Set<string>();
  for (const week of rosters.teams.values())
    for (const [gsis, team] of week) if (team) onRosterThisSeason.add(gsis);
  const meta = new Map<string, { name: string; position: ArchivePosition }>();
  for (const l of current)
    meta.set(l.gsisId, { name: l.name, position: fantasyPosition(l.position) as ArchivePosition });
  for (const l of prior) {
    if (!meta.has(l.gsisId) && onRosterThisSeason.has(l.gsisId)) {
      meta.set(l.gsisId, { name: l.name, position: fantasyPosition(l.position) as ArchivePosition });
    }
  }
  const idOf = (gsis: string): string => crosswalk.toSleeper(gsis) ?? gsis;

  // Actual stats by week, and history by player.
  const weekSet = new Set(weeks);
  const stats = new Map<number, Map<string, StatMap>>();
  const statTeam = new Map<number, Map<string, string>>();
  for (const l of current) {
    if (!weekSet.has(l.week)) continue;
    const id = idOf(l.gsisId);
    const map = stats.get(l.week) ?? new Map<string, StatMap>();
    map.set(id, l.stats);
    stats.set(l.week, map);
    if (l.team) {
      const teams = statTeam.get(l.week) ?? new Map<string, string>();
      teams.set(l.gsisId, l.team);
      statTeam.set(l.week, teams);
    }
  }
  const defense = deriveDefenseLines(schedule, season, sources.teamStatsCsv);
  for (const [week, lines] of defense) {
    if (!weekSet.has(week)) continue;
    const map = stats.get(week) ?? new Map<string, StatMap>();
    for (const [team, line] of lines) map.set(team, line);
    stats.set(week, map);
  }

  // Prior-season baselines.
  const priorLines = new Map<string, StatMap[]>();
  for (const l of prior) {
    const id = idOf(l.gsisId);
    priorLines.set(id, [...(priorLines.get(id) ?? []), l.stats]);
  }
  const priorSchedule = parseNflverseSchedule(sources.gamesCsv, season - 1);
  for (const lines of deriveDefenseLines(priorSchedule, season - 1, sources.priorTeamStatsCsv).values()) {
    for (const [team, line] of lines) priorLines.set(team, [...(priorLines.get(team) ?? []), line]);
  }
  const baselines = new Map<string, StatMap>();
  for (const [id, lines] of priorLines) {
    const avg = averageLines(lines);
    if (avg) baselines.set(id, avg);
  }

  // Players with teams by week.
  const lastPriorTeam = new Map<string, string>();
  for (const l of [...prior].sort((a, b) => a.week - b.week)) if (l.team) lastPriorTeam.set(l.gsisId, l.team);
  const players: SimPlayer[] = [];
  for (const [gsis, m] of [...meta].sort(([a], [b]) => a.localeCompare(b))) {
    const named = rosters.names.get(gsis);
    const [first, last] = named ? [named.first, named.last] : splitName(m.name);
    const teams: Record<string, string | null> = {};
    const hurt: Record<string, ArchiveInjury> = {};
    let known: string | null = lastPriorTeam.get(gsis) ?? null;
    for (const week of weeks) {
      const weekRoster = rosters.teams.get(week);
      const fromStats = statTeam.get(week)?.get(gsis);
      // The team he played for that week (known before kickoff), else that week's roster, else his last team.
      const team = fromStats ?? (weekRoster ? (weekRoster.get(gsis) ?? null) : known);
      teams[week] = team;
      if (team) known = team;
      const designation = rosters.reserve.get(week)?.has(gsis) ? 'IR' : injuries.get(week)?.get(gsis);
      if (designation) hurt[week] = designation;
    }
    const player: SimPlayer = {
      id: idOf(gsis),
      gsisId: gsis,
      name: named?.name ?? m.name,
      firstName: first,
      lastName: last,
      position: m.position,
      teams
    };
    if (Object.keys(hurt).length > 0) player.injuries = hurt;
    players.push(player);
  }
  const teamCodes = [...new Set(schedule.flatMap((g) => [g.homeTeam, g.awayTeam]))].sort();
  for (const team of teamCodes) {
    const [city, nickname] = TEAM_NAMES[team] ?? [team, 'Defense'];
    const teams: Record<string, string | null> = {};
    for (const week of weeks) teams[week] = team;
    players.push({
      id: team,
      name: `${city} ${nickname}`,
      firstName: city,
      lastName: nickname,
      position: 'DEF',
      teams
    });
  }
  players.sort((a, b) => a.id.localeCompare(b.id));

  // Projections and trending, week by week, from earlier weeks only.
  const playsIn = (week: number): Set<string> =>
    new Set(
      schedule
        .filter((g) => g.seasonType === 'regular' && g.week === week)
        .flatMap((g) => [g.homeTeam, g.awayTeam])
    );
  const archiveWeeks: Record<number, ArchiveWeek> = {};
  let previousProjection: Record<string, StatMap> | undefined;
  for (const week of weeks) {
    const m = moments.get(week) as WeekMoments;
    // Each player's games before this week, most recent first. Later weeks are never read.
    const history = new Map<string, StatMap[]>();
    for (const w of [...stats.keys()].filter((x) => x < week).sort((a, b) => b - a)) {
      for (const [id, line] of stats.get(w) ?? []) history.set(id, [...(history.get(id) ?? []), line]);
    }
    const playing = playsIn(week);
    const eligible = players.filter((p) => {
      const team = p.teams[week];
      return team !== null && team !== undefined && playing.has(team);
    });
    const lines = projectWeek({
      week,
      history,
      baselines,
      eligible: eligible.map((p) => p.id),
      options: projectionOptions
    });
    const weekStats: Record<string, StatMap> = {};
    for (const [id, line] of [...(stats.get(week) ?? [])].sort(([a], [b]) => a.localeCompare(b))) {
      weekStats[id] = line;
    }
    archiveWeeks[week] = {
      week,
      stats: weekStats,
      projections: { capturedAt: iso(m.projectionsAt), lines },
      trending: {
        capturedAt: iso(m.projectionsAt),
        add: trendingAdds(previousProjection, lines, options.trendingLimit)
      },
      playersCapturedAt: iso(m.projectionsAt),
      injuriesCapturedAt: iso(m.injuriesAt)
    };
    previousProjection = lines;
  }

  const usedIds = new Set(players.map((p) => p.gsisId).filter((g): g is string => g !== undefined));
  const crosswalkEntries: CrosswalkEntry[] = crosswalk
    .entries()
    .filter((e) => usedIds.has(e.gsisId))
    .sort((a, b) => a.sleeperId.localeCompare(b.sleeperId));

  const notes = [
    'Player statuses come only from injury designations (Questionable, Doubtful, Out) and reserve (IR) lists; ' +
      "injury designations are visible from 2 hours before the week's first kickoff, which is up to about two " +
      "days before Sunday teams' final reports.",
    "A player's team for week W comes from his stat line that week, else the weekly roster, else his last known team.",
    'Players without a Sleeper id keep their GSIS id as their player id.'
  ];
  if (!sources.teamStatsCsv) notes.push('No team stats were supplied: DEF lines carry points allowed only.');
  if (!sources.priorPlayerStatsCsv)
    notes.push('No prior-season stats were supplied: weeks 1-3 have no baseline.');

  return {
    manifest: {
      version: SIM_ARCHIVE_VERSION,
      season,
      weeks,
      provenance: {
        sources: sources.sourceUrls ?? [],
        projectionMethod: describeProjectionMethod(projectionOptions),
        defenseMethod: DEFENSE_METHOD,
        notes
      },
      fixture: false
    },
    schedule,
    byeWeeks: computeByeWeeks(schedule),
    crosswalk: crosswalkEntries,
    players,
    weeks: archiveWeeks
  };
}
