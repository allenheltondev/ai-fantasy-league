import { leagueExists, staleLeague } from './errors.js';
import { InMemoryAgentRepository } from './memory-agents.js';
import type { Player, Position } from '../players/model.js';
import type {
  AuditEntry,
  AuditQuery,
  AuditRepository,
  IdempotencyBeginInput,
  IdempotencyBeginResult,
  IdempotencyRepository,
  League,
  LeagueRepository,
  PlayerRepository,
  Repos,
  StoredResponse
} from './types.js';

const clone = <T>(value: T): T => structuredClone(value);

interface IdempotencyRecord {
  operation: string;
  requestHash: string;
  state: 'in_progress' | 'complete';
  lockUntil: number;
  expiresAt: number;
  response: StoredResponse | null;
}

export class InMemoryIdempotencyRepository implements IdempotencyRepository {
  readonly #records = new Map<string, IdempotencyRecord>();

  async begin(input: IdempotencyBeginInput): Promise<IdempotencyBeginResult> {
    const id = `${input.scope}\u0000${input.key}`;
    const now = input.now.getTime();
    const existing = this.#records.get(id);
    const takeover =
      existing === undefined ||
      existing.expiresAt <= now ||
      (existing.state === 'in_progress' && existing.lockUntil <= now);
    if (!takeover) {
      if (existing.requestHash !== input.requestHash)
        return { status: 'mismatch', operation: existing.operation };
      if (existing.state === 'complete' && existing.response !== null) {
        return { status: 'replay', response: clone(existing.response) };
      }
      return { status: 'in_progress' };
    }
    this.#records.set(id, {
      operation: input.operation,
      requestHash: input.requestHash,
      state: 'in_progress',
      lockUntil: input.lockUntil.getTime(),
      expiresAt: input.expiresAt.getTime(),
      response: null
    });
    return { status: 'started' };
  }

  async complete(scope: string, key: string, response: StoredResponse, expiresAt: Date): Promise<void> {
    const record = this.#records.get(`${scope}\u0000${key}`);
    if (record === undefined) return;
    record.state = 'complete';
    record.response = clone(response);
    record.expiresAt = expiresAt.getTime();
  }

  async release(scope: string, key: string): Promise<void> {
    this.#records.delete(`${scope}\u0000${key}`);
  }
}

export class InMemoryAuditRepository implements AuditRepository {
  readonly entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(clone(entry));
  }

  async listByLeague(leagueId: string, query: AuditQuery = {}): Promise<AuditEntry[]> {
    return this.#newest((e) => e.leagueId === leagueId, query);
  }

  async listByPrincipal(principal: string, query: AuditQuery = {}): Promise<AuditEntry[]> {
    return this.#newest((e) => e.principal === principal, query);
  }

  #newest(predicate: (entry: AuditEntry) => boolean, query: AuditQuery): AuditEntry[] {
    return this.entries
      .filter(predicate)
      .sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)))
      .slice(0, query.limit ?? 50)
      .map(clone);
  }
}

export class InMemoryPlayerRepository implements PlayerRepository {
  readonly #players = new Map<string, Player>();

  constructor(players: readonly Player[] = []) {
    for (const player of players) this.#players.set(player.id, clone(player));
  }

  async get(id: string): Promise<Player | null> {
    const player = this.#players.get(id);
    return player === undefined ? null : clone(player);
  }

  async getMany(ids: readonly string[]): Promise<Player[]> {
    return ids.flatMap((id) => {
      const player = this.#players.get(id);
      return player === undefined ? [] : [clone(player)];
    });
  }

  async putMany(players: readonly Player[]): Promise<void> {
    for (const player of players) this.#players.set(player.id, clone(player));
  }

  async listIndex(position?: Position): Promise<Player[]> {
    return [...this.#players.values()]
      .filter((p) => position === undefined || p.position === position)
      .map(clone);
  }
}

export class InMemoryLeagueRepository implements LeagueRepository {
  readonly #leagues = new Map<string, League>();

  async get(leagueId: string): Promise<League | null> {
    const league = this.#leagues.get(leagueId);
    return league === undefined ? null : clone(league);
  }

  async create(league: League): Promise<void> {
    if (this.#leagues.has(league.id)) throw leagueExists(league.id);
    this.#leagues.set(league.id, clone(league));
  }

  async update(league: League): Promise<League> {
    const stored = this.#leagues.get(league.id);
    if (stored === undefined || stored.version !== league.version) throw staleLeague(league.id);
    const next = { ...clone(league), version: league.version + 1 };
    this.#leagues.set(league.id, next);
    return clone(next);
  }
}

export function createInMemoryRepos(options: { players?: readonly Player[] } = {}): Repos {
  return {
    idempotency: new InMemoryIdempotencyRepository(),
    audit: new InMemoryAuditRepository(),
    players: new InMemoryPlayerRepository(options.players ?? []),
    leagues: new InMemoryLeagueRepository(),
    agents: new InMemoryAgentRepository()
  };
}
