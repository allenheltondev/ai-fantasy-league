import {
  COMMITMENT_LIMITS,
  RosterSlotSchema,
  SLOT_ELIGIBILITY,
  SOCIAL_LIMITS,
  advanceCommitment,
  hashString,
  claimReply,
  currentTask,
  dueCommitments,
  dueReplies,
  expireCommitments,
  materialChange,
  openTradeInterest,
  reasonLine,
  replyKey,
  settleReply,
  type Commitment,
  type CommitmentBook,
  type CommitmentEvent,
  type CommitmentReason,
  type OpenOutcome,
  type RosterSlot
} from '@fantasy/core';
import { seatTenureStart, type Services } from '@fantasy/server';
import { z } from 'zod';
import { errorName } from './dispatch.js';
import { taskIdFor } from './router.js';
import type { ChatSource } from './tasks/chat-action.js';
import type { TaskContext, TaskFollowUp } from './tasks/kinds.js';

/**
 * Durable commitments at runtime (#215; the lifecycle is core `commitments.ts`, ADR 007).
 *
 * 1. A chat reply's trade takeaway (#196) becomes a typed `trade_interest` (`openInterest`): the
 *    players both teams really roster, where it was said (never its words), the agenda goal it
 *    could repair, and a deadline. Validation, duplication, and the open-work limits are core's; a
 *    new one takes one of the day's chat-action uses (#196) before it is recorded. It is handed to
 *    `trade_proposal` as an ordinary follow-up (#207's outbox), with the commitment's id.
 * 2. The follow-up (`beginLook`) checks it still owns the commitment and the seat has the same
 *    occupant, re-checks every fact itself (the pitch's weighing in trade-proposal.ts), and
 *    records the actual result before it says anything (`closeLook`).
 * 3. At most one closing line per look, in the conversation it came from, is persisted in the same
 *    write as the result. Its leased delivery retries through #207's outbox under one operation key:
 *    a crash cannot lose or duplicate it. In a league room the stored line never names terms.
 * 4. A check-in (`reviewCommitments`) reads what became of offers, expires looks never taken,
 *    resumes one whose task was lost, or reconsiders a decline when a new roster need (#214's
 *    agenda) makes the pitched players worth more. At most one follow-up per check-in, and a
 *    reconsideration takes a chat-action use too; with none left it waits for the next check-in.
 *
 * Commitments never reach a prompt, memory, or the activity log's public text. Storage failures
 * log a warning: a chat takeaway then falls back to the plain #196 follow-up.
 */

/** Which commitment a follow-up works on, under which occupant, and what changed (a reconsideration). */
export const CommitmentRefSchema = z.object({
  id: z.string().min(1),
  tenure: z.string().min(1),
  change: RosterSlotSchema.optional()
});
export type CommitmentRef = z.infer<typeof CommitmentRefSchema>;

/** A durable closing-message delivery handed through #207's task outbox. */
export const CommitmentReplyRefSchema = z.object({
  id: z.string().min(1),
  tenure: z.string().min(1),
  key: z.string().min(1)
});
export type CommitmentReplyRef = z.infer<typeof CommitmentReplyRefSchema>;

/** The agent's commitment store, bound to its league, agent, and team by the runner. */
export interface CommitmentAccess {
  /** The current occupant's tenure; null when the seat is no longer an agent's. */
  tenure(): Promise<string | null>;
  read(tenure: string): Promise<CommitmentBook>;
  update(tenure: string, change: (book: CommitmentBook) => CommitmentBook): Promise<CommitmentBook>;
  /** The occupant's active agenda goals (#214): deterministic facts, never prompt text. */
  needs(tenure: string): Promise<{ id: string; slot: RosterSlot }[]>;
}

export function commitmentAccess(
  services: Services,
  leagueId: string,
  agentId: string,
  teamId: string
): CommitmentAccess {
  const { agents } = services.repos;
  return {
    async tenure() {
      const team = await services.repos.teams.get(leagueId, teamId);
      return team?.seatType === 'agent' ? seatTenureStart(team) : null;
    },
    read: (tenure) => agents.getCommitments(leagueId, agentId, tenure),
    update: (tenure, change) => agents.updateCommitments(leagueId, agentId, tenure, change),
    async needs(tenure) {
      const agenda = await agents.getAgenda(leagueId, agentId, tenure);
      return agenda.goals.filter((g) => g.status === 'active').map((g) => ({ id: g.id, slot: g.slot }));
    }
  };
}

