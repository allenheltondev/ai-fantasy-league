import {
  claimExists,
  staleClaim,
  type TransactionPage,
  type TransactionRecord,
  type WaiverClaimRecord,
  type WaiverClaimStatus,
  type WaiverRepository,
  type WaiverRunRecord,
  type WaiverWireEntry
} from './waivers.js';

const clone = <T>(value: T): T => structuredClone(value);
const txnSort = (t: TransactionRecord) => `TXN#${t.at}#${t.id}`;

interface LeagueWaivers {
  claims: Map<string, WaiverClaimRecord>;
  wire: Map<string, WaiverWireEntry>;
  transactions: Map<string, TransactionRecord>;
  runs: Map<string, WaiverRunRecord>;
  owners: Map<string, string | null>;
}

export class InMemoryWaiverRepository implements WaiverRepository {
  readonly #leagues = new Map<string, LeagueWaivers>();

  #league(leagueId: string): LeagueWaivers {
    let league = this.#leagues.get(leagueId);
    if (league === undefined) {
      league = {
        claims: new Map(),
        wire: new Map(),
        transactions: new Map(),
        runs: new Map(),
        owners: new Map()
      };
      this.#leagues.set(leagueId, league);
    }
    return league;
  }

  async createClaim(claim: WaiverClaimRecord): Promise<void> {
    const claims = this.#league(claim.leagueId).claims;
    if (claims.has(claim.id)) throw claimExists(claim.id);
    claims.set(claim.id, clone(claim));
  }

  async getClaim(leagueId: string, claimId: string): Promise<WaiverClaimRecord | null> {
    const claim = this.#league(leagueId).claims.get(claimId);
    return claim === undefined ? null : clone(claim);
  }

  async listClaims(leagueId: string, status?: WaiverClaimStatus): Promise<WaiverClaimRecord[]> {
    return [...this.#league(leagueId).claims.values()]
      .filter((c) => status === undefined || c.status === status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(clone);
  }

  async updateClaim(claim: WaiverClaimRecord): Promise<WaiverClaimRecord> {
    const claims = this.#league(claim.leagueId).claims;
    if (claims.get(claim.id)?.version !== claim.version) throw staleClaim(claim.id);
    const next = { ...clone(claim), version: claim.version + 1 };
    claims.set(claim.id, next);
    return clone(next);
  }

  async putWireEntry(entry: WaiverWireEntry): Promise<void> {
    this.#league(entry.leagueId).wire.set(entry.playerId, clone(entry));
  }

  async listWire(leagueId: string): Promise<WaiverWireEntry[]> {
    return [...this.#league(leagueId).wire.values()].map(clone);
  }

  async addTransactions(transactions: readonly TransactionRecord[]): Promise<void> {
    for (const t of transactions) {
      const log = this.#league(t.leagueId).transactions;
      if (!log.has(t.id)) log.set(t.id, clone(t));
    }
  }

  async listTransactions(
    leagueId: string,
    query: { limit: number; cursor?: string | null }
  ): Promise<TransactionPage> {
    const all = [...this.#league(leagueId).transactions.values()]
      .sort((a, b) => txnSort(b).localeCompare(txnSort(a)))
      .filter((t) => query.cursor == null || txnSort(t) < query.cursor);
    const items = all.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items: items.map(clone),
      nextCursor: all.length > query.limit && last !== undefined ? txnSort(last) : null
    };
  }

  async listTransactionsSince(leagueId: string, since: string): Promise<TransactionRecord[]> {
    return [...this.#league(leagueId).transactions.values()]
      .filter((t) => t.at >= since)
      .sort((a, b) => txnSort(a).localeCompare(txnSort(b)))
      .map(clone);
  }

  async beginRun(run: WaiverRunRecord, staleBefore: string): Promise<boolean> {
    const runs = this.#league(run.leagueId).runs;
    const existing = runs.get(run.runId);
    if (existing !== undefined && (existing.status === 'complete' || existing.startedAt >= staleBefore)) {
      return false;
    }
    runs.set(run.runId, clone(run));
    return true;
  }

  async completeRun(run: WaiverRunRecord): Promise<void> {
    this.#league(run.leagueId).runs.set(run.runId, clone(run));
  }

  async getRun(leagueId: string, runId: string): Promise<WaiverRunRecord | null> {
    const run = this.#league(leagueId).runs.get(runId);
    return run === undefined ? null : clone(run);
  }

  async acquirePlayer(
    leagueId: string,
    playerId: string,
    teamId: string,
    staleOwner?: string
  ): Promise<boolean> {
    const owners = this.#league(leagueId).owners;
    const owner = owners.get(playerId) ?? null;
    if (owner !== null && owner !== teamId && owner !== staleOwner) return false;
    owners.set(playerId, teamId);
    return true;
  }

  async releasePlayer(leagueId: string, playerId: string, teamId: string): Promise<void> {
    const owners = this.#league(leagueId).owners;
    if (owners.get(playerId) === teamId) owners.set(playerId, null);
  }

  async playerOwner(leagueId: string, playerId: string): Promise<string | null> {
    return this.#league(leagueId).owners.get(playerId) ?? null;
  }
}
