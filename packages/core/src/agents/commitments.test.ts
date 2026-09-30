import { describe, expect, it } from 'vitest';
import {
  COMMITMENT_LIMITS,
  CommitmentBookSchema,
  RECONSIDERABLE,
  advanceCommitment,
  claimReply,
  dueCommitments,
  emptyCommitments,
  expireCommitments,
  materialChange,
  openTradeInterest,
  reasonLine,
  settleReply,
  type CommitmentBook,
  type CommitmentFacts,
  type TradeInterestDraft
} from './commitments.js';

const T0 = '2026-10-04T15:00:00.000Z';
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();

const draft = (overrides: Partial<TradeInterestDraft> = {}): TradeInterestDraft => ({
  at: T0,
  taskId: 'look-1',
  selfTeamId: 'team-2',
  source: { roomId: 'dm-team-1-team-2', messageId: 'm1', fromTeamId: 'team-1', visibility: 'dm' },
  send: ['wr5'],
  receive: ['h-rb'],
  expiresAt: at(96),
  agendaId: null,
  ...overrides
});

const facts = (overrides: Partial<CommitmentFacts> = {}): CommitmentFacts => ({
  score: 0,
  bar: 2,
  credit: 0,
  lineupDelta: 0,
  attachmentPremium: null,
  needs: [],
  receivePositions: ['RB'],
  ...overrides
});

function opened(overrides: Partial<TradeInterestDraft> = {}): { book: CommitmentBook; id: string } {
  const result = openTradeInterest(emptyCommitments(), draft(overrides));
  return { book: result.book, id: result.commitment!.id };
}

function declined(hours = 1, reason: 'value_below_floor' | 'not_legal' = 'value_below_floor') {
  const { book, id } = opened();
  const started = advanceCommitment(book, id, { type: 'start', taskId: 'look-1' }, at(hours)).book;
  const closed = advanceCommitment(
    started,
    id,
    {
      type: 'closed',
      taskId: 'look-1',
      status: 'declined',
      reason,
      facts: facts(),
      verification: 'unsupported'
    },
    at(hours)
  );
  return { book: closed.book, id, commitment: closed.commitment! };
}

describe('opening a trade interest', () => {
  it('records a validated, queued commitment with its provenance and no text', () => {
    const { book, outcome, commitment } = openTradeInterest(emptyCommitments(), draft({ agendaId: 'goal' }));
    expect(outcome).toBe('created');
    expect(commitment).toMatchObject({
      id: 'trade_interest:m1',
      status: 'queued',
      counterpartTeamId: 'team-1',
      claims: [{ messageId: 'm1', verification: 'pending' }],
      childTaskIds: ['look-1'],
      agendaId: 'goal',
      decision: null,
      reply: null
    });
    expect(CommitmentBookSchema.parse(book)).toEqual(book);
  });

  it('is idempotent per message, refuses duplicates, and holds the open-work limits', () => {
    const { book } = opened();
    expect(openTradeInterest(book, draft()).outcome).toBe('existing');
    const again = openTradeInterest(book, draft({ source: { ...draft().source, messageId: 'm2' } }));
    expect(again).toMatchObject({ outcome: 'duplicate', book });
    expect(again.commitment?.id).toBe('trade_interest:m1');
    const other = openTradeInterest(
      book,
      draft({ source: { ...draft().source, messageId: 'm3' }, send: ['wr4'] })
    );
    expect(other).toMatchObject({ outcome: 'limit', commitment: null });
    let full = emptyCommitments();
    for (const team of ['team-1', 'team-3', 'team-4'])
      full = openTradeInterest(
        full,
        draft({ source: { ...draft().source, messageId: team, fromTeamId: team } })
      ).book;
    const fourth = draft({ source: { ...draft().source, messageId: 'm9', fromTeamId: 'team-5' } });
    expect(openTradeInterest(full, fourth).outcome).toBe('limit');
  });

  it('rejects a draft about itself, with nothing on a side, overlapping, or already past due', () => {
    for (const bad of [
      draft({ selfTeamId: 'team-1' }),
      draft({ send: [] }),
      draft({ receive: [] }),
      draft({ receive: ['wr5'] }),
      draft({ expiresAt: T0 })
    ])
      expect(openTradeInterest(emptyCommitments(), bad)).toMatchObject({
        outcome: 'invalid',
        commitment: null
      });
  });
});

