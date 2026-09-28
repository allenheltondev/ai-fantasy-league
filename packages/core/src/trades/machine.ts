import { ruleError, type RuleIssue } from '../rules/issues.js';
import type { Instant } from '../rules/lineup.js';
import { vetoVotesRequired, type LeagueSettings } from '../rules/settings.js';
import { DAY_MS, instantMs, shiftInstant, toIso } from '../time.js';
import {
  applyTrade,
  expiresAt,
  validateTrade,
  type RosteredPlayer,
  type Trade,
  type TradeContext,
  type TradeSide,
  type TradeStatus
} from './trade.js';

type TradeRules = Pick<LeagueSettings, 'teamCount' | 'roster' | 'trades'>;

/**
 * Legal status changes. `countered` closes an offer; the counter itself is a new `proposed` trade
 * that points back through `counterOf` and `counterChain`.
 */
export const TRADE_TRANSITIONS: Readonly<Record<TradeStatus, readonly TradeStatus[]>> = {
  proposed: ['countered', 'accepted', 'rejected', 'expired', 'withdrawn'],
  countered: [],
  accepted: ['in_review', 'processed', 'vetoed'],
  rejected: [],
  expired: [],
  withdrawn: [],
  in_review: ['processed', 'vetoed'],
  processed: [],
  vetoed: []
};

export function canTransition(from: TradeStatus, to: TradeStatus): boolean {
  return TRADE_TRANSITIONS[from].includes(to);
}

export type TradeResult<T = Trade> =
  { ok: true; trade: T; warnings: RuleIssue[] } | { ok: false; issues: RuleIssue[] };

function failure(issue: RuleIssue): { ok: false; issues: RuleIssue[] } {
  return { ok: false, issues: [issue] };
}

function illegal(trade: Trade, to: TradeStatus): RuleIssue | null {
  if (canTransition(trade.status, to)) return null;
  const closed = TRADE_TRANSITIONS[trade.status].length === 0;
  return ruleError(
    'ILLEGAL_TRADE_TRANSITION',
    `trades.${trade.tradeId}.status`,
    `Trade ${trade.tradeId} is ${trade.status}; it cannot become ${to}.`,
    closed
      ? 'This trade is closed. Propose a new trade instead.'
      : `From ${trade.status} the trade can only become: ${TRADE_TRANSITIONS[trade.status].join(', ')}.`,
    { from: trade.status, to }
  );
}

function move(
  trade: Trade,
  to: TradeStatus,
  at: Instant,
  byTeamId: string | null,
  patch: Partial<Trade> = {}
): Trade {
  return {
    ...trade,
    ...patch,
    status: to,
    history: [...trade.history, { status: to, at: toIso(at), byTeamId }]
  };
}

function notParty(
  trade: Trade,
  teamId: string,
  role: 'proposer' | 'responder',
  action: string
): RuleIssue | null {
  const expected = role === 'proposer' ? trade.sides[0].teamId : trade.sides[1].teamId;
  if (teamId === expected) return null;
  return ruleError(
    'NOT_YOUR_TRADE_ACTION',
    `trades.${trade.tradeId}`,
    `Only the ${role} (team ${expected}) can ${action} trade ${trade.tradeId}.`,
    role === 'responder'
      ? 'Wait for the other team to respond, or withdraw your offer.'
      : 'Accept, reject, or counter the offer instead.'
  );
}

function expiredIssue(trade: Trade, now: Instant): RuleIssue | null {
  if (instantMs(now) < instantMs(trade.expiresAt)) return null;
  return ruleError(
    'TRADE_EXPIRED',
    `trades.${trade.tradeId}.expiresAt`,
    `Trade ${trade.tradeId} expired at ${trade.expiresAt}.`,
    'Propose a new trade if both teams are still interested.'
  );
}

function sanitizeSides(sides: readonly [TradeSide, TradeSide]): [TradeSide, TradeSide] {
  const copy = (s: TradeSide): TradeSide => ({ teamId: s.teamId, sends: [...s.sends], drops: [...s.drops] });
  return [copy(sides[0]), copy(sides[1])];
}

export interface ProposeTradeInput {
  tradeId: string;
  /** `[proposer, responder]`. */
  sides: readonly [TradeSide, TradeSide];
  /** The next lineup lock (the next kickoff), or null when none is scheduled. */
  nextLockTime: Instant | null;
}

