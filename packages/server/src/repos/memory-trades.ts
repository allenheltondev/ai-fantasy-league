import { byProposedAt, staleTrade, tradeExists, type TradeRecord, type TradeRepository } from './trades.js';

const clone = <T>(value: T): T => structuredClone(value);
const key = (leagueId: string, tradeId: string) => `${leagueId}\u0000${tradeId}`;

export class InMemoryTradeRepository implements TradeRepository {
  readonly #trades = new Map<string, TradeRecord>();

  async create(record: TradeRecord): Promise<void> {
    const id = key(record.leagueId, record.trade.tradeId);
    if (this.#trades.has(id)) throw tradeExists(record.trade.tradeId);
    this.#trades.set(id, clone(record));
  }

  async get(leagueId: string, tradeId: string): Promise<TradeRecord | null> {
    const record = this.#trades.get(key(leagueId, tradeId));
    return record === undefined ? null : clone(record);
  }

  async list(leagueId: string): Promise<TradeRecord[]> {
    return [...this.#trades.values()]
      .filter((r) => r.leagueId === leagueId)
      .sort(byProposedAt)
      .map(clone);
  }

  /** Deletes every trade in a league (the league was deleted). */
  dropLeague(leagueId: string): void {
    for (const [id, record] of this.#trades) if (record.leagueId === leagueId) this.#trades.delete(id);
  }

  async update(record: TradeRecord): Promise<TradeRecord> {
    const id = key(record.leagueId, record.trade.tradeId);
    if (this.#trades.get(id)?.version !== record.version) throw staleTrade(record.trade.tradeId);
    const next = { ...clone(record), version: record.version + 1 };
    this.#trades.set(id, next);
    return clone(next);
  }
}