const eligible = (slot: RosterSlot, positions: readonly string[]) =>
  positions.some((p) => (SLOT_ELIGIBILITY[slot] as readonly string[]).includes(p));

/** The follow-up that works on a commitment: the pitched swap, re-weighed by `trade_proposal`. */
export function interestFollowUp(c: Commitment, ref: CommitmentRef): TaskFollowUp {
  const chat: ChatSource = {
    roomId: c.source.roomId,
    messageId: c.source.messageId,
    fromTeamId: c.source.fromTeamId
  };
  return {
    kind: 'trade_proposal',
    payload: {
      reason: 'chat',
      withTeamId: c.counterpartTeamId,
      send: c.intent.send,
      receive: c.intent.receive,
      chat,
      commitment: ref
    },
    // Its chat-action use was taken when it was recorded (or reconsidered).
    chatDriven: false
  };
}

export type InterestResult =
  | { outcome: 'created' | 'existing'; followUp: TaskFollowUp }
  | { outcome: Exclude<OpenOutcome, 'created' | 'existing'> | 'action_limit' };

/**
 * Records a trade interest from chat (see the module comment). Null when there is no store or it
 * failed: the caller hands the takeaway on as before.
 */
export async function openInterest(
  ctx: TaskContext,
  input: {
    source: ChatSource;
    visibility: 'dm' | 'room';
    send: readonly string[];
    receive: readonly string[];
    receivePositions: readonly string[];
  }
): Promise<InterestResult | null> {
  const access = ctx.commitments;
  if (access === undefined) return null;
  try {
    const tenure = await access.tenure();
    if (tenure === null) return null;
    const at = ctx.clock.now();
    const deadline = ctx.league.deadlines.tradeDeadlineAt;
    const ttl = at.getTime() + COMMITMENT_LIMITS.ttlMs;
    const expiresAt = new Date(
      deadline !== null && Date.parse(deadline) > at.getTime() ? Math.min(ttl, Date.parse(deadline)) : ttl
    ).toISOString();
    const needs = await access.needs(tenure);
    const draft = {
      at: at.toISOString(),
      taskId: taskIdFor(ctx.trigger.eventId, ctx.principal.teamId, 'trade_proposal'),
      selfTeamId: ctx.principal.teamId,
      source: { ...input.source, visibility: input.visibility },
      send: input.send,
      receive: input.receive,
      expiresAt,
      agendaId: needs.find((n) => eligible(n.slot, input.receivePositions))?.id ?? null
    };
    // A look to take on spends a chat-action use first; a redelivery or a duplicate spends none.
    const dry = openTradeInterest(await access.read(tenure), draft);
    if (
      dry.outcome === 'created' &&
      !(await ctx.claimLimit('chat-action', SOCIAL_LIMITS.chatActionsPerDay, SOCIAL_LIMITS.windowMs))
    )
      return { outcome: 'action_limit' };
    let result = dry;
    await access.update(tenure, (book) => {
      result = openTradeInterest(book, draft);
      return result.book;
    });
    if (result.commitment === null || (result.outcome !== 'created' && result.outcome !== 'existing'))
      return { outcome: result.outcome as Exclude<OpenOutcome, 'created' | 'existing'> };
    return {
      outcome: result.outcome,
      followUp: interestFollowUp(result.commitment, { id: result.commitment.id, tenure })
    };
  } catch (error) {
    ctx.log.warn('agent commitments unavailable; handing the takeaway on as is', { error: errorName(error) });
    return null;
  }
}

/** The closing lines for one look: `dm` for the two teams, `room` for a league room (no terms). */
export interface ClosingLines {
  dm: string;
  room: string;
}

const permanentReplyFailure = (code: string) =>
  new Set([
    'FORBIDDEN',
    'NOT_FOUND',
    'ROOM_NOT_FOUND',
    'ROOM_ARCHIVED',
    'MESSAGE_BLOCKED',
    'LEAGUE_NOT_FOUND',
    'TEAM_NOT_FOUND'
  ]).has(code);

