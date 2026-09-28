import {
  computeStandings,
  getModel,
  replacementLevels,
  resolveAgentConfig,
  scorePlayer,
  tradePlayersValue,
  waiverHitRate,
  waiverPickupOutcome,
  type ReplacementLevels,
  type StandingsRow,
  type TradePlayersSide,
  type ValuedPlayer,
  type WaiverPickupOutcome
} from '@fantasy/core';
import type { EventPublisher } from '../events/publisher.js';
import type { Logger } from '../log.js';
import { budgetWeek } from '../operations/agents/budget.js';
import type { AgentRepository } from '../repos/agents.js';
import type { ReferenceStore } from '../repos/reference.js';
import type { League, Repos, Team } from '../repos/types.js';
import type { TransactionRecord } from '../repos/waivers.js';
import { loadProjections, type TradeProjections } from '../trades/world.js';
import { toRosterPlayer } from './lineups.js';

/**
 * "Which model wins the league?" (#76) and how each team's moves turned out (#81): standings,
 * cost, trade value won or lost, and waiver hit rate, per team and rolled up by the model that
 * plays it (people are grouped as `human`). Read by `get_model_leaderboard`, `get_league_history`,
 * and the weekly `Model Power Rankings` chat post at each rollover.
 */

export interface StatsDeps {
  repos: Repos;
  reference: ReferenceStore;
  log: Logger;
}

export const HUMAN_MODEL = 'human';
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