/** Creates an opening offer after validating it. */
export function proposeTrade(settings: TradeRules, input: ProposeTradeInput, ctx: TradeContext): TradeResult {
  const sides = sanitizeSides(input.sides);
  const check = validateTrade(settings, { sides }, ctx, 'proposal');
  if (!check.valid) return { ok: false, issues: check.errors };
  const proposedAt = toIso(ctx.now);
  const trade: Trade = {
    tradeId: input.tradeId,
    sides,
    status: 'proposed',
    proposedAt,
    expiresAt: expiresAt(settings, proposedAt, input.nextLockTime),
    counterOf: null,
    counterChain: [],
    vetoVotes: [],
    reviewEndsAt: null,
    commissionerApproved: false,
    voidReason: null,
    history: [{ status: 'proposed', at: proposedAt, byTeamId: sides[0].teamId }]
  };
  return { ok: true, trade, warnings: check.warnings };
}

export interface CounterTradeInput extends ProposeTradeInput {
  /** The countering team; must be the original offer's responder. */
  byTeamId: string;
}

export type CounterResult =
  { ok: true; original: Trade; counter: Trade; warnings: RuleIssue[] } | { ok: false; issues: RuleIssue[] };

/**
 * The responder answers with a different offer. The original becomes `countered` and the counter is
 * a new `proposed` trade from the responder (`sides[0]` must be the countering team).
 */
export function counterTrade(
  settings: TradeRules,
  trade: Trade,
  input: CounterTradeInput,
  ctx: TradeContext
): CounterResult {
  const problem =
    illegal(trade, 'countered') ??
    notParty(trade, input.byTeamId, 'responder', 'counter') ??
    expiredIssue(trade, ctx.now);
  if (problem) return failure(problem);
  const [first, second] = input.sides;
  if (first.teamId !== input.byTeamId || second.teamId !== trade.sides[0].teamId) {
    return failure(
      ruleError(
        'COUNTER_TEAMS_MISMATCH',
        'sides',
        'A counter must be between the same two teams, with the countering team first.',
        `Set sides[0].teamId to ${input.byTeamId} and sides[1].teamId to ${trade.sides[0].teamId}.`
      )
    );
  }
  const proposed = proposeTrade(settings, input, ctx);
  if (!proposed.ok) return proposed;
  const counter: Trade = {
    ...proposed.trade,
    counterOf: trade.tradeId,
    counterChain: [...trade.counterChain, trade.tradeId]
  };
  return {
    ok: true,
    original: move(trade, 'countered', ctx.now, input.byTeamId),
    counter,
    warnings: proposed.warnings
  };
}

export interface AcceptTradeInput {
  byTeamId: string;
  /** The responder's drops, when its roster would otherwise be over the limit. */
  drops?: readonly string[];
}

/** The responder accepts. The whole trade is re-validated, including the responder's drops. */
export function acceptTrade(
  settings: TradeRules,
  trade: Trade,
  input: AcceptTradeInput,
  ctx: TradeContext
): TradeResult {
  const problem =
    illegal(trade, 'accepted') ??
    notParty(trade, input.byTeamId, 'responder', 'accept') ??
    expiredIssue(trade, ctx.now);
  if (problem) return failure(problem);
  const sides: [TradeSide, TradeSide] = [
    trade.sides[0],
    input.drops ? { ...trade.sides[1], drops: [...input.drops] } : trade.sides[1]
  ];
  const check = validateTrade(settings, { sides }, ctx, 'acceptance');
  if (!check.valid) return { ok: false, issues: check.errors };
  return {
    ok: true,
    trade: move(trade, 'accepted', ctx.now, input.byTeamId, { sides }),
    warnings: check.warnings
  };
}

/** The responder declines. */
export function rejectTrade(trade: Trade, byTeamId: string, now: Instant): TradeResult {
  const problem = illegal(trade, 'rejected') ?? notParty(trade, byTeamId, 'responder', 'reject');
  if (problem) return failure(problem);
  return { ok: true, trade: move(trade, 'rejected', now, byTeamId), warnings: [] };
}

/** The proposer takes the offer back before it is answered. */
export function withdrawTrade(trade: Trade, byTeamId: string, now: Instant): TradeResult {
  const problem = illegal(trade, 'withdrawn') ?? notParty(trade, byTeamId, 'proposer', 'withdraw');
  if (problem) return failure(problem);
  return { ok: true, trade: move(trade, 'withdrawn', now, byTeamId), warnings: [] };
}