const replyToolKey = (ctx: TaskContext, c: Commitment, attempt = c.reply?.attempts ?? 1) =>
  `agent-commitment-reply.${hashString(`${ctx.league.id}:${ctx.principal.teamId}:${c.id}`).toString(36)}.${c.reconsiderations}.${attempt}`;

/**
 * Delivers a persisted closing line. The claim is an expiring lease; the post's stable idempotency
 * key makes recovery safe even when the earlier post succeeded but its acknowledgement was lost.
 */
export async function deliverReply(
  ctx: TaskContext,
  ref: CommitmentReplyRef
): Promise<'sent' | 'deferred' | 'expired' | 'suppressed' | 'unavailable'> {
  const access = ctx.commitments;
  if (access === undefined) return 'unavailable';
  const at = ctx.clock.now().toISOString();
  let claimed: Commitment | null = null;
  await access.update(ref.tenure, (book) => {
    const c = book.commitments.find((x) => x.id === ref.id && x.reply?.key === ref.key);
    if (c === undefined || c.reply === null) return book;
    const result = claimReply(book, ref.id, {
      at,
      owner: ctx.taskId,
      text: c.reply.text,
      ...(c.reply.expiresAt === null ? {} : { expiresAt: c.reply.expiresAt })
    });
    if (result.claimed) claimed = result.book.commitments.find((x) => x.id === ref.id) ?? null;
    return result.book;
  });
  const c = claimed as Commitment | null;
  if (c === null || c.reply === null) {
    const current = (await access.read(ref.tenure)).commitments.find((x) => x.id === ref.id)?.reply;
    const outcome =
      current?.state === 'expired'
        ? 'expired'
        : current?.state === 'suppressed'
          ? 'suppressed'
          : 'unavailable';
    if (outcome !== 'unavailable')
      ctx.log.info('commitment reply terminal', { commitmentId: ref.id, outcome, reason: current?.failure });
    return outcome;
  }
  const settle = async (state: 'sent' | 'withheld' | 'suppressed', failure?: string) => {
    await access.update(ref.tenure, (book) =>
      settleReply(book, ref.id, {
        key: ref.key,
        owner: ctx.taskId,
        at,
        state,
        ...(failure === undefined ? {} : { failure })
      })
    );
  };
  const tenure = await access.tenure();
  if (tenure !== ref.tenure) {
    await settle('suppressed', 'seat_changed');
    ctx.log.info('commitment reply suppressed', { commitmentId: ref.id, reason: 'seat_changed' });
    return 'suppressed';
  }
  if (ctx.league.phase === 'complete') {
    await settle('suppressed', 'league_complete');
    ctx.log.info('commitment reply suppressed', { commitmentId: ref.id, reason: 'league_complete' });
    return 'suppressed';
  }
  const posted = await ctx.tools.call(
    'post_message',
    { roomId: c.source.roomId, text: c.reply.text, replyToId: c.source.messageId },
    { key: replyToolKey(ctx, c), global: true }
  );
  if ('error' in posted) {
    const terminal = permanentReplyFailure(posted.error.code);
    await settle(terminal ? 'suppressed' : 'withheld', posted.error.code);
    ctx.log.info(terminal ? 'commitment reply suppressed' : 'commitment reply deferred', {
      commitmentId: ref.id,
      reason: posted.error.code,
      attempts: c.reply.attempts
    });
    return terminal ? 'suppressed' : 'deferred';
  }
  await settle('sent');
  ctx.log.info('commitment reply delivered', { commitmentId: ref.id, attempts: c.reply.attempts });
  return 'sent';
}

export function replyFollowUp(c: Commitment, tenure: string): TaskFollowUp | null {
  return c.reply === null
    ? null
    : { kind: 'commitment_reply', payload: { id: c.id, tenure, key: c.reply.key } };
}

/**
 * Records a look's result and recoverable closing-line delivery together, then attempts the post.
 * A crash or transient refusal leaves enough state for a later check-in to dispatch recovery.
 */