/** Every transaction in the league, oldest first; empty (and logged) when the log cannot be read. */
export async function leagueTransactions(deps: StatsDeps, leagueId: string): Promise<TransactionRecord[]> {
  try {
    return await deps.repos.waivers.listTransactionsSince(leagueId, '');
  } catch (error) {
    deps.log.warn('could not read the transaction log', { leagueId, error });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export interface ValuedTradeSide extends TradePlayersSide {
  partnerTeamId: string;
  /** Player ids this team received, sent, and dropped to make room. */
  receives: string[];
  sends: string[];
  drops: string[];
}

export interface ValuedTrade {
  tradeId: string;
  at: string;
  week: number;
  sides: [ValuedTradeSide, ValuedTradeSide];
}

/**
 * Every processed trade (from the `trade` transactions) with each side's value won or lost: the
 * trade value math's player value (rest-of-season points over replacement) of what the team
 * received minus what it sent and dropped, projected from the week the trade was processed.
 * Newest first.
 */
export async function valuedTrades(
  deps: StatsDeps,
  league: League,
  teams: readonly Team[],
  now: Date,
  transactions: readonly TransactionRecord[]
): Promise<ValuedTrade[]> {
  const processed = new Map<string, TransactionRecord>();
  for (const t of transactions) {
    if (t.type === 'trade' && typeof t.tradeId === 'string' && !processed.has(t.tradeId)) {
      processed.set(t.tradeId, t);
    }
  }
  if (processed.size === 0) return [];
  const records = (await deps.repos.trades.list(league.id)).filter((r) => processed.has(r.trade.tradeId));
  const ids = [
    ...new Set([
      ...teams.flatMap((t) => t.roster),
      ...records.flatMap((r) => r.trade.sides.flatMap((s) => [...s.sends, ...s.drops]))
    ])
  ];
  const players: Record<string, ValuedPlayer> = {};
  for (const p of await deps.repos.players.getMany(ids)) {
    // Value in hindsight: a player's status on the day is gone, so nobody is discounted for injury.
    players[p.id] = { ...toRosterPlayer(p.id, p), status: 'active' };
  }
  const pool = Object.values(players);
  const horizons = new Map<
    number,
    Promise<{ projections: TradeProjections; replacement: ReplacementLevels }>
  >();
  const horizon = (week: number) => {
    let found = horizons.get(week);
    if (found === undefined) {
      found = loadProjections(deps.reference, league, ids, now, week).then((projections) => ({
        projections,
        replacement: replacementLevels(league.settings, pool, projections.table, projections)
      }));
      horizons.set(week, found);
    }
    return found;
  };

  const out: ValuedTrade[] = [];
  for (const record of records) {
    const txn = processed.get(record.trade.tradeId) as TransactionRecord;
    const { projections, replacement } = await horizon(txn.week);
    const values = tradePlayersValue(record.trade, players, projections.table, {
      fromWeek: projections.fromWeek,
      toWeek: projections.toWeek,
      replacement
    });
    const [a, b] = record.trade.sides;
    const side = (i: 0 | 1): ValuedTradeSide => {
      const [own, other] = i === 0 ? [a, b] : [b, a];
      return {
        ...values[i],
        partnerTeamId: other.teamId,
        receives: [...other.sends],
        sends: [...own.sends],
        drops: [...own.drops]
      };
    };
    out.push({ tradeId: record.trade.tradeId, at: txn.at, week: txn.week, sides: [side(0), side(1)] });
  }
  return out.sort((x, y) => y.at.localeCompare(x.at) || x.tradeId.localeCompare(y.tradeId));
}

// ---------------------------------------------------------------------------
// Waivers
// ---------------------------------------------------------------------------

/**
 * How every awarded waiver claim turned out through `throughWeek`: the claimed player's points
 * while the team rostered him (any slot, per its weekly lineups) against the dropped player's
 * points over the same weeks.
 */
export async function waiverOutcomes(
  deps: StatsDeps,
  league: League,
  throughWeek: number | null,
  transactions: readonly TransactionRecord[]
): Promise<WaiverPickupOutcome[]> {
  const claims = transactions.filter(
    (t): t is TransactionRecord & { addPlayerId: string } =>
      t.type === 'waiver_claim' && t.addPlayerId !== null
  );
  if (claims.length === 0 || throughWeek === null) return [];
  const fromWeek = Math.min(...claims.map((c) => c.week));
  const weeks = Array.from({ length: Math.max(0, throughWeek - fromWeek + 1) }, (_, i) => fromWeek + i);
  const ids = [
    ...new Set(
      claims.flatMap((c) => (c.dropPlayerId === null ? [c.addPlayerId] : [c.addPlayerId, c.dropPlayerId]))
    )
  ];
  const [lineups, histories] = await Promise.all([
    Promise.all(weeks.map((w) => deps.repos.lineups.listWeek(league.id, w))),
    Promise.all(ids.map((id) => deps.reference.stats.getPlayerHistory(id, league.season)))
  ]);
  const rostered = new Set(
    lineups.flat().flatMap((l) => l.entries.map((e) => `${l.teamId}|${e.playerId}|${l.week}`))
  );
  const points = new Map<string, number>();
  for (const line of histories.flat()) {
    points.set(`${line.playerId}|${line.week}`, scorePlayer(league.settings, line.stats).points);
  }
  const lookups = {
    rostered: (teamId: string, playerId: string, week: number) =>
      rostered.has(`${teamId}|${playerId}|${week}`),
    points: (playerId: string, week: number) => points.get(`${playerId}|${week}`) ?? 0
  };
  return claims.map((c) =>
    waiverPickupOutcome(
      { teamId: c.teamId, week: c.week, addPlayerId: c.addPlayerId, dropPlayerId: c.dropPlayerId },
      throughWeek,
      lookups
    )
  );
}

// ---------------------------------------------------------------------------
// The leaderboard
// ---------------------------------------------------------------------------

export interface MoveStats {
  trades: number;
  tradesWon: number;
  tradesLost: number;
  tradeValue: number;
  waiverClaims: number;
  waiverHits: number;
  waiverHitRate: number | null;
  waiverNetPoints: number;
}

interface RecordStats {
  wins: number;
  losses: number;
  ties: number;
  winRate: number | null;
  pointsFor: number;
  costUsd: number;
}

export interface LeaderboardTeam extends RecordStats, MoveStats {
  teamId: string;
  teamName: string;
  seatType: 'agent' | 'human';
  rank: number;
  modelKey: string;
  modelName: string;
  provider: string | null;
  personality: string | null;
  difficulty: string | null;
}

export interface LeaderboardModel extends RecordStats, MoveStats {
  modelKey: string;
  modelName: string;
  provider: string | null;
  teams: number;
  bestRank: number;
  pointsForPerTeam: number;
  costPerWinUsd: number | null;
}

export interface ModelLeaderboard {
  throughWeek: number | null;
  teams: LeaderboardTeam[];
  models: LeaderboardModel[];
}

function winRate(wins: number, losses: number, ties: number): number | null {
  const games = wins + losses + ties;
  return games === 0 ? null : round((wins + ties / 2) / games, 3);
}

/** Estimated spend per agent id for the season so far (weeks 0 through the current week). */
async function seasonCost(agents: AgentRepository, league: League): Promise<Map<string, number>> {
  const weeks = Array.from({ length: budgetWeek(league) + 1 }, (_, week) => week);
  const rows = (await Promise.all(weeks.map((week) => agents.weekUsage(league.id, week)))).flat();
  const cost = new Map<string, number>();
  for (const row of rows) cost.set(row.agentId, (cost.get(row.agentId) ?? 0) + row.costUsd);
  return cost;
}

/** Sums trade and waiver results over a group of teams (or one). */
function moveStats(
  tradeSides: readonly ValuedTradeSide[],
  pickups: readonly WaiverPickupOutcome[]
): MoveStats {
  const waivers = waiverHitRate(pickups);
  return {
    trades: tradeSides.length,
    tradesWon: tradeSides.filter((s) => s.valueDelta > 0).length,
    tradesLost: tradeSides.filter((s) => s.valueDelta < 0).length,
    tradeValue: round(tradeSides.reduce((t, s) => t + s.valueDelta, 0)),
    waiverClaims: waivers.claims,
    waiverHits: waivers.hits,
    waiverHitRate: waivers.hitRate,
    waiverNetPoints: waivers.netPoints
  };
}

/**
 * Every team's standing, spend, and move results next to the model that plays it (an agent seat's
 * primary decision model, or `human`), and the same numbers rolled up per model, best win rate
 * first.
 */
export async function modelLeaderboard(
  deps: StatsDeps,
  league: League,
  teams: readonly Team[],
  now: Date
): Promise<ModelLeaderboard> {
  const [snapshot, seats, cost, transactions] = await Promise.all([
    deps.repos.schedule.latestStandings(league.id),
    deps.repos.agents.listSeats(league.id),
    seasonCost(deps.repos.agents, league),
    leagueTransactions(deps, league.id)
  ]);
  const throughWeek = snapshot?.week ?? null;
  const [trades, pickups] = await Promise.all([
    valuedTrades(deps, league, teams, now, transactions),
    waiverOutcomes(deps, league, throughWeek, transactions)
  ]);
  const tradeSides = trades.flatMap((t) => t.sides);
  const rows: StandingsRow[] =
    snapshot?.rows ??
    computeStandings(league.settings, [], { teamIds: teams.map((t) => t.id), seed: league.scheduleSeed });

  const entries = rows.map((row): LeaderboardTeam => {
    const team = teams.find((t) => t.id === row.teamId);
    const seat = team?.seatType === 'agent' ? seats.find((s) => s.teamId === row.teamId) : undefined;
    const config = seat === undefined ? null : resolveAgentConfig(seat.config);
    const modelKey = config?.models.decision[0] ?? HUMAN_MODEL;
    const model = modelKey === HUMAN_MODEL ? null : getModel(modelKey);
    return {
      teamId: row.teamId,
      teamName: team?.name ?? row.teamId,
      seatType: seat === undefined ? 'human' : 'agent',
      rank: row.rank,
      modelKey,
      modelName: model?.displayName ?? 'Human',
      provider: model?.provider ?? null,
      personality: config?.personality.displayName ?? null,
      difficulty: config?.difficulty.displayName ?? null,
      wins: row.wins,
      losses: row.losses,
      ties: row.ties,
      winRate: winRate(row.wins, row.losses, row.ties),
      pointsFor: row.pointsFor,
      costUsd: seat === undefined ? 0 : round(cost.get(seat.agentId) ?? 0, 6),
      ...moveStats(
        tradeSides.filter((s) => s.teamId === row.teamId),
        pickups.filter((p) => p.teamId === row.teamId)
      )
    };
  });

  const byModel = new Map<string, LeaderboardTeam[]>();
  for (const e of entries) byModel.set(e.modelKey, [...(byModel.get(e.modelKey) ?? []), e]);
  const models = [...byModel.entries()].map(([modelKey, group]): LeaderboardModel => {
    const sum = (f: (e: LeaderboardTeam) => number) => group.reduce((t, e) => t + f(e), 0);
    const ids = new Set(group.map((e) => e.teamId));
    const wins = sum((e) => e.wins);
    const losses = sum((e) => e.losses);
    const ties = sum((e) => e.ties);
    const costUsd = round(
      sum((e) => e.costUsd),
      6
    );
    const first = group[0] as LeaderboardTeam;
    return {
      modelKey,
      modelName: first.modelName,
      provider: first.provider,
      teams: group.length,
      bestRank: Math.min(...group.map((e) => e.rank)),
      wins,
      losses,
      ties,
      winRate: winRate(wins, losses, ties),
      pointsFor: round(sum((e) => e.pointsFor)),
      pointsForPerTeam: round(sum((e) => e.pointsFor) / group.length),
      costUsd,
      costPerWinUsd: modelKey === HUMAN_MODEL || wins === 0 ? null : round(costUsd / wins, 6),
      ...moveStats(
        tradeSides.filter((s) => ids.has(s.teamId)),
        pickups.filter((p) => ids.has(p.teamId))
      )
    };
  });
  models.sort(
    (a, b) =>
      (b.winRate ?? -1) - (a.winRate ?? -1) ||
      b.pointsForPerTeam - a.pointsForPerTeam ||
      a.bestRank - b.bestRank ||
      a.modelKey.localeCompare(b.modelKey)
  );
  return { throughWeek, teams: entries, models };
}

// ---------------------------------------------------------------------------
// The weekly post
// ---------------------------------------------------------------------------

const signed = (n: number) => `${n > 0 ? '+' : ''}${round(n)}`;

/** One model's line in the weekly post, e.g. "1. Claude Opus 5 4-1 (trades +12.5, waivers 2/3)". */
export function powerRankingLine(rank: number, m: LeaderboardModel): string {
  const record = m.ties > 0 ? `${m.wins}-${m.losses}-${m.ties}` : `${m.wins}-${m.losses}`;
  const extras = [
    ...(m.trades > 0 ? [`trades ${signed(m.tradeValue)}`] : []),
    ...(m.waiverClaims > 0 ? [`waivers ${m.waiverHits}/${m.waiverClaims}`] : [])
  ];
  return `${rank}. ${m.modelName} ${record}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`;
}

/**
 * Posts the weekly "model power rankings" (`Model Power Rankings`, rendered in chat) after a
 * league rolls over from `week`, when at least one team is played by a model. Never fails the
 * rollover: a problem is logged and nothing is posted.
 */
export async function publishModelPowerRankings(
  deps: StatsDeps & { events: EventPublisher },
  league: League,
  week: number,
  now: Date
): Promise<boolean> {
  try {
    const teams = await deps.repos.teams.list(league.id);
    const board = await modelLeaderboard(deps, league, teams, now);
    if (!board.models.some((m) => m.modelKey !== HUMAN_MODEL)) return false;
    const rankings = board.models.map((m, i) => ({
      rank: i + 1,
      modelKey: m.modelKey,
      modelName: m.modelName,
      teams: m.teams,
      wins: m.wins,
      losses: m.losses,
      ties: m.ties,
      winRate: m.winRate,
      tradeValue: m.tradeValue,
      waiverHitRate: m.waiverHitRate,
      costUsd: m.costUsd
    }));
    await deps.events.publish('Model Power Rankings', {
      eventKey: `rankings:${league.season}:${week}:${now.toISOString()}`,
      occurredAt: now.toISOString(),
      leagueId: league.id,
      season: league.season,
      week,
      leaderModelName: (board.models[0] as LeaderboardModel).modelName,
      rankings,
      lines: board.models.map((m, i) => powerRankingLine(i + 1, m)),
      postedAt: now.toISOString()
    });
    return true;
  } catch (error) {
    deps.log.warn('model power rankings not posted', { leagueId: league.id, week, error });
    return false;
  }
}
