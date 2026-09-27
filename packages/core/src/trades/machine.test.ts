import { describe, expect, it } from 'vitest';
import type { LeagueSettings } from '../rules/settings.js';
import { NOW, context, settings, squad } from './fixtures.test-helpers.js';
import {
  acceptTrade,
  canTransition,
  castVetoVote,
  commissionerReview,
  counterTrade,
  expireTrade,
  processTrade,
  proposeTrade,
  rejectTrade,
  startReview,
  voidTrade,
  withdrawTrade,
  type TradeResult
} from './machine.js';
import type { Trade, TradeSide } from './trade.js';

const rosters = {
  A: squad('a', 14),
  B: squad('b', 16, 'BUF'),
  C: squad('c', 10, 'MIA'),
  D: squad('d', 10, 'MIA'),
  E: squad('e', 10, 'MIA')
};
const ctx = context(rosters);
const side = (teamId: string, sends: string[] = [], drops: string[] = []): TradeSide => ({
  teamId,
  sends,
  drops
});
const withReview = (review: LeagueSettings['trades']['review']): LeagueSettings => ({
  ...settings,
  trades: { ...settings.trades, review }
});

function ok<T>(r: TradeResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.issues.map((i) => i.code).join(', ')}`);
  return r.trade;
}
function codes<T>(r: TradeResult<T> | { ok: false; issues: { code: string }[] } | { ok: true }): string[] {
  return 'issues' in r ? r.issues.map((i) => i.code) : [];
}

/** A offers a0 + a1 for b0 (B must drop one at acceptance). */
function offer(): Trade {
  return ok(
    proposeTrade(
      settings,
      { tradeId: 't1', sides: [side('A', ['a0', 'a1']), side('B', ['b0'])], nextLockTime: null },
      ctx
    )
  );
}

describe('proposeTrade', () => {
  it('creates a proposed trade that expires in 48 hours, warning that the responder must drop', () => {
    const r = proposeTrade(
      settings,
      { tradeId: 't1', sides: [side('A', ['a0', 'a1']), side('B', ['b0'])], nextLockTime: null },
      ctx
    );
    expect(r.ok && r.warnings.map((w) => w.code)).toEqual(['RESPONDER_MUST_DROP']);
    const t = ok(r);
    expect(t).toMatchObject({
      status: 'proposed',
      proposedAt: NOW,
      expiresAt: '2026-10-03T12:00:00.000Z',
      counterOf: null,
      counterChain: [],
      history: [{ status: 'proposed', at: NOW, byTeamId: 'A' }]
    });
  });

  it('returns validation errors for an illegal offer', () => {
    const r = proposeTrade(
      settings,
      { tradeId: 't1', sides: [side('A', ['b0']), side('B')], nextLockTime: null },
      ctx
    );
    expect(codes(r)).toEqual(['PLAYER_NOT_ON_ROSTER']);
  });
});

describe('counterTrade', () => {
  it('closes the original as countered and opens a linked counter from the responder', () => {
    const t = offer();
    const r = counterTrade(
      settings,
      t,
      { tradeId: 't2', byTeamId: 'B', sides: [side('B', ['b0']), side('A', ['a0'])], nextLockTime: null },
      ctx
    );
    if (!r.ok) throw new Error('counter failed');
    expect(r.original.status).toBe('countered');
    expect(r.counter).toMatchObject({
      tradeId: 't2',
      status: 'proposed',
      counterOf: 't1',
      counterChain: ['t1']
    });

    const again = counterTrade(
      settings,
      r.counter,
      { tradeId: 't3', byTeamId: 'A', sides: [side('A', ['a2']), side('B', ['b0'])], nextLockTime: null },
      ctx
    );
    expect(again.ok && again.counter.counterChain).toEqual(['t1', 't2']);
  });

  it('only lets the responder counter, between the same teams, before expiry, with a valid offer', () => {
    const t = offer();
    const input = {
      tradeId: 't2',
      byTeamId: 'B',
      sides: [side('B', ['b0']), side('A', ['a0'])] as const,
      nextLockTime: null
    };
    expect(codes(counterTrade(settings, t, { ...input, byTeamId: 'A' }, ctx))).toEqual([
      'NOT_YOUR_TRADE_ACTION'
    ]);
    expect(
      codes(counterTrade(settings, t, { ...input, sides: [side('B', ['b0']), side('C')] }, ctx))
    ).toEqual(['COUNTER_TEAMS_MISMATCH']);
    expect(codes(counterTrade(settings, t, input, context(rosters, { now: t.expiresAt })))).toEqual([
      'TRADE_EXPIRED'
    ]);
    expect(
      codes(counterTrade(settings, t, { ...input, sides: [side('B', ['zz']), side('A')] }, ctx))
    ).toEqual(['PLAYER_NOT_ON_ROSTER']);
  });
});

describe('responses', () => {
  it('accepts with the responder drops that make its roster fit', () => {
    const t = offer();
    expect(codes(acceptTrade(settings, t, { byTeamId: 'B' }, ctx))).toEqual(['ROSTER_LIMIT_EXCEEDED']);
    const accepted = ok(acceptTrade(settings, t, { byTeamId: 'B', drops: ['b5'] }, ctx));
    expect(accepted.status).toBe('accepted');
    expect(accepted.sides[1].drops).toEqual(['b5']);
    expect(codes(acceptTrade(settings, t, { byTeamId: 'A' }, ctx))).toEqual(['NOT_YOUR_TRADE_ACTION']);
    expect(
      codes(
        acceptTrade(settings, t, { byTeamId: 'B', drops: ['b5'] }, context(rosters, { now: t.expiresAt }))
      )
    ).toEqual(['TRADE_EXPIRED']);
  });

  it('accepts without changing drops when none are given', () => {
    const t = ok(
      proposeTrade(
        settings,
        { tradeId: 'x', sides: [side('A', ['a0']), side('C', ['c0'])], nextLockTime: null },
        ctx
      )
    );
    expect(ok(acceptTrade(settings, t, { byTeamId: 'C' }, ctx)).sides[1].drops).toEqual([]);
  });

  it('rejects, withdraws and expires only from the right team or time', () => {
    const t = offer();
    expect(ok(rejectTrade(t, 'B', NOW)).status).toBe('rejected');
    expect(codes(rejectTrade(t, 'A', NOW))).toEqual(['NOT_YOUR_TRADE_ACTION']);
    expect(ok(withdrawTrade(t, 'A', NOW)).status).toBe('withdrawn');
    expect(codes(withdrawTrade(t, 'B', NOW))[0]).toBe('NOT_YOUR_TRADE_ACTION');
    expect(codes(expireTrade(t, NOW))).toEqual(['TRADE_NOT_EXPIRED']);
    const expired = ok(expireTrade(t, t.expiresAt));
    expect(expired.history.at(-1)).toEqual({ status: 'expired', at: t.expiresAt, byTeamId: null });
  });

  it('refuses any change to a closed trade, with a fix', () => {
    const rejected = ok(rejectTrade(offer(), 'B', NOW));
    const r = acceptTrade(settings, rejected, { byTeamId: 'B' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0]).toMatchObject({
        code: 'ILLEGAL_TRADE_TRANSITION',
        details: { from: 'rejected', to: 'accepted' }
      });
      expect(r.issues[0]?.fix).toBe('This trade is closed. Propose a new trade instead.');
    }
    const open = startReview(settings, offer(), NOW);
    expect(!open.ok && open.issues[0]?.fix).toMatch(/can only become: countered, accepted/);
  });
});

function acceptedTrade(): Trade {
  return ok(acceptTrade(settings, offer(), { byTeamId: 'B', drops: ['b5'] }, ctx));
}

describe('review and processing', () => {
  it('processes straight from accepted when the league has no review', () => {
    const s = withReview('none');
    expect(codes(startReview(s, acceptedTrade(), NOW))).toEqual(['REVIEW_NOT_REQUIRED']);
    const r = processTrade(s, acceptedTrade(), ctx);
    if (!r.ok) throw new Error('process failed');
    expect(r.trade.status).toBe('processed');
    expect(r.rosters.A?.map((p) => p.playerId)).toContain('b0');
    expect(r.rosters.B?.map((p) => p.playerId)).toEqual(expect.arrayContaining(['a0', 'a1']));
    expect(r.dropped.map((p) => p.playerId)).toEqual(['b5']);
  });

  it('runs a league vote: parties cannot vote, one vote per team, vetoed at the threshold', () => {
    expect(codes(processTrade(settings, acceptedTrade(), ctx))).toEqual(['REVIEW_REQUIRED']);
    let t = ok(startReview(settings, acceptedTrade(), NOW));
    expect(t).toMatchObject({ status: 'in_review', reviewEndsAt: '2026-10-03T12:00:00.000Z' });

    expect(codes(castVetoVote(settings, t, 'A', NOW))).toEqual(['PARTY_CANNOT_VOTE']);
    t = ok(castVetoVote(settings, t, 'C', NOW));
    expect(codes(castVetoVote(settings, t, 'C', NOW))).toEqual(['ALREADY_VOTED']);
    t = ok(castVetoVote(settings, t, 'D', NOW));
    expect(t.status).toBe('in_review');
    expect(codes(castVetoVote(settings, t, 'E', '2026-10-03T12:00:00Z'))).toEqual(['REVIEW_CLOSED']);
    // 8 teams → 3 veto votes needed.
    t = ok(castVetoVote(settings, t, 'E', NOW));
    expect(t.status).toBe('vetoed');
    expect(t.vetoVotes).toEqual(['C', 'D', 'E']);
    expect(codes(castVetoVote(settings, t, 'F', NOW))).toEqual(['TRADE_NOT_IN_REVIEW']);
  });

  it('processes a league-vote trade only after the review period', () => {
    const t = ok(startReview(settings, acceptedTrade(), NOW));
    expect(codes(processTrade(settings, t, ctx))).toEqual(['REVIEW_PENDING']);
    const r = processTrade(settings, t, context(rosters, { now: '2026-10-03T12:00:00Z' }));
    expect(r.ok && r.trade.status).toBe('processed');
  });

  it('uses the commissioner in commissioner mode', () => {
    const s = withReview('commissioner');
    const t = ok(startReview(s, acceptedTrade(), NOW));
    expect(codes(castVetoVote(s, t, 'C', NOW))).toEqual(['VOTING_NOT_ENABLED']);
    expect(codes(processTrade(s, t, ctx))).toEqual(['AWAITING_COMMISSIONER']);
    expect(codes(commissionerReview(settings, t, 'approve', NOW))).toEqual([
      'COMMISSIONER_REVIEW_NOT_ENABLED'
    ]);
    expect(codes(commissionerReview(withReview('none'), t, 'approve', NOW))).toEqual([
      'COMMISSIONER_REVIEW_NOT_ENABLED'
    ]);
    expect(codes(commissionerReview(s, acceptedTrade(), 'approve', NOW))).toEqual(['TRADE_NOT_IN_REVIEW']);
    expect(ok(commissionerReview(s, t, 'veto', NOW)).status).toBe('vetoed');
    const approved = ok(commissionerReview(s, t, 'approve', NOW));
    expect(approved.commissionerApproved).toBe(true);
    const r = processTrade(s, approved, ctx);
    expect(r.ok && r.trade.status).toBe('processed');
    expect(codes(castVetoVote(withReview('none'), t, 'C', NOW))).toEqual(['VOTING_NOT_ENABLED']);
  });

  it('re-validates at processing and can void a trade that no longer works', () => {
    const t = ok(startReview(settings, acceptedTrade(), NOW));
    const later = context(
      { ...rosters, A: squad('a', 14).filter((p) => p.playerId !== 'a0') },
      { now: t.reviewEndsAt ?? NOW }
    );
    const r = processTrade(settings, t, later);
    expect(codes(r)).toEqual(['PLAYER_NOT_ON_ROSTER']);
    if (!r.ok) {
      const voided = ok(voidTrade(t, r.issues[0] as NonNullable<(typeof r.issues)[0]>, NOW));
      expect(voided).toMatchObject({ status: 'vetoed', voidReason: { code: 'PLAYER_NOT_ON_ROSTER' } });
    }
    expect(
      codes(voidTrade(offer(), { code: 'X', severity: 'error', path: '', message: '', fix: '' }, NOW))
    ).toEqual(['ILLEGAL_TRADE_TRANSITION']);
    expect(codes(processTrade(settings, offer(), ctx))).toEqual(['ILLEGAL_TRADE_TRANSITION']);
  });

  it('exposes the transition table', () => {
    expect(canTransition('proposed', 'accepted')).toBe(true);
    expect(canTransition('accepted', 'proposed')).toBe(false);
  });
});
