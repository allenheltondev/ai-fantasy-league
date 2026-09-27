import { DataNotAvailableError } from '../errors.js';
import { computeByeWeeks } from '../nflverse/schedule.js';
import type { DataProvider, TrendingOptions } from '../provider.js';
import {
  DEFAULT_GAME_DURATION_MS,
  deriveNflState,
  weekBounds,
  type DeriveStateOptions
} from '../state/nfl-state.js';
import type {
  ByeWeeks,
  NflState,
  Player,
  ProjectionLine,
  ScheduledGame,
  StatLine,
  TrendingEntry,
  TrendingType
} from '../types.js';

/** A payload plus the moment it was captured (ISO 8601). */
export interface Captured<T> {
  capturedAt: string;
  data: T;
}

/** Stats may be captured long after the fact (nflverse history), so `capturedAt` is optional. */
export interface StatsVersion {
  /** When this version (for example a stat correction) became known. Omit for "known at final". */
  capturedAt?: string;
  data: StatLine[];
}

/** Everything stored for one season. The shape the simulator replays from. */
export interface SeasonArchive {
  season: number;
  /** Full schedule with final scores; scores are hidden until each game is final at `asOf`. */
  schedule: ScheduledGame[];
  /** Player-universe snapshots. */
  players: Captured<Player[]>[];
  /** Week → stat versions (the last visible version wins, so later versions are corrections). */
  stats: Record<number, StatsVersion[]>;
  /** Week → projection snapshots. */
  projections: Record<number, Captured<ProjectionLine[]>[]>;
  trending?: Partial<Record<TrendingType, Captured<TrendingEntry[]>[]>>;
}

export interface ArchiveStore {
  seasons(): Promise<number[]>;
  load(season: number): Promise<SeasonArchive | undefined>;
}

export class InMemoryArchiveStore implements ArchiveStore {
  readonly #archives = new Map<number, SeasonArchive>();

  constructor(archives: Iterable<SeasonArchive> = []) {
    for (const a of archives) this.put(a);
  }

  put(archive: SeasonArchive): void {
    this.#archives.set(archive.season, archive);
  }

  async seasons(): Promise<number[]> {
    return [...this.#archives.keys()].sort((a, b) => a - b);
  }

  async load(season: number): Promise<SeasonArchive | undefined> {
    return this.#archives.get(season);
  }
}

export interface HistoricalProviderOptions extends DeriveStateOptions {
  /** Kickoff → final assumption for stats and score gating. Default 4 hours. */
  gameDurationMs?: number;
  /** Trending snapshots older than this at `asOf` are treated as absent. Default 48 hours. */
  trendingMaxAgeMs?: number;
}

const ms = (iso: string): number => Date.parse(iso);

/**
 * Serves stored season data exactly as it would have looked at `asOf`:
 * - schedule: always visible, but scores and `final` status only once a game is final;
 * - players / trending: the latest snapshot captured at or before `asOf`;
 * - projections for a player in week W: the latest snapshot captured at or before `asOf` AND
 *   before that player's kickoff (falling back to the week's first kickoff);
 * - stats: a player's line only once his game is final (kickoff + game duration), from the latest
 *   stats version known at `asOf`;
 * - NFL state: derived from the schedule.
 */
export class HistoricalDataProvider implements DataProvider {
  readonly #store: ArchiveStore;
  readonly #options: HistoricalProviderOptions;
  readonly #gameDuration: number;

  constructor(store: ArchiveStore, options: HistoricalProviderOptions = {}) {
    this.#store = store;
    this.#options = options;
    this.#gameDuration = options.gameDurationMs ?? DEFAULT_GAME_DURATION_MS;
  }

