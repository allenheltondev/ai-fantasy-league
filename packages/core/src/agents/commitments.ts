import { z } from 'zod';
import { RosterSlotSchema, SLOT_ELIGIBILITY, type RosterSlot } from '../rules/positions.js';

/**
 * Durable commitments (#215): what an agent took on in a conversation, kept as typed operational
 * state beside its agenda (#214) rather than in lossy natural-language memory. The first kind is
 * `trade_interest`: a person pitched a swap in chat, and the agent owes it a proper look.
 *
 * "I will evaluate" is `queued`/`evaluating`; "I sent it" is `waiting_for_partner` with the real
 * trade id; the partner's answer ends it. Every commitment ends in an explicit status with a
 * structured reason and the facts it rested on. Transitions are pure and only the task currently
 * assigned (`childTaskIds.at(-1)`) may decide, so a duplicate or superseded delivery cannot. A
 * decline for a reason that facts can change (`RECONSIDERABLE`) may be looked at again once, after
 * a cooldown, when a new roster need appears that the pitched players could fill; a partner's
 * rejection, a withdrawn or expired offer, and everything else are final.
 */
export const COMMITMENT_LIMITS = {
  /** Unresolved commitments per agent tenure, and per counterpart. */
  active: 3,
  perCounterpart: 1,
  history: 12,
  /** Tasks one commitment may run: the first look, a lost dispatch resumed, a reconsideration. */
  childTasks: 4,
  ttlMs: 4 * 24 * 60 * 60_000,
  reconsiderCooldownMs: 12 * 60 * 60_000,
  maxReconsiderations: 1,
  /** A queued commitment whose task never started is resumed after this (a lost publication). */
  staleQueueMs: 60 * 60_000
} as const;

export const COMMITMENT_STATUSES = [
  'queued',
  'evaluating',
  'waiting_for_partner',
  'fulfilled',
  'declined',
  'cancelled',
  'expired',
  'failed'
] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];
const OPEN: ReadonlySet<CommitmentStatus> = new Set(['queued', 'evaluating', 'waiting_for_partner']);

export const CommitmentReasonSchema = z.enum([
  // The agent's own look.
  'offer_sent',
  'value_below_floor',
  'insufficient_depth',
  // The trade value math calls the swap lopsided, whichever side it favours (#219): not "no value".
  'lopsided',
  'not_legal',
  'player_unavailable',
  'trades_closed',
  'model_passed',
  // Could not act.
  'autopilot',
  'send_failed',
  'seat_changed',
  'deadline_passed',
  // The partner's answer to the offer.
  'partner_accepted',
  'partner_declined',
  'partner_countered',
  'offer_withdrawn',
  'offer_expired',
  'offer_vetoed'
]);
export type CommitmentReason = z.infer<typeof CommitmentReasonSchema>;
/** Declines that rest on facts which can change (a new roster need), so worth another look. */
export const RECONSIDERABLE: ReadonlySet<CommitmentReason> = new Set([
  'value_below_floor',
  'insufficient_depth'
]);

/** What a decision rested on: the agent's own numbers and needs, never the pitch's words. */
export const CommitmentFactsSchema = z.object({
  score: z.number().nullable(),
  bar: z.number().nullable(),
  /** How far the verified argument moved the bar. */
  credit: z.number().nullable(),
  lineupDelta: z.number().nullable(),
  /** What an attachment to a player it would give up added to the bar (#216); part of `bar`. */
  attachmentPremium: z.number().nullable().default(null),
  /** The agent's open starting needs (active agenda slots) when it decided. */
  needs: z.array(RosterSlotSchema).max(6),
  /** Positions of the players it would receive. */
  receivePositions: z.array(z.string()).max(3)
});
export type CommitmentFacts = z.infer<typeof CommitmentFactsSchema>;

