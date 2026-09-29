import type { EspnClient } from '../espn/client.js';
import { normalizeInjuries } from '../espn/injuries.js';
import { normalizeScoreboard, normalizeScoringPlays } from '../espn/normalize.js';
import type { NflverseClient } from '../nflverse/client.js';
import {
  applyCrosswalk,
  buildCrosswalk,
  type CrosswalkReport,
  type IdCrosswalk
} from '../nflverse/crosswalk.js';
import { reconcileWithNflverse } from '../nflverse/reconcile.js';
import { computeByeWeeks } from '../nflverse/schedule.js';
import type { DataProvider, TrendingOptions } from '../provider.js';
import type { ProjectionSource, SleeperClient } from '../sleeper/client.js';
import {
  normalizePlayers,
  normalizeState,
  normalizeTrending,
  normalizeWeekStats
} from '../sleeper/normalize.js';
import type {
  ByeWeeks,
  InjuryReport,
  LiveGame,
  NflState,
  Player,
  ProjectionLine,
  ScheduledGame,
  ScoringPlay,
  StatLine,
  TrendingEntry,
  TrendingType
} from '../types.js';

export interface LiveProviderOptions {
  sleeper: SleeperClient;
  nflverse: NflverseClient;
  /**
   * ESPN's scoreboard, for live games (scores, possession, red zone), and game summaries (scoring
   * plays). Without it `getLiveGames` and `getScoringPlays` return [].
   */
  espn?: EspnClient;
  /** Fill missing/incorrect `gsisId`s from the dynastyprocess ID map (one ~2.6 MB fetch). Default true. */
  crosswalk?: boolean;
  /** Receives the crosswalk report on each `getPlayers` call (for logging and alerting). */
  onCrosswalkReport?: (report: CrosswalkReport) => void;
}

/**
 * Live data: Sleeper for players, state, stats, projections, and trending; nflverse for the
 * schedule and ID map; ESPN's scoreboard for live games. A live source cannot serve the past, so `asOf` is accepted for interface
 * parity and ignored: it always returns the latest data (which never includes the future).
 * Schedules are cached per season for the provider's lifetime.
 */
export class LiveDataProvider implements DataProvider {
  readonly #sleeper: SleeperClient;
  readonly #nflverse: NflverseClient;
  readonly #options: LiveProviderOptions;
  readonly #schedules = new Map<number, Promise<ScheduledGame[]>>();
  readonly #projectionSources = new Map<string, ProjectionSource>();

  constructor(options: LiveProviderOptions) {
    this.#sleeper = options.sleeper;
    this.#nflverse = options.nflverse;
    this.#options = options;
  }

  async getPlayers(asOf: Date): Promise<Player[]> {
    const [rawPlayers, state] = await Promise.all([this.#sleeper.players(), this.getNflState(asOf)]);
    let players = normalizePlayers(rawPlayers);
    if (this.#options.crosswalk ?? true) {
      const { crosswalk, report } = buildCrosswalk(players, await this.#nflverse.idMap());
      this.#options.onCrosswalkReport?.(report);
      players = applyCrosswalk(players, crosswalk);
    }
    const byes = await this.getByeWeeks(state.leagueSeason, asOf);
    return players.map((p) => {
      const bye = p.team ? byes[p.team] : undefined;
      return bye === undefined ? p : { ...p, byeWeek: bye };
    });
  }

  async getNflState(_asOf: Date): Promise<NflState> {
    return normalizeState(await this.#sleeper.state());
  }

  async getWeekStats(season: number, week: number, _asOf: Date): Promise<StatLine[]> {
    return normalizeWeekStats(await this.#sleeper.weekStats(season, week), season, week);
  }

  /**
   * The week re-pulled from Sleeper and reconciled with nflverse's weekly file
   * (`reconcileWithNflverse`), for the Thursday official final.
   */
  async getOfficialWeekStats(
    season: number,
    week: number,
    asOf: Date,
    crosswalk?: IdCrosswalk
  ): Promise<StatLine[]> {
    const [primary, official] = await Promise.all([
      this.getWeekStats(season, week, asOf),
      this.#nflverse.weeklyStats(season, crosswalk)
    ]);
    return reconcileWithNflverse(
      primary,
      official.filter((l) => l.week === week && l.seasonType === 'regular')
    );
  }

  /** Sleeper's v1 projections, or its app endpoint when v1 has none (#184; `projectionSource`). */
  async getWeekProjections(season: number, week: number, _asOf: Date): Promise<ProjectionLine[]> {
    const { stats, source } = await this.#sleeper.weekProjectionsWithSource(season, week);
    this.#projectionSources.set(`${season}#${week}`, source);
    return normalizeWeekStats(stats, season, week, 'projections');
  }

  projectionSource(season: number, week: number): ProjectionSource | undefined {
    return this.#projectionSources.get(`${season}#${week}`);
  }

  async getTrending(
    type: TrendingType,
    _asOf: Date,
    options: TrendingOptions = {}
  ): Promise<TrendingEntry[]> {
    return normalizeTrending(await this.#sleeper.trending(type, options));
  }

  getSchedule(season: number, _asOf: Date): Promise<ScheduledGame[]> {
    let pending = this.#schedules.get(season);
    if (!pending) {
      pending = this.#nflverse.schedule(season);
      pending.catch(() => this.#schedules.delete(season));
      this.#schedules.set(season, pending);
    }
    return pending;
  }

  async getByeWeeks(season: number, asOf: Date): Promise<ByeWeeks> {
    return computeByeWeeks(await this.getSchedule(season, asOf));
  }

  /** ESPN's scoreboard for the week, matched to our schedule's games. */
  async getLiveGames(
    season: number,
    week: number,
    asOf: Date,
    games?: readonly ScheduledGame[]
  ): Promise<LiveGame[]> {
    const espn = this.#options.espn;
    if (espn === undefined) return [];
    const [board, schedule] = await Promise.all([
      espn.scoreboard(season, week),
      games ??
        this.getSchedule(season, asOf).then((all) =>
          all.filter((g) => g.week === week && g.seasonType === 'regular')
        )
    ]);
    return normalizeScoreboard(board, { games: schedule, asOf });
  }

  /** ESPN's game summary: the game's scoring plays with their descriptions (#164). */
  async getScoringPlays(espnId: string, _asOf: Date): Promise<ScoringPlay[]> {
    const espn = this.#options.espn;
    if (espn === undefined) return [];
    return normalizeScoringPlays(await espn.summary(espnId));
  }

  /** ESPN's injury report (#200); [] without an ESPN client. */
  async getInjuries(_asOf: Date): Promise<InjuryReport[]> {
    const espn = this.#options.espn;
    if (espn === undefined) return [];
    return normalizeInjuries(await espn.injuries());
  }
}