  async getSchedule(season: number, asOf: Date): Promise<ScheduledGame[]> {
    const archive = await this.#archive(season);
    return archive.schedule.map((g) => this.#gateGame(g, asOf.getTime()));
  }

  async getByeWeeks(season: number, _asOf: Date): Promise<ByeWeeks> {
    // Byes are published with the schedule in the spring, so they are never future knowledge.
    return computeByeWeeks((await this.#archive(season)).schedule);
  }

  async getNflState(asOf: Date): Promise<NflState> {
    const seasons = (await this.#store.seasons()).sort((a, b) => b - a);
    let fallback: NflState | undefined;
    for (const season of seasons) {
      const archive = await this.#archive(season);
      const state = deriveNflState(season, archive.schedule, asOf, this.#options);
      if (state.seasonType !== 'pre') return state;
      fallback = state;
    }
    if (!fallback) throw new DataNotAvailableError('No seasons in the archive store');
    return fallback;
  }

  async getPlayers(asOf: Date): Promise<Player[]> {
    let best: { snapshot: Captured<Player[]>; archive: SeasonArchive } | undefined;
    for (const season of await this.#store.seasons()) {
      const archive = await this.#archive(season);
      for (const snapshot of archive.players) {
        if (ms(snapshot.capturedAt) <= asOf.getTime()) {
          if (!best || ms(snapshot.capturedAt) > ms(best.snapshot.capturedAt)) best = { snapshot, archive };
        }
      }
    }
    if (!best) {
      throw new DataNotAvailableError(`No player snapshot captured at or before ${asOf.toISOString()}`);
    }
    const byes = computeByeWeeks(best.archive.schedule);
    return best.snapshot.data.map((p) => {
      const bye = p.team ? byes[p.team] : undefined;
      return p.byeWeek === undefined && bye !== undefined ? { ...p, byeWeek: bye } : p;
    });
  }

  async getWeekStats(season: number, week: number, asOf: Date): Promise<StatLine[]> {
    const archive = await this.#archive(season);
    const t = asOf.getTime();
    // A version without capturedAt is the base "known at final" version; captured versions are
    // corrections and win once known. Ties go to the later entry.
    const rank = (v: StatsVersion): number => (v.capturedAt === undefined ? -Infinity : ms(v.capturedAt));
    let version: StatsVersion | undefined;
    for (const v of archive.stats[week] ?? []) {
      if (rank(v) <= t && (!version || rank(v) >= rank(version))) version = v;
    }
    if (!version) return [];
    const kickoffOf = this.#kickoffLookup(archive, week, t, 'last');
    return version.data.filter((line) => kickoffOf(line) + this.#gameDuration <= t);
  }

  async getWeekProjections(season: number, week: number, asOf: Date): Promise<ProjectionLine[]> {
    const archive = await this.#archive(season);
    const t = asOf.getTime();
    const kickoffOf = this.#kickoffLookup(archive, week, t, 'first');
    const snapshots = [...(archive.projections[week] ?? [])]
      .filter((s) => ms(s.capturedAt) <= t)
      .sort((a, b) => ms(b.capturedAt) - ms(a.capturedAt));
    const chosen = new Map<string, ProjectionLine>();
    for (const snapshot of snapshots) {
      const captured = ms(snapshot.capturedAt);
      for (const line of snapshot.data) {
        if (!chosen.has(line.playerId) && captured < kickoffOf(line)) chosen.set(line.playerId, line);
      }
    }
    return [...chosen.values()].sort((a, b) =>
      a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0
    );
  }

  async getTrending(type: TrendingType, asOf: Date, options: TrendingOptions = {}): Promise<TrendingEntry[]> {
    const t = asOf.getTime();
    const maxAge = this.#options.trendingMaxAgeMs ?? 48 * 3_600_000;
    let best: Captured<TrendingEntry[]> | undefined;
    for (const season of await this.#store.seasons()) {
      const archive = await this.#archive(season);
      for (const s of archive.trending?.[type] ?? []) {
        const c = ms(s.capturedAt);
        if (c <= t && t - c <= maxAge && (!best || c > ms(best.capturedAt))) best = s;
      }
    }
    const entries = best?.data ?? [];
    return options.limit !== undefined ? entries.slice(0, options.limit) : entries;
  }

  async #archive(season: number): Promise<SeasonArchive> {
    const archive = await this.#store.load(season);
    if (!archive) throw new DataNotAvailableError(`No archived data for season ${season}`);
    return archive;
  }

  #gateGame(game: ScheduledGame, t: number): ScheduledGame {
    if (game.status === 'final' && ms(game.kickoff) + this.#gameDuration <= t) return game;
    const { homeScore: _h, awayScore: _a, ...rest } = game;
    return { ...rest, status: 'scheduled' };
  }

  /**
   * Resolves a line's kickoff: its team's game that week, else the team from the latest player
   * snapshot known at `t`, else the week's first or last kickoff, whichever is conservative for
   * the caller (stats wait for the last game; projections must predate the first). A week with no
   * games hides everything.
   */
  #kickoffLookup(
    archive: SeasonArchive,
    week: number,
    t: number,
    unknown: 'first' | 'last'
  ): (line: StatLine) => number {
    const games = archive.schedule.filter((g) => g.week === week);
    const byTeam = new Map<string, number>();
    for (const g of games) {
      byTeam.set(g.homeTeam, ms(g.kickoff));
      byTeam.set(g.awayTeam, ms(g.kickoff));
    }
    const bounds = weekBounds(games)[0];
    const fallback = !bounds
      ? unknown === 'last'
        ? Number.POSITIVE_INFINITY
        : Number.NEGATIVE_INFINITY
      : unknown === 'last'
        ? bounds.lastKickoff
        : bounds.firstKickoff;
    let teams: Map<string, string | null> | undefined;
    const teamOf = (playerId: string): string | null | undefined => {
      if (!teams) {
        teams = new Map();
        const snapshot = [...archive.players]
          .filter((s) => ms(s.capturedAt) <= t)
          .sort((a, b) => ms(b.capturedAt) - ms(a.capturedAt))[0];
        for (const p of snapshot?.data ?? []) teams.set(p.id, p.team);
      }
      return teams.get(playerId);
    };
    return (line) => {
      const team = line.team ?? teamOf(line.playerId);
      return (team ? byTeam.get(team) : undefined) ?? fallback;
    };
  }
}

/**
 * Builds a season archive from nflverse history (for replaying seasons Sleeper data was not
 * recorded for). Only regular-season lines are kept, keyed by week, as base "known at final"
 * versions. Players and projections come from recorded snapshots, if any.
 */
export function buildArchiveFromNflverse(input: {
  season: number;
  schedule: readonly ScheduledGame[];
  weeklyStats: readonly (StatLine & { seasonType?: 'regular' | 'post' })[];
  players?: Captured<Player[]>[];
}): SeasonArchive {
  const byWeek = new Map<number, StatLine[]>();
  for (const line of input.weeklyStats) {
    if (line.season !== input.season || (line.seasonType ?? 'regular') !== 'regular') continue;
    const plain: StatLine = {
      playerId: line.playerId,
      season: line.season,
      week: line.week,
      stats: line.stats
    };
    if (line.team) plain.team = line.team;
    byWeek.set(line.week, [...(byWeek.get(line.week) ?? []), plain]);
  }
  const stats: Record<number, StatsVersion[]> = {};
  for (const [week, lines] of byWeek) stats[week] = [{ data: lines }];
  return {
    season: input.season,
    schedule: input.schedule.filter((g) => g.season === input.season),
    players: input.players ?? [],
    stats,
    projections: {}
  };
}