export const CommitmentSchema = z.object({
  id: z.string(),
  kind: z.literal('trade_interest'),
  status: z.enum(COMMITMENT_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
  /** When a reconsiderable decline may be looked at again; null when it may not. */
  nextReviewAt: z.string().nullable(),
  /** The agenda goal (#214) the pitched players could repair, when there was one. */
  agendaId: z.string().nullable(),
  /** Where it was said. The text is never stored; follow-ups re-read the message. */
  source: z.object({
    roomId: z.string(),
    messageId: z.string(),
    fromTeamId: z.string(),
    /** `dm`: the two teams only. `room`: a league room, where replies never carry terms. */
    visibility: z.enum(['dm', 'room'])
  }),
  counterpartTeamId: z.string(),
  /** Validated player ids: players each team really rostered when it was said. */
  intent: z.object({ send: z.array(z.string()).min(1).max(3), receive: z.array(z.string()).min(1).max(3) }),
  /** The pitch's argument, by reference: untrusted until the decision task checks it. */
  claims: z
    .array(
      z.object({
        messageId: z.string(),
        verification: z.enum(['pending', 'supported', 'unsupported', 'ignored_orders', 'unreadable'])
      })
    )
    .max(2),
  childTaskIds: z.array(z.string()).min(1).max(COMMITMENT_LIMITS.childTasks),
  tradeId: z.string().nullable(),
  decision: z
    .object({
      reason: CommitmentReasonSchema,
      at: z.string(),
      taskId: z.string(),
      facts: CommitmentFactsSchema.nullable()
    })
    .nullable(),
  reconsiderations: z.number().int().min(0),
  /** The one closing line for the current look (`key`), claimed before it is posted. */
  reply: z
    .object({ key: z.string(), state: z.enum(['claimed', 'sent', 'withheld']), at: z.string() })
    .nullable()
});
export type Commitment = z.infer<typeof CommitmentSchema>;

export const CommitmentBookSchema = z.object({
  schemaVersion: z.literal(1),
  commitments: z.array(CommitmentSchema).max(COMMITMENT_LIMITS.active + COMMITMENT_LIMITS.history)
});
export type CommitmentBook = z.infer<typeof CommitmentBookSchema>;

export const emptyCommitments = (): CommitmentBook => ({ schemaVersion: 1, commitments: [] });

export const isOpenCommitment = (c: Pick<Commitment, 'status'>): boolean => OPEN.has(c.status);
export const currentTask = (c: Pick<Commitment, 'childTaskIds'>): string => c.childTaskIds.at(-1) as string;
/** The closing reply's key: one per look (the first, and each reconsideration). */
export const replyKey = (c: Pick<Commitment, 'id' | 'reconsiderations'>): string =>
  `${c.id}#${c.reconsiderations}`;

export interface TradeInterestDraft {
  at: string;
  /** The follow-up task that will evaluate it. */
  taskId: string;
  selfTeamId: string;
  source: Commitment['source'];
  send: readonly string[];
  receive: readonly string[];
  expiresAt: string;
  agendaId: string | null;
}

export type OpenOutcome = 'created' | 'existing' | 'duplicate' | 'limit' | 'invalid';

const sameSet = (a: readonly string[], b: readonly string[]) => [...a].sort().join() === [...b].sort().join();

function withCommitment(book: CommitmentBook, next: Commitment): CommitmentBook {
  const others = book.commitments.filter((c) => c.id !== next.id);
  const open = [next, ...others].filter(isOpenCommitment);
  const closed = [next, ...others]
    .filter((c) => !isOpenCommitment(c))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, COMMITMENT_LIMITS.history);
  return { schemaVersion: 1, commitments: [...open, ...closed] };
}

/**
 * Validates and records a trade interest from chat. The same message again is `existing` (a
 * redelivery), the same swap still open with that team is `duplicate`, and more open work than the
 * limits allow is `limit`: nothing new is recorded for those, nor for an `invalid` draft.
 */