export async function closeLook(
  ctx: TaskContext,
  ref: Pick<CommitmentRef, 'id' | 'tenure'>,
  event: CommitmentEvent,
  lines: ClosingLines
): Promise<{ applied: boolean; commitment: Commitment | null }> {
  const access = ctx.commitments as CommitmentAccess;
  const at = ctx.clock.now().toISOString();
  const persisted = await access.update(ref.tenure, (book) => {
    const result = advanceCommitment(book, ref.id, event, at);
    if (!result.applied) return book;
    const closed = result.commitment as Commitment;
    const text = closed.source.visibility === 'dm' ? lines.dm : lines.room;
    return claimReply(result.book, ref.id, { at, owner: ctx.taskId, text }).book;
  });
  const closed = persisted.commitments.find((c) => c.id === ref.id) ?? null;
  const claimed =
    closed !== null &&
    closed.reply?.key === replyKey(closed) &&
    closed.reply.state === 'claimed' &&
    closed.reply.owner === ctx.taskId;
  if (claimed && closed !== null && closed.reply !== null) {
    const posted = await ctx.tools.call(
      'post_message',
      {
        roomId: closed.source.roomId,
        text: closed.reply.text,
        replyToId: closed.source.messageId
      },
      { key: replyToolKey(ctx, closed), global: true }
    );
    const failure = 'error' in posted ? posted.error.code : undefined;
    const state = failure === undefined ? 'sent' : permanentReplyFailure(failure) ? 'suppressed' : 'withheld';
    await access.update(ref.tenure, (book) =>
      settleReply(book, ref.id, {
        key: replyKey(closed),
        owner: ctx.taskId,
        at,
        state,
        ...(failure === undefined ? {} : { failure })
      })
    );
  }
  return { applied: claimed, commitment: closed };
}

/** Lines for a look that ended without an offer, the reason in the agent's words (no numbers). */
export function refusalLines(
  c: Pick<Commitment, 'reconsiderations'>,
  reason: CommitmentReason,
  change?: RosterSlot
): ClosingLines {
  const why = reasonLine(reason);
  const again = c.reconsiderations > 0;
  return {
    dm: again
      ? `Took another look after my ${change ?? 'roster'} news, but ${why}. Still a pass.`
      : `Took a proper look at that one: ${why}. Pass for now.`,
    room: again
      ? 'Took another look at that trade idea. Still a pass.'
      : 'Took a proper look at that trade idea. Pass for now.'
  };
}

/** Lines for a look that could not be finished: never a claim that anything was sent. */
export function failureLines(reason: CommitmentReason): ClosingLines {
  return {
    dm: `Couldn't finish that trade look (${reasonLine(reason)}). Nothing was sent.`,
    room: "Couldn't finish that trade look. Nothing was sent."
  };
}

/**
 * Starts a follow-up's look at its commitment, or says why it will not (`skip`, for the task's skip):
 * the seat changed hands (`seat_changed`, cancelled without a word: the new occupant owes nothing),
 * the commitment is gone or another task owns it now, it is already settled, or its deadline passed
 * (`commitment_expired`, with a closing line). Returns it as it was before this look.
 */
export async function beginLook(
  ctx: TaskContext,
  ref: CommitmentRef
): Promise<{ commitment: Commitment } | { skip: string }> {
  const access = ctx.commitments;
  if (access === undefined) return { skip: 'commitment_unavailable' };
  const at = ctx.clock.now().toISOString();
  if ((await access.tenure()) !== ref.tenure) {
    await access.update(
      ref.tenure,
      (book) =>
        advanceCommitment(
          book,
          ref.id,
          { type: 'closed', taskId: ctx.taskId, status: 'cancelled', reason: 'seat_changed' },
          at
        ).book
    );
    return { skip: 'seat_changed' };
  }
  const c = (await access.read(ref.tenure)).commitments.find((x) => x.id === ref.id);
  if (c === undefined) return { skip: 'commitment_missing' };
  if (currentTask(c) !== ctx.taskId) return { skip: 'commitment_superseded' };
  if (c.status !== 'queued' && c.status !== 'evaluating') return { skip: 'commitment_settled' };
  if (Date.parse(c.expiresAt) <= Date.parse(at)) {
    await closeLook(
      ctx,
      ref,
      { type: 'closed', taskId: ctx.taskId, status: 'expired', reason: 'deadline_passed' },
      failureLines('deadline_passed')
    );
    return { skip: 'commitment_expired' };
  }
  await access.update(
    ref.tenure,
    (book) => advanceCommitment(book, ref.id, { type: 'start', taskId: ctx.taskId }, at).book
  );
  return { commitment: c };
}

const TradeSchema = z.object({ trades: z.array(z.object({ id: z.string(), status: z.string() })) });

