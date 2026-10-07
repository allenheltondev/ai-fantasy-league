import { describe, expect, it } from 'vitest';
import { checkPost, supportedTradeClaims, tradeStatusClaims } from './post-check.js';

describe('tradeStatusClaims', () => {
  it('reads the claim kinds #247 judges, and not a question about a deal', () => {
    expect(tradeStatusClaims('Cooper Kupp is a solid pickup. Offer sent.')).toEqual(['sent']);
    expect(tradeStatusClaims('Done deal, and you accepted my offer.')).toEqual(['completed', 'accepted']);
    expect(tradeStatusClaims('What would it take to get a deal done?')).toEqual([]);
  });
});

describe('checkPost: action claims (#264)', () => {
  it('cuts the sentence claiming an offer the turn did not send, and keeps the rest as written', () => {
    expect(checkPost({ message: 'Cooper Kupp is a solid pickup. Offer sent.', supported: [] })).toEqual({
      ok: true,
      message: 'Cooper Kupp is a solid pickup.',
      cut: ['sent']
    });
    expect(
      checkPost({
        message: 'Big week ahead!  The trade went through, by the way. Wish me luck',
        supported: []
      })
    ).toEqual({ ok: true, message: 'Big week ahead! Wish me luck', cut: ['completed'] });
  });

  it('withholds a post that is nothing but an unsupported claim (a tag alone says nothing)', () => {
    expect(checkPost({ message: 'Offer sent.', supported: [] })).toEqual({
      ok: false,
      reason: 'unsupported_claim'
    });
    expect(checkPost({ message: '@Team 3 offer is on its way!', supported: [] })).toMatchObject({
      ok: false
    });
    expect(checkPost({ message: '   ', supported: [] })).toEqual({ ok: false, reason: 'empty' });
  });

  it('lets a supported claim through unchanged', () => {
    expect(checkPost({ message: 'Offer sent. Take a look.', supported: ['sent'] })).toEqual({
      ok: true,
      message: 'Offer sent. Take a look.',
      cut: []
    });
  });
});

describe('supportedTradeClaims', () => {
  const trades = [
    { teamId: 'team-1', outgoing: true, status: 'processed' },
    { teamId: 'team-3', outgoing: false, status: 'rejected' },
    { teamId: 'team-1', outgoing: false, status: 'rejected' }
  ];

  it('judges the latest trade with the counterpart, like the claim checks', () => {
    expect(supportedTradeClaims({ counterpart: 'team-1', offeredTo: [], trades })).toEqual([
      'completed',
      'sent',
      'accepted'
    ]);
    // Their offer, turned down: nothing of the speaker's own was sent, accepted, or done.
    expect(supportedTradeClaims({ counterpart: 'team-3', offeredTo: [], trades })).toEqual([]);
    expect(supportedTradeClaims({ counterpart: 'team-4', offeredTo: [], trades })).toEqual([]);
  });

  it('counts an offer this turn sent, which is then the latest trade with that team', () => {
    expect(supportedTradeClaims({ counterpart: 'team-1', offeredTo: ['team-1'], trades })).toEqual(['sent']);
    expect(supportedTradeClaims({ counterpart: null, offeredTo: ['team-4'], trades })).toEqual(['sent']);
    expect(supportedTradeClaims({ counterpart: null, offeredTo: [], trades })).toEqual([]);
  });
});