export function openTradeInterest(
  book: CommitmentBook,
  draft: TradeInterestDraft
): { book: CommitmentBook; outcome: OpenOutcome; commitment: Commitment | null } {
  const id = `trade_interest:${draft.source.messageId}`;
  const existing = book.commitments.find((c) => c.id === id);
  if (existing !== undefined) return { book, outcome: 'existing', commitment: existing };
  const counterpart = draft.source.fromTeamId;
  const overlap = draft.send.some((p) => draft.receive.includes(p));
  if (
    counterpart === draft.selfTeamId ||
    draft.send.length === 0 ||
    draft.receive.length === 0 ||
    overlap ||
    Date.parse(draft.expiresAt) <= Date.parse(draft.at)
  )
    return { book, outcome: 'invalid', commitment: null };
  const open = book.commitments.filter(isOpenCommitment);
  const same = open.find(
    (c) =>
      c.counterpartTeamId === counterpart &&
      sameSet(c.intent.send, draft.send) &&
      sameSet(c.intent.receive, draft.receive)
  );
  if (same !== undefined) return { book, outcome: 'duplicate', commitment: same };
  if (
    open.length >= COMMITMENT_LIMITS.active ||
    open.filter((c) => c.counterpartTeamId === counterpart).length >= COMMITMENT_LIMITS.perCounterpart
  )
    return { book, outcome: 'limit', commitment: null };
  const commitment: Commitment = {
    id,
    kind: 'trade_interest',
    status: 'queued',
    createdAt: draft.at,
    updatedAt: draft.at,
    expiresAt: draft.expiresAt,
    nextReviewAt: null,
    agendaId: draft.agendaId,
    source: draft.source,
    counterpartTeamId: counterpart,
    intent: { send: [...draft.send].slice(0, 3), receive: [...draft.receive].slice(0, 3) },
    claims: [{ messageId: draft.source.messageId, verification: 'pending' }],
    childTaskIds: [draft.taskId],
    tradeId: null,
    decision: null,
    reconsiderations: 0,
    reply: null
  };
  return { book: withCommitment(book, commitment), outcome: 'created', commitment };
}

export type CommitmentEvent =
  /** The assigned task started its look. */
  | { type: 'start'; taskId: string }
  /** The assigned task's result: an offer that really went out, or why not. */
  | {
      type: 'offered';
      taskId: string;
      tradeId: string;
      facts: CommitmentFacts | null;
      verification?: Commitment['claims'][number]['verification'];
    }
  | {
      type: 'closed';
      taskId: string;
      status: 'declined' | 'cancelled' | 'failed' | 'expired';
      reason: CommitmentReason;
      facts?: CommitmentFacts | null;
      verification?: Commitment['claims'][number]['verification'];
    }
  /** What became of the offer, read from the league. */
  | { type: 'partner'; tradeStatus: string }
  /** Another task takes it over: a lost dispatch resumed, or a decline looked at again. */
  | { type: 'redispatch'; taskId: string; mode: 'resume' | 'reconsider' };

const PARTNER: Record<string, { status: CommitmentStatus; reason: CommitmentReason }> = {
  accepted: { status: 'fulfilled', reason: 'partner_accepted' },
  in_review: { status: 'fulfilled', reason: 'partner_accepted' },
  processed: { status: 'fulfilled', reason: 'partner_accepted' },
  rejected: { status: 'declined', reason: 'partner_declined' },
  countered: { status: 'declined', reason: 'partner_countered' },
  withdrawn: { status: 'cancelled', reason: 'offer_withdrawn' },
  expired: { status: 'expired', reason: 'offer_expired' },
  vetoed: { status: 'cancelled', reason: 'offer_vetoed' }
};

/**
 * Applies one event to commitment `id`, if it may: `applied` is false (and the book unchanged) for
 * an unknown id, a task that is not the assigned one, or an event its status does not allow.
 */