/** Closes an unanswered offer once `now` reaches `expiresAt`. */
export function expireTrade(trade: Trade, now: Instant): TradeResult {
  const problem = illegal(trade, 'expired');
  if (problem) return failure(problem);
  if (instantMs(now) < instantMs(trade.expiresAt)) {
    return failure(
      ruleError(
        'TRADE_NOT_EXPIRED',
        `trades.${trade.tradeId}.expiresAt`,
        `Trade ${trade.tradeId} is open until ${trade.expiresAt}.`,
        'Schedule expiry for expiresAt, or respond to the trade.'
      )
    );
  }
  return { ok: true, trade: move(trade, 'expired', now, null), warnings: [] };
}

/**
 * Starts the review period for an accepted trade (`league_vote` or `commissioner`). It ends
 * `trades.reviewPeriodDays` days from now. Leagues with review `none` process accepted trades directly.
 */
export function startReview(
  settings: Pick<LeagueSettings, 'trades'>,
  trade: Trade,
  now: Instant
): TradeResult {
  const problem = illegal(trade, 'in_review');
  if (problem) return failure(problem);
  if (settings.trades.review === 'none') {
    return failure(
      ruleError(
        'REVIEW_NOT_REQUIRED',
        'trades.review',
        'This league does not review trades.',
        'Process the accepted trade directly.'
      )
    );
  }
  const reviewEndsAt = shiftInstant(now, settings.trades.reviewPeriodDays * DAY_MS);
  return { ok: true, trade: move(trade, 'in_review', now, null, { reviewEndsAt }), warnings: [] };
}

/**
 * Records a veto vote under `league_vote`. Teams in the trade cannot vote and each team votes once.
 * When the votes reach `vetoVotesRequired(settings)` the trade is vetoed.
 */
export function castVetoVote(
  settings: Pick<LeagueSettings, 'teamCount' | 'trades'>,
  trade: Trade,
  voterTeamId: string,
  now: Instant
): TradeResult {
  const base = `trades.${trade.tradeId}.vetoVotes`;
  if (trade.status !== 'in_review') {
    return failure(
      ruleError(
        'TRADE_NOT_IN_REVIEW',
        base,
        `Trade ${trade.tradeId} is ${trade.status}, not in review.`,
        'Only trades in review can be voted on.'
      )
    );
  }
  let problem: RuleIssue | null = null;
  if (settings.trades.review !== 'league_vote') {
    problem = ruleError(
      'VOTING_NOT_ENABLED',
      'trades.review',
      `Trades in this league are reviewed by ${settings.trades.review === 'commissioner' ? 'the commissioner' : 'no one'}, not a league vote.`,
      'Ask the commissioner instead.'
    );
  } else if (trade.sides.some((s) => s.teamId === voterTeamId)) {
    problem = ruleError(
      'PARTY_CANNOT_VOTE',
      base,
      `Team ${voterTeamId} is part of trade ${trade.tradeId} and cannot vote on it.`,
      'Only teams outside the trade can vote.'
    );
  } else if (trade.vetoVotes.includes(voterTeamId)) {
    problem = ruleError(
      'ALREADY_VOTED',
      base,
      `Team ${voterTeamId} already voted to veto.`,
      'No action needed.'
    );
  } else if (trade.reviewEndsAt !== null && instantMs(now) >= instantMs(trade.reviewEndsAt)) {
    problem = ruleError(
      'REVIEW_CLOSED',
      `trades.${trade.tradeId}.reviewEndsAt`,
      `Review for trade ${trade.tradeId} ended at ${trade.reviewEndsAt}.`,
      'Voting is over; the trade will be processed.'
    );
  }
  if (problem) return failure(problem);
  const vetoVotes = [...trade.vetoVotes, voterTeamId];
  const vetoed = vetoVotes.length >= vetoVotesRequired(settings);
  const updated = vetoed ? move(trade, 'vetoed', now, null, { vetoVotes }) : { ...trade, vetoVotes };
  return { ok: true, trade: updated, warnings: [] };
}