describe('the commitment lifecycle', () => {
  it('lets only the assigned task start and decide, and never twice', () => {
    const { book, id } = opened();
    expect(advanceCommitment(book, id, { type: 'start', taskId: 'stranger' }, T0).applied).toBe(false);
    expect(advanceCommitment(book, 'nope', { type: 'start', taskId: 'look-1' }, T0).commitment).toBeNull();
    const started = advanceCommitment(book, id, { type: 'start', taskId: 'look-1' }, at(1));
    expect(started.commitment?.status).toBe('evaluating');
    expect(advanceCommitment(started.book, id, { type: 'start', taskId: 'look-1' }, at(1)).applied).toBe(
      false
    );
    const offered = advanceCommitment(
      started.book,
      id,
      { type: 'offered', taskId: 'look-1', tradeId: 't1', facts: facts(), verification: 'supported' },
      at(1)
    );
    expect(offered.commitment).toMatchObject({
      status: 'waiting_for_partner',
      tradeId: 't1',
      decision: { reason: 'offer_sent', taskId: 'look-1' },
      claims: [{ verification: 'supported' }],
      nextReviewAt: null
    });
    const noClaims = advanceCommitment(
      started.book,
      id,
      { type: 'offered', taskId: 'look-1', tradeId: 't1', facts: null },
      at(1)
    );
    expect(noClaims.commitment?.claims).toEqual([{ messageId: 'm1', verification: 'pending' }]);
    // Settled: a second result is refused.
    const closed = { type: 'closed', taskId: 'look-1', status: 'failed', reason: 'send_failed' } as const;
    expect(advanceCommitment(offered.book, id, closed, at(2)).applied).toBe(false);
    expect(advanceCommitment(started.book, id, closed, at(2)).commitment).toMatchObject({
      status: 'failed',
      decision: { reason: 'send_failed', facts: null },
      claims: [{ verification: 'pending' }]
    });
  });

  it("records the partner's answer from the league, and nothing for an unknown or open status", () => {
    const { book, id } = opened();
    const waiting = advanceCommitment(
      book,
      id,
      { type: 'offered', taskId: 'look-1', tradeId: 't1', facts: facts() },
      at(1)
    ).book;
    const answers = {
      accepted: ['fulfilled', 'partner_accepted'],
      in_review: ['fulfilled', 'partner_accepted'],
      processed: ['fulfilled', 'partner_accepted'],
      rejected: ['declined', 'partner_declined'],
      countered: ['declined', 'partner_countered'],
      withdrawn: ['cancelled', 'offer_withdrawn'],
      expired: ['expired', 'offer_expired'],
      vetoed: ['cancelled', 'offer_vetoed']
    } as const;
    for (const [tradeStatus, [status, reason]] of Object.entries(answers)) {
      const result = advanceCommitment(waiting, id, { type: 'partner', tradeStatus }, at(2));
      expect(result.commitment).toMatchObject({
        status,
        decision: { reason, facts: facts() },
        nextReviewAt: null
      });
    }
    expect(advanceCommitment(waiting, id, { type: 'partner', tradeStatus: 'proposed' }, at(2)).applied).toBe(
      false
    );
    expect(advanceCommitment(book, id, { type: 'partner', tradeStatus: 'accepted' }, at(2)).applied).toBe(
      false
    );
  });

  it('opens a reconsiderable decline to one more look, after the cooldown and before the deadline', () => {
    const { book, id, commitment } = declined();
    expect(commitment.nextReviewAt).toBe(at(1 + 12));
    const reconsider = { type: 'redispatch', taskId: 'look-2', mode: 'reconsider' } as const;
    expect(advanceCommitment(book, id, reconsider, at(12)).applied).toBe(false);
    expect(advanceCommitment(book, id, reconsider, at(96)).applied).toBe(false);
    const again = advanceCommitment(book, id, reconsider, at(13));
    expect(again.commitment).toMatchObject({
      status: 'queued',
      reconsiderations: 1,
      childTaskIds: ['look-1', 'look-2'],
      nextReviewAt: null,
      // The earlier reason stays until the new look decides, so it can be recalled.
      decision: { reason: 'value_below_floor' }
    });
    // The second decline is final: the maximum was reached.
    const second = advanceCommitment(
      again.book,
      id,
      { type: 'closed', taskId: 'look-2', status: 'declined', reason: 'value_below_floor', facts: facts() },
      at(14)
    );
    expect(second.commitment?.nextReviewAt).toBeNull();
    // A reason facts cannot change, or a cooldown that would end past the deadline, closes it too.
    expect(declined(1, 'not_legal').commitment.nextReviewAt).toBeNull();
    expect(declined(90).commitment.nextReviewAt).toBeNull();
  });

  it('resumes only a look whose task never started and has sat long enough, within the task bound', () => {
    const { book, id } = opened();
    const resume = (taskId: string, hours: number, from = book) =>
      advanceCommitment(from, id, { type: 'redispatch', taskId, mode: 'resume' }, at(hours));
    expect(resume('look-2', 0.5).applied).toBe(false);
    expect(resume('look-1', 2).applied).toBe(false);
    let current = book;
    for (let i = 2; i <= COMMITMENT_LIMITS.childTasks; i++)
      current = resume(`look-${i}`, 2 * i, current).book;
    expect(current.commitments[0]?.childTaskIds).toHaveLength(COMMITMENT_LIMITS.childTasks);
    expect(resume('look-9', 99, current).applied).toBe(false);
    const started = advanceCommitment(book, id, { type: 'start', taskId: 'look-1' }, at(1)).book;
    expect(resume('look-2', 5, started).applied).toBe(false);
  });

  it('expires looks never taken, but leaves an offer to the league', () => {
    const { book, id } = opened();
    expect(expireCommitments(book, at(95)).expired).toEqual([]);
    const { book: expired, expired: list } = expireCommitments(book, at(96));
    expect(list.map((c) => [c.id, c.status, c.decision?.reason])).toEqual([
      [id, 'expired', 'deadline_passed']
    ]);
    expect(expired.commitments[0]?.status).toBe('expired');
    const waiting = advanceCommitment(
      book,
      id,
      { type: 'offered', taskId: 'look-1', tradeId: 't1', facts: null },
      at(1)
    ).book;
    expect(expireCommitments(waiting, at(200)).expired).toEqual([]);
  });

  it('keeps at most the open commitments plus a bounded history, newest first', () => {
    let book = emptyCommitments();
    for (let i = 0; i < COMMITMENT_LIMITS.history + 3; i++) {
      const messageId = `m${i}`;
      book = openTradeInterest(book, draft({ at: at(i), source: { ...draft().source, messageId } })).book;
      book = advanceCommitment(
        book,
        `trade_interest:${messageId}`,
        { type: 'closed', taskId: 'look-1', status: 'cancelled', reason: 'autopilot' },
        at(i)
      ).book;
    }
    expect(book.commitments).toHaveLength(COMMITMENT_LIMITS.history);
    expect(book.commitments[0]?.id).toBe(`trade_interest:m${COMMITMENT_LIMITS.history + 2}`);
  });
});