export function advanceCommitment(
  book: CommitmentBook,
  id: string,
  event: CommitmentEvent,
  at: string
): { book: CommitmentBook; applied: boolean; commitment: Commitment | null } {
  const c = book.commitments.find((x) => x.id === id);
  if (c === undefined) return { book, applied: false, commitment: null };
  const unchanged = { book, applied: false, commitment: c };
  const assigned = 'taskId' in event && event.type !== 'redispatch' ? currentTask(c) === event.taskId : true;
  if (!assigned) return unchanged;
  let next: Commitment | null = null;
  const decide = (
    status: CommitmentStatus,
    reason: CommitmentReason,
    taskId: string,
    facts: CommitmentFacts | null
  ): Commitment => ({
    ...c,
    status,
    updatedAt: at,
    decision: { reason, at, taskId, facts },
    nextReviewAt:
      status === 'declined' &&
      RECONSIDERABLE.has(reason) &&
      c.reconsiderations < COMMITMENT_LIMITS.maxReconsiderations &&
      Date.parse(at) + COMMITMENT_LIMITS.reconsiderCooldownMs < Date.parse(c.expiresAt)
        ? new Date(Date.parse(at) + COMMITMENT_LIMITS.reconsiderCooldownMs).toISOString()
        : null
  });
  switch (event.type) {
    case 'start':
      if (c.status === 'queued') next = { ...c, status: 'evaluating', updatedAt: at };
      break;
    case 'offered':
      if (c.status === 'queued' || c.status === 'evaluating') {
        const verification = event.verification;
        next = {
          ...decide('waiting_for_partner', 'offer_sent', event.taskId, event.facts),
          tradeId: event.tradeId
        };
        if (verification !== undefined) next.claims = c.claims.map((claim) => ({ ...claim, verification }));
      }
      break;
    case 'closed':
      if (c.status === 'queued' || c.status === 'evaluating') {
        const verification = event.verification;
        next = decide(event.status, event.reason, event.taskId, event.facts ?? null);
        if (verification !== undefined) next.claims = c.claims.map((claim) => ({ ...claim, verification }));
      }
      break;
    case 'partner': {
      const to = PARTNER[event.tradeStatus];
      if (c.status === 'waiting_for_partner' && to !== undefined)
        next = decide(to.status, to.reason, currentTask(c), c.decision?.facts ?? null);
      break;
    }
    case 'redispatch': {
      if (c.childTaskIds.includes(event.taskId) || c.childTaskIds.length >= COMMITMENT_LIMITS.childTasks)
        break;
      // Only a look whose task never started, and only once it has sat long enough to be lost.
      const resume =
        event.mode === 'resume' &&
        c.status === 'queued' &&
        Date.parse(at) - Date.parse(c.updatedAt) >= COMMITMENT_LIMITS.staleQueueMs;
      const reconsider =
        event.mode === 'reconsider' &&
        c.status === 'declined' &&
        c.nextReviewAt !== null &&
        Date.parse(c.nextReviewAt) <= Date.parse(at) &&
        Date.parse(at) < Date.parse(c.expiresAt);
      // The earlier decision stays until the new look replaces it, so its reason can be recalled.
      if (resume || reconsider)
        next = {
          ...c,
          status: 'queued',
          updatedAt: at,
          nextReviewAt: null,
          childTaskIds: [...c.childTaskIds, event.taskId],
          reconsiderations: c.reconsiderations + (reconsider ? 1 : 0)
        };
      break;
    }
  }
  if (next === null) return unchanged;
  return { book: withCommitment(book, next), applied: true, commitment: next };
}

/**
 * Looks not taken by their deadline become `expired` (`deadline_passed`); returns them too. An
 * offer already out waits for the league's answer (its own expiry included), not this deadline.
 */
export function expireCommitments(
  book: CommitmentBook,
  at: string
): { book: CommitmentBook; expired: Commitment[] } {
  let next = book;
  const expired: Commitment[] = [];
  for (const c of book.commitments) {
    if ((c.status !== 'queued' && c.status !== 'evaluating') || Date.parse(c.expiresAt) > Date.parse(at))
      continue;
    const event = {
      type: 'closed',
      taskId: currentTask(c),
      status: 'expired',
      reason: 'deadline_passed'
    } as const;
    const result = advanceCommitment(next, c.id, event, at);
    next = result.book;
    expired.push(result.commitment as Commitment);
  }
  return { book: next, expired };
}

