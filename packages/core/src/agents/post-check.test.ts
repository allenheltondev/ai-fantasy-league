import { describe, expect, it } from 'vitest';
import { checkPost, privateTradeTerms, supportedTradeClaims, tradeStatusClaims } from './post-check.js';

describe('tradeStatusClaims', () => {
  it('reads the claim kinds #247 judges, and not a question about a deal', () => {
    expect(tradeStatusClaims('Cooper Kupp is a solid pickup. Offer sent.')).toEqual(['sent']);
    expect(tradeStatusClaims('Done deal, and you accepted my offer.')).toEqual(['completed', 'accepted']);
    expect(tradeStatusClaims('What would it take to get a deal done?')).toEqual([]);
  });
});

describe('checkPost: action claims (#264)', () => {
  it('cuts the sentence claiming an offer the turn did not send, and keeps the rest as written', () => {
    expect(
      checkPost({ message: 'Cooper Kupp is a solid pickup. Offer sent.', supported: [], public: false })
    ).toEqual({
      ok: true,
      message: 'Cooper Kupp is a solid pickup.',
      cut: ['sent']
    });
    expect(
      checkPost({
        message: 'Big week ahead!  The trade went through, by the way. Wish me luck',
        supported: [],
        public: true
      })
    ).toEqual({ ok: true, message: 'Big week ahead! Wish me luck', cut: ['completed'] });
  });

  it('withholds a post that is nothing but an unsupported claim (a tag alone says nothing)', () => {
    expect(checkPost({ message: 'Offer sent.', supported: [], public: false })).toEqual({
      ok: false,
      reason: 'unsupported_claim'
    });
    expect(
      checkPost({ message: '@Team 3 offer is on its way!', supported: [], public: false })
    ).toMatchObject({
      ok: false
    });
    expect(checkPost({ message: '   ', supported: [], public: false })).toEqual({
      ok: false,
      reason: 'empty'
    });
  });

  it('lets a supported claim through unchanged', () => {
    expect(checkPost({ message: 'Offer sent. Take a look.', supported: ['sent'], public: false })).toEqual({
      ok: true,
      message: 'Offer sent. Take a look.',
      cut: []
    });
  });
});

describe('checkPost: private detail in a public room (#263)', () => {
  const pub = (message: string, over: Partial<Parameters<typeof checkPost>[0]> = {}) =>
    checkPost({ message, supported: [], public: true, ...over });

  it('withholds talk of an offer that is not public, and keeps it fine in the DM', () => {
    const leak = '@Team 3 remember when I turned down your trade offer on 2025-09-09?';
    expect(pub(leak)).toEqual({ ok: false, reason: 'private_offer' });
    for (const said of [
      'Your offer got rejected, like the last one.',
      'They passed on my offer, their loss.',
      'I offered you a fair deal last week.',
      'Our trade talks went nowhere.',
      'Sent you an offer, check it.'
    ])
      expect(pub(said, { supported: ['sent'] })).toMatchObject({ ok: false });
    expect(checkPost({ message: leak, supported: [], public: false })).toMatchObject({ ok: true });
  });

  it('lets public trade talk and plain trash talk through', () => {
    for (const said of [
      'Glad you accepted my offer, the trade went through!',
      'Per my last trade offer, you are leaving points on the table.',
      'What would it take to get a deal done?',
      'This one is mine. Your RB is out.'
    ])
      expect(pub(said, { supported: ['accepted', 'completed'] })).toMatchObject({ ok: true });
  });

  it('withholds a player in a private move, unless the post’s own facts name him', () => {
    const terms = ['Waiver Target', 'Their Star'];
    expect(pub('Waiver Target is about to be mine.', { privateTerms: terms })).toEqual({
      ok: false,
      reason: 'private_detail'
    });
    expect(
      pub('Their Star is out this week, ha.', {
        privateTerms: terms,
        facts: ['Their starters who will not play: Their Star (Out).']
      })
    ).toMatchObject({ ok: true });
    expect(
      checkPost({ message: 'Waiver Target?', supported: [], public: false, privateTerms: terms })
    ).toMatchObject({
      ok: true
    });
  });
});

describe('privateTradeTerms', () => {
  it('names the players in open offers, once each, and lets closed ones go', () => {
    expect(
      privateTradeTerms([
        { teamId: 'team-1', outgoing: true, status: 'countered', players: ['A', 'B'] },
        { teamId: 'team-3', outgoing: false, status: 'proposed', players: ['B', 'C'] },
        { teamId: 'team-4', outgoing: true, status: 'processed', players: ['D'] },
        { teamId: 'team-5', outgoing: true, status: 'rejected', players: ['E'] },
        { teamId: 'team-6', outgoing: false, status: 'withdrawn', players: ['F'] },
        { teamId: 'team-4', outgoing: true, status: 'expired' }
      ])
    ).toEqual(['A', 'B', 'C']);
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

  it('lets only the team that made the offer say it was accepted', () => {
    // Their offer, which the agent accepted: "you accepted my offer" would be false.
    const theirs = [{ teamId: 'team-5', outgoing: false, status: 'processed' }];
    expect(supportedTradeClaims({ counterpart: 'team-5', offeredTo: [], trades: theirs })).toEqual([
      'completed'
    ]);
    const mine = [{ teamId: 'team-5', outgoing: true, status: 'in_review' }];
    expect(supportedTradeClaims({ counterpart: 'team-5', offeredTo: [], trades: mine })).toEqual([
      'sent',
      'accepted'
    ]);
  });

  it('counts an offer this turn sent, which is then the latest trade with that team', () => {
    expect(supportedTradeClaims({ counterpart: 'team-1', offeredTo: ['team-1'], trades })).toEqual(['sent']);
    expect(supportedTradeClaims({ counterpart: null, offeredTo: ['team-4'], trades })).toEqual(['sent']);
    expect(supportedTradeClaims({ counterpart: null, offeredTo: [], trades })).toEqual([]);
  });
});