describe('closing lines and reconsideration', () => {
  it('claims one closing line per look, and settles it', () => {
    const { book, id } = declined();
    const first = claimReply(book, id, at(2));
    expect(first.claimed).toBe(true);
    expect(first.book.commitments[0]?.reply).toEqual({ key: `${id}#0`, state: 'claimed', at: at(2) });
    expect(claimReply(first.book, id, at(3))).toMatchObject({ claimed: false, book: first.book });
    expect(claimReply(first.book, 'nope', at(3)).claimed).toBe(false);
    expect(settleReply(first.book, id, 'sent').commitments[0]?.reply?.state).toBe('sent');
    expect(settleReply(book, id, 'sent')).toBe(book);
    expect(settleReply(book, 'nope', 'sent')).toBe(book);
    // A reconsideration is a new look with its own line.
    const again = advanceCommitment(
      first.book,
      id,
      { type: 'redispatch', taskId: 'look-2', mode: 'reconsider' },
      at(14)
    ).book;
    expect(claimReply(again, id, at(15)).claimed).toBe(true);
  });

  it('finds a material change only in a new need the pitched players could fill', () => {
    const { commitment } = declined();
    expect(materialChange(commitment, [])).toBeNull();
    expect(materialChange(commitment, ['WR'])).toBeNull();
    expect(materialChange(commitment, ['RB'])).toBe('RB');
    expect(materialChange(commitment, ['W/R/T'])).toBe('W/R/T');
    expect(materialChange({ ...commitment, decision: null }, ['RB'])).toBeNull();
    const known = { ...commitment, decision: { ...commitment.decision!, facts: facts({ needs: ['RB'] }) } };
    expect(materialChange(known, ['RB'])).toBeNull();
  });

  it('lists lost looks to resume and changed declines to reconsider', () => {
    const lost = opened();
    expect(dueCommitments(lost.book, at(0.5), [])).toEqual({ resume: [], reconsider: [] });
    expect(dueCommitments(lost.book, at(2), []).resume.map((c) => c.id)).toEqual([lost.id]);
    expect(dueCommitments(lost.book, at(96), []).resume).toEqual([]);
    const earlier = openTradeInterest(
      lost.book,
      draft({ at: at(-1), source: { ...draft().source, messageId: 'm0', fromTeamId: 'team-3' } })
    ).book;
    expect(dueCommitments(earlier, at(2), []).resume.map((c) => c.id)).toEqual([
      'trade_interest:m0',
      lost.id
    ]);
    const { book, id } = declined();
    expect(dueCommitments(book, at(5), ['RB']).reconsider).toEqual([]);
    expect(dueCommitments(book, at(14), [])).toEqual({ resume: [], reconsider: [] });
    expect(dueCommitments(book, at(14), ['RB']).reconsider).toMatchObject([
      { commitment: { id }, change: 'RB' }
    ]);
    const final = declined(1, 'not_legal');
    expect(dueCommitments(final.book, at(14), ['RB']).reconsider).toEqual([]);
    const cleared = { ...book, commitments: book.commitments.map((c) => ({ ...c, decision: null })) };
    expect(dueCommitments(cleared, at(14), ['RB']).reconsider).toEqual([]);
  });

  it('says a reason in words, without numbers', () => {
    expect(reasonLine('value_below_floor')).toBe('the value was not there for me');
    expect(reasonLine('insufficient_depth')).toBe('I could not spare the depth');
    expect(reasonLine('partner_declined')).toBe('you turned it down');
    // A lopsided swap is its own reason (#219), and facts cannot make it worth another look.
    expect(reasonLine('lopsided')).toBe('it was too one-sided to be fair');
    expect(RECONSIDERABLE.has('lopsided')).toBe(false);
  });
});