/**
 * Takes the closing line for commitment `id`'s current look, once: `claimed` only for the first
 * caller. The claim is written before anything is posted, so a crash or a duplicate delivery can
 * lose a line but never post two.
 */
export function claimReply(
  book: CommitmentBook,
  id: string,
  at: string
): { book: CommitmentBook; claimed: boolean } {
  const c = book.commitments.find((x) => x.id === id);
  if (c === undefined || c.reply?.key === replyKey(c)) return { book, claimed: false };
  return {
    book: withCommitment(book, { ...c, reply: { key: replyKey(c), state: 'claimed', at } }),
    claimed: true
  };
}

export function settleReply(book: CommitmentBook, id: string, state: 'sent' | 'withheld'): CommitmentBook {
  const c = book.commitments.find((x) => x.id === id);
  if (c?.reply === null || c === undefined) return book;
  return withCommitment(book, { ...c, reply: { ...c.reply, state } });
}

/** The need that makes a decline worth another look: a new open slot a pitched player could fill. */
export function materialChange(c: Commitment, needs: readonly RosterSlot[]): RosterSlot | null {
  const facts = c.decision?.facts;
  if (facts === null || facts === undefined) return null;
  return (
    needs.find(
      (slot) =>
        !facts.needs.includes(slot) &&
        facts.receivePositions.some((p) => (SLOT_ELIGIBILITY[slot] as readonly string[]).includes(p))
    ) ?? null
  );
}

/**
 * What a check-in should pick up: queued commitments whose task never started (resume), and
 * reconsiderable declines past their cooldown whose facts changed (reconsider), oldest first.
 */
export function dueCommitments(
  book: CommitmentBook,
  at: string,
  needs: readonly RosterSlot[]
): { resume: Commitment[]; reconsider: { commitment: Commitment; change: RosterSlot }[] } {
  const now = Date.parse(at);
  const live = book.commitments
    .filter((c) => now < Date.parse(c.expiresAt) && c.childTaskIds.length < COMMITMENT_LIMITS.childTasks)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    resume: live.filter(
      (c) => c.status === 'queued' && now - Date.parse(c.updatedAt) >= COMMITMENT_LIMITS.staleQueueMs
    ),
    reconsider: live.flatMap((c) => {
      if (
        c.status !== 'declined' ||
        c.nextReviewAt === null ||
        Date.parse(c.nextReviewAt) > now ||
        c.decision === null ||
        !RECONSIDERABLE.has(c.decision.reason)
      )
        return [];
      const change = materialChange(c, needs);
      return change === null ? [] : [{ commitment: c, change }];
    })
  };
}

const REASON_LINES: Record<CommitmentReason, string> = {
  offer_sent: 'I sent an offer',
  value_below_floor: 'the value was not there for me',
  insufficient_depth: 'I could not spare the depth',
  lopsided: 'it was too one-sided to be fair',
  not_legal: 'it would not have been a legal trade',
  player_unavailable: 'those players were not all available',
  trades_closed: 'trades were closed',
  model_passed: 'I decided to pass',
  autopilot: 'I could not give it a proper look',
  send_failed: 'the league would not take the offer',
  seat_changed: 'the team changed hands',
  deadline_passed: 'I ran out of time on it',
  partner_accepted: 'you accepted',
  partner_declined: 'you turned it down',
  partner_countered: 'you countered',
  offer_withdrawn: 'the offer was withdrawn',
  offer_expired: 'the offer expired',
  offer_vetoed: 'the league vetoed it'
};

/** A decision's reason as the agent says it: qualitative, never its numbers or bar. */
export function reasonLine(reason: CommitmentReason): string {
  return REASON_LINES[reason];
}