/** The commissioner approves (the trade can process now) or vetoes a trade in review. */
export function commissionerReview(
  settings: Pick<LeagueSettings, 'trades'>,
  trade: Trade,
  decision: 'approve' | 'veto',
  now: Instant
): TradeResult {
  if (settings.trades.review !== 'commissioner') {
    return failure(
      ruleError(
        'COMMISSIONER_REVIEW_NOT_ENABLED',
        'trades.review',
        `This league reviews trades by ${settings.trades.review === 'league_vote' ? 'league vote' : 'no one'}.`,
        'Change trades.review to commissioner, or use the league vote.'
      )
    );
  }
  if (trade.status !== 'in_review') {
    return failure(
      ruleError(
        'TRADE_NOT_IN_REVIEW',
        `trades.${trade.tradeId}.status`,
        `Trade ${trade.tradeId} is ${trade.status}, not in review.`,
        'Only trades in review can be approved or vetoed.'
      )
    );
  }
  if (decision === 'veto') return { ok: true, trade: move(trade, 'vetoed', now, null), warnings: [] };
  return { ok: true, trade: { ...trade, commissionerApproved: true }, warnings: [] };
}

/** Vetoes a trade that can no longer be processed (for example, a player was dropped meanwhile). */
export function voidTrade(trade: Trade, reason: RuleIssue, now: Instant): TradeResult {
  const problem = illegal(trade, 'vetoed');
  if (problem) return failure(problem);
  return { ok: true, trade: move(trade, 'vetoed', now, null, { voidReason: reason }), warnings: [] };
}

/**
 * Closes an open offer early because it can no longer work (a player in it moved to another roster
 * or was dropped): the offer becomes `expired` with a `voidReason`. Only an open offer can be voided
 * this way; an accepted trade is voided at processing time with `voidTrade`.
 */
export function voidOffer(trade: Trade, reason: RuleIssue, now: Instant): TradeResult {
  const problem = illegal(trade, 'expired');
  if (problem) return failure(problem);
  return { ok: true, trade: move(trade, 'expired', now, null, { voidReason: reason }), warnings: [] };
}

/**
 * The review settings that apply to one trade. Under commissioner review, a trade the
 * commissioner's own team is part of falls back to a league vote, so nobody approves or vetoes
 * their own trade.
 */
export function reviewSettingsFor<S extends Pick<LeagueSettings, 'trades'>>(
  settings: S,
  trade: Pick<Trade, 'sides'>,
  commissionerTeamId: string | null
): S {
  if (settings.trades.review !== 'commissioner' || commissionerTeamId === null) return settings;
  if (!trade.sides.some((s) => s.teamId === commissionerTeamId)) return settings;
  return { ...settings, trades: { ...settings.trades, review: 'league_vote' } };
}

export type ProcessTradeResult =
  | {
      ok: true;
      trade: Trade;
      rosters: Record<string, RosteredPlayer[]>;
      dropped: RosteredPlayer[];
      warnings: RuleIssue[];
    }
  | { ok: false; issues: RuleIssue[] };

/**
 * Executes a trade once it is cleared: straight from `accepted` when the league has no review, or
 * from `in_review` once the league-vote period has ended without a veto or the commissioner has
 * approved. The trade is re-validated against the current rosters, deadline and locks first.
 */
export function processTrade(settings: TradeRules, trade: Trade, ctx: TradeContext): ProcessTradeResult {
  const problem = illegal(trade, 'processed');
  if (problem) return failure(problem);
  const path = `trades.${trade.tradeId}`;
  const review = settings.trades.review;
  if (trade.status === 'accepted' && review !== 'none') {
    return failure(
      ruleError(
        'REVIEW_REQUIRED',
        path,
        `Trades in this league go through ${review === 'league_vote' ? 'a league vote' : 'commissioner review'}.`,
        'Start the review period first.'
      )
    );
  }
  if (trade.status === 'in_review' && review === 'commissioner' && !trade.commissionerApproved) {
    return failure(
      ruleError(
        'AWAITING_COMMISSIONER',
        path,
        'The commissioner has not approved this trade.',
        'Wait for the commissioner.'
      )
    );
  }
  if (
    trade.status === 'in_review' &&
    review === 'league_vote' &&
    trade.reviewEndsAt !== null &&
    instantMs(ctx.now) < instantMs(trade.reviewEndsAt)
  ) {
    return failure(
      ruleError(
        'REVIEW_PENDING',
        `${path}.reviewEndsAt`,
        `The review period runs until ${trade.reviewEndsAt}.`,
        `Process the trade at ${trade.reviewEndsAt}.`
      )
    );
  }
  const check = validateTrade(settings, trade, ctx, 'processing');
  if (!check.valid) return { ok: false, issues: check.errors };
  const { rosters, dropped } = applyTrade(ctx.rosters, trade);
  return {
    ok: true,
    trade: move(trade, 'processed', ctx.now, null),
    rosters,
    dropped,
    warnings: check.warnings
  };
}
