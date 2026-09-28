import { FixedClock } from '@fantasy/core';
import type {
  ByeWeeks,
  DataProvider,
  NflState,
  Player as SourcePlayer,
  ProjectionLine,
  ScheduledGame,
  StatLine,
  TrendingEntry,
  TrendingOptions,
  TrendingType
} from '@fantasy/data';
import { InMemoryEventPublisher } from '../../src/events/publisher.js';
import type { JobDeps, NewsSource } from '../../src/jobs/deps.js';
import type { FeedConfig } from '../../src/jobs/news/feeds.js';
import { silentLogger } from '../../src/log.js';
import { PlayerDirectory } from '../../src/players/directory.js';
import { createInMemoryReferenceStore } from '../../src/repos/memory-reference.js';
import { createInMemoryRepos, InMemoryPlayerRepository } from '../../src/repos/memory.js';

/**
 * A DataProvider whose answers tests set directly. Every call is recorded; an unset answer
 * throws, so a job that reaches for data it should not (outside a game window, say) fails loudly.
 */
export class StubProvider implements DataProvider {
  players: SourcePlayer[] | null = null;
  state: NflState | null = null;
  stats: StatLine[] | null = null;
  projections: Record<number, ProjectionLine[]> = {};
  trending: Partial<Record<TrendingType, TrendingEntry[]>> = {};
  schedule: ScheduledGame[] | null = null;
  byes: ByeWeeks = {};
  readonly calls: string[] = [];
  readonly trendingOptions: TrendingOptions[] = [];

  async getPlayers(): Promise<SourcePlayer[]> {
    this.calls.push('getPlayers');
    return structuredClone(required(this.players, 'players'));
  }

  async getNflState(): Promise<NflState> {
    this.calls.push('getNflState');
    return structuredClone(required(this.state, 'state'));
  }

  async getWeekStats(season: number, week: number): Promise<StatLine[]> {
    this.calls.push(`getWeekStats:${season}:${week}`);
    return structuredClone(required(this.stats, 'stats'));
  }

  async getWeekProjections(season: number, week: number): Promise<ProjectionLine[]> {
    this.calls.push(`getWeekProjections:${season}:${week}`);
    return structuredClone(this.projections[week] ?? []);
  }

  async getTrending(
    type: TrendingType,
    _asOf: Date,
    options: TrendingOptions = {}
  ): Promise<TrendingEntry[]> {
    this.calls.push(`getTrending:${type}`);
    this.trendingOptions.push(options);
    return structuredClone(this.trending[type] ?? []);
  }

  async getSchedule(season: number): Promise<ScheduledGame[]> {
    this.calls.push(`getSchedule:${season}`);
    return structuredClone(required(this.schedule, 'schedule'));
  }

  async getByeWeeks(season: number): Promise<ByeWeeks> {
    this.calls.push(`getByeWeeks:${season}`);
    return structuredClone(this.byes);
  }
}

function required<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`StubProvider: ${name} was not set`);
  return value;
}

export class FakeNewsSource implements NewsSource {
  readonly bodies = new Map<string, string | Error>();
  readonly fetched: string[] = [];

  constructor(public list: FeedConfig[] = []) {}

  async feeds(): Promise<FeedConfig[]> {
    return this.list;
  }

  async fetchText(url: string): Promise<string> {
    this.fetched.push(url);
    const body = this.bodies.get(url);
    if (body === undefined) throw new Error(`no body for ${url}`);
    if (body instanceof Error) throw body;
    return body;
  }
}

export interface TestJobDeps extends JobDeps {
  events: InMemoryEventPublisher;
  news: FakeNewsSource;
  playerRepo: InMemoryPlayerRepository;
}

/** In-memory job dependencies around `provider` (a StubProvider by default). */
export function createTestJobDeps(
  options: { provider?: DataProvider; clock?: FixedClock } = {}
): TestJobDeps & { clock: FixedClock } {
  const clock = options.clock ?? new FixedClock('2025-09-04T12:00:00.000Z');
  const playerRepo = new InMemoryPlayerRepository();
  return {
    provider: options.provider ?? new StubProvider(),
    reference: createInMemoryReferenceStore(playerRepo),
    repos: createInMemoryRepos(),
    events: new InMemoryEventPublisher(),
    directory: new PlayerDirectory({ repo: playerRepo, clock }),
    log: silentLogger,
    news: new FakeNewsSource(),
    playerRepo,
    clock
  };
}

export function sourcePlayer(overrides: Partial<SourcePlayer> & { id: string }): SourcePlayer {
  return {
    name: `Player ${overrides.id}`,
    firstName: 'Player',
    lastName: overrides.id,
    team: 'KC',
    position: 'WR',
    fantasyPositions: ['WR'],
    status: 'Active',
    injuryStatus: null,
    depthChartOrder: 1,
    depthChartPosition: 'WR',
    active: true,
    searchNames: [`player ${overrides.id}`],
    ...overrides
  };
}

export function game(overrides: Partial<ScheduledGame> & { gameId: string; kickoff: string }): ScheduledGame {
  return {
    season: 2025,
    seasonType: 'regular',
    week: 1,
    homeTeam: 'PHI',
    awayTeam: 'DAL',
    status: 'scheduled',
    ...overrides
  };
}

export function nflState(overrides: Partial<NflState> = {}): NflState {
  return {
    season: 2025,
    seasonType: 'regular',
    week: 1,
    displayWeek: 1,
    leagueSeason: 2025,
    previousSeason: 2024,
    seasonStartDate: '2025-09-04',
    ...overrides
  };
}
