import type { TransactionRecord } from '../repos/waivers.js';

/**
 * The league's move board (#166): the transactions log grouped so each move reads as one. A trade
 * is stored as one record per player received plus one per player released to make room (all
 * carrying its `tradeId`); here they become one `trade` move. Adds (with the drop made in the same
 * move), waiver awards, and plain drops are one record each already.
 */

export const MOVE_TYPES = ['trade', 'add', 'drop', 'waiver'] as const;
export type MoveType = (typeof MOVE_TYPES)[number];

export interface MoveGroup {
  /** The trade id for a trade, else the transaction id. */
  id: string;
  type: MoveType;
  at: string;
  week: number;
  /** The move's records, in log order. */
  records: TransactionRecord[];
}

function moveType(record: TransactionRecord): MoveType {
  if (record.tradeId != null) return 'trade';
  return record.type === 'waiver_claim' ? 'waiver' : record.type === 'trade' ? 'trade' : record.type;
}

/** Groups a newest-first slice of the log into moves, keeping the order each move first appears in. */
export function groupMoves(records: readonly TransactionRecord[]): MoveGroup[] {
  const groups = new Map<string, MoveGroup>();
  for (const record of records) {
    const key = record.tradeId == null ? `txn:${record.id}` : `trade:${record.tradeId}`;
    const group = groups.get(key);
    if (group !== undefined) {
      group.records.push(record);
      continue;
    }
    groups.set(key, {
      id: record.tradeId ?? record.id,
      type: moveType(record),
      at: record.at,
      week: record.week,
      records: [record]
    });
  }
  return [...groups.values()];
}

/** Each team in a move, in the order it first appears, with the players it added and dropped. */
export function moveSides(
  group: MoveGroup
): { teamId: string; added: string[]; dropped: string[]; cost: number | null }[] {
  const sides = new Map<
    string,
    { teamId: string; added: string[]; dropped: string[]; cost: number | null }
  >();
  for (const record of group.records) {
    const side = sides.get(record.teamId) ?? { teamId: record.teamId, added: [], dropped: [], cost: null };
    if (record.addPlayerId !== null) side.added.push(record.addPlayerId);
    if (record.dropPlayerId !== null) side.dropped.push(record.dropPlayerId);
    if (record.cost !== null) side.cost = (side.cost ?? 0) + record.cost;
    sides.set(record.teamId, side);
  }
  return [...sides.values()];
}

/** A page of the raw log, newest first (the waivers repository's `listTransactions`). */
export type TransactionPager = (cursor: string | null) => Promise<{
  items: TransactionRecord[];
  nextCursor: string | null;
}>;

/**
 * The newest `limit` moves, reading as many pages of the log as it takes (at most `maxPages`) so the
 * last move is never cut in half, and whether older moves exist.
 */
export async function latestMoves(
  page: TransactionPager,
  limit: number,
  maxPages = 5
): Promise<{ moves: MoveGroup[]; hasMore: boolean }> {
  const records: TransactionRecord[] = [];
  let cursor: string | null = null;
  for (let read = 0; read < maxPages; read++) {
    const next = await page(cursor);
    records.push(...next.items);
    cursor = next.nextCursor;
    // One move past the limit proves the limit-th move is complete (a trade's records are adjacent).
    if (cursor === null || groupMoves(records).length > limit) break;
  }
  const moves = groupMoves(records);
  return { moves: moves.slice(0, limit), hasMore: moves.length > limit || cursor !== null };
}