/**
 * A check-in's pass over the agent's commitments (see the module comment): at most one follow-up.
 * Never throws: an unreadable store or league logs a warning and hands nothing on.
 */
export async function reviewCommitments(ctx: TaskContext): Promise<TaskFollowUp[]> {
  const access = ctx.commitments;
  if (access === undefined) return [];
  try {
    const tenure = await access.tenure();
    if (tenure === null) return [];
    const at = ctx.clock.now().toISOString();
    const book = await access.read(tenure);
    if (book.commitments.length === 0) return [];
    // A result already exists, so recovery only delivers its persisted safe line. The outbox gives
    // this its own idempotent task; it never reruns the trade look.
    const dueReply = dueReplies(book, at)[0];
    if (dueReply !== undefined) {
      const follow = replyFollowUp(dueReply, tenure);
      if (follow !== null) {
        ctx.log.info('commitment reply recovery due', {
          commitmentId: dueReply.id,
          state: dueReply.reply?.state,
          attempts: dueReply.reply?.attempts
        });
        return [follow];
      }
    }
    // What became of each offer: the league's answer, never a model's summary.
    for (const c of book.commitments.filter(
      (x) => x.status === 'waiting_for_partner' && x.tradeId !== null
    )) {
      const response = await ctx.tools.call('list_trades', { tradeId: c.tradeId });
      const parsed = 'error' in response ? null : TradeSchema.safeParse(response.data);
      const status = parsed?.success === true ? parsed.data.trades[0]?.status : undefined;
      if (status === undefined || status === 'proposed') continue;
      await access.update(
        tenure,
        (b) => advanceCommitment(b, c.id, { type: 'partner', tradeStatus: status }, at).book
      );
    }
    // Looks never taken by their deadline: expired, each with its one line.
    const due = expireCommitments(await access.read(tenure), at).expired;
    for (const c of due)
      await closeLook(
        ctx,
        { id: c.id, tenure },
        { type: 'closed', taskId: currentTask(c), status: 'expired', reason: 'deadline_passed' },
        failureLines('deadline_passed')
      );
    const taskId = taskIdFor(ctx.trigger.eventId, ctx.principal.teamId, 'trade_proposal');
    const needs = ctx.agenda?.goals.filter((g) => g.status === 'active').map((g) => g.slot) ?? [];
    const latest = await access.read(tenure);
    // A redelivered check-in hands on what it handed on before, without spending anything again.
    const mine = latest.commitments.find((c) => currentTask(c) === taskId && c.status === 'queued');
    if (mine !== undefined) {
      const change = mine.reconsiderations > 0 ? (materialChange(mine, needs) ?? undefined) : undefined;
      return [interestFollowUp(mine, { id: mine.id, tenure, ...(change === undefined ? {} : { change }) })];
    }
    const { resume, reconsider } = dueCommitments(latest, at, needs);
    const lost = resume[0];
    if (lost !== undefined) return handOn(ctx, tenure, lost, taskId, 'resume');
    const next = reconsider[0];
    if (next === undefined) return [];
    if (!(await ctx.claimLimit('chat-action', SOCIAL_LIMITS.chatActionsPerDay, SOCIAL_LIMITS.windowMs)))
      return [];
    return handOn(ctx, tenure, next.commitment, taskId, 'reconsider', next.change);
  } catch (error) {
    ctx.log.warn('agent commitments unavailable; check-in goes on without them', { error: errorName(error) });
    return [];
  }
}

async function handOn(
  ctx: TaskContext,
  tenure: string,
  c: Commitment,
  taskId: string,
  mode: 'resume' | 'reconsider',
  change?: RosterSlot
): Promise<TaskFollowUp[]> {
  const access = ctx.commitments as CommitmentAccess;
  const at = ctx.clock.now().toISOString();
  let handed: Commitment | null = null;
  await access.update(tenure, (book) => {
    const result = advanceCommitment(book, c.id, { type: 'redispatch', taskId, mode }, at);
    handed = result.applied ? result.commitment : null;
    return result.book;
  });
  // Another task got to it first (it was answered, expired, or handed on meanwhile): nothing to do.
  const taken = handed as Commitment | null;
  if (taken === null) return [];
  return [interestFollowUp(taken, { id: taken.id, tenure, ...(change === undefined ? {} : { change }) })];
}
