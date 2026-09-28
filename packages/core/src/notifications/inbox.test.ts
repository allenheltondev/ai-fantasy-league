import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { joinNames, NOTIFICATION_EVENTS, notificationDrafts, type NotificationDraft } from './inbox.js';

const names: Record<string, string> = { a: 'Aces', b: 'Bombers' };
const ctx = { teamName: (id: string) => names[id] ?? null };
const p = (name: string) => ({ id: name.toLowerCase(), name, team: 'SF', position: 'RB' });

const trade = (overrides: Record<string, unknown> = {}) => ({
  leagueId: 'lg',
  tradeId: 't1',
  fromTeamId: 'a',
  toTeamId: 'b',
  fromPlayers: [p('Ace')],
  toPlayers: [p('Bee'), p('Cee')],
  review: 'league_vote',
  ...overrides
});

const summary = (drafts: NotificationDraft[]) => drafts.map((d) => [d.teamId, d.kind, d.title, d.body]);

describe('notificationDrafts: trades', () => {
  it('tells only the team that must answer about an offer or a counter', () => {
    expect(summary(notificationDrafts('Trade Proposed', trade(), ctx))).toEqual([
      ['b', 'trade_offer', 'Trade offer from Aces', "You'd get Ace for Bee and Cee."]
    ]);
    expect(notificationDrafts('Trade Proposed', trade(), ctx)[0]?.target).toEqual({
      section: 'trades',
      tradeId: 't1'
    });
    expect(
      summary(notificationDrafts('Trade Countered', trade({ fromTeamId: 'b', toTeamId: 'a' }), ctx))
    ).toEqual([['a', 'trade_countered', 'Bombers countered your offer', "You'd get Ace for Bee and Cee."]]);
  });

  it('tells the proposer about an answer, and the answerer about a withdrawal', () => {
    expect(summary(notificationDrafts('Trade Accepted', trade(), ctx))).toEqual([
      [
        'a',
        'trade_accepted',
        'Bombers accepted your trade',
        'You get Bee and Cee for Ace. It goes to review before the players move.'
      ]
    ]);
    expect(notificationDrafts('Trade Accepted', trade({ review: 'none' }), ctx)[0]?.body).toContain(
      'It goes through now.'
    );
    expect(summary(notificationDrafts('Trade Rejected', trade(), ctx))).toEqual([
      ['a', 'trade_rejected', 'Bombers rejected your offer', 'You offered Ace for Bee and Cee.']
    ]);
    expect(summary(notificationDrafts('Trade Withdrawn', trade(), ctx))).toEqual([
      ['b', 'trade_withdrawn', 'Aces withdrew its offer', 'It had offered you Ace for Bee and Cee.']
    ]);
  });

  it('tells both teams about expiry, vetoes, cancellations, and completion', () => {
    expect(summary(notificationDrafts('Trade Expired', trade(), ctx))).toEqual([
      [
        'a',
        'trade_expired',
        'Your trade with Bombers expired',
        'Bee and Cee for Ace. Nobody answered it in time.'
      ],
      [
        'b',
        'trade_expired',
        'Your trade with Aces expired',
        'Ace for Bee and Cee. Nobody answered it in time.'
      ]
    ]);
    expect(
      notificationDrafts('Trade Expired', trade({ voided: true, reason: 'Bee was dropped.' }), ctx)[0]?.body
    ).toBe('Bee and Cee for Ace. Bee was dropped.');
    expect(notificationDrafts('Trade Expired', trade({ voided: true }), ctx)[0]?.body).toContain(
      'A player in it changed rosters.'
    );
    expect(summary(notificationDrafts('Trade Vetoed', trade(), ctx))[1]).toEqual([
      'b',
      'trade_vetoed',
      'Your trade with Aces was vetoed',
      'No players moved: you keep Bee and Cee.'
    ]);
    expect(notificationDrafts('Trade Vetoed', trade({ voided: true }), ctx)[0]).toMatchObject({
      title: 'Your trade with Bombers was cancelled',
      body: 'It no longer works with the current rosters. No players moved.'
    });
    const done = notificationDrafts('Trade Processed', trade({ toPlayers: [] }), ctx);
    expect(summary(done)).toEqual([
      ['a', 'trade_processed', 'Trade complete with Bombers', 'Ace left your roster.'],
      ['b', 'trade_processed', 'Trade complete with Aces', 'Ace joined your roster.']
    ]);
    expect(done[0]?.target).toEqual({ section: 'roster', tradeId: 't1' });
  });

  it('names an unknown team generically and skips malformed or unknown trade events', () => {
    expect(notificationDrafts('Trade Proposed', trade({ fromTeamId: 'z' }), ctx)[0]?.title).toBe(
      'Trade offer from The other team'
    );
    expect(notificationDrafts('Trade Proposed', trade({ tradeId: 7 }), ctx)).toEqual([]);
    expect(notificationDrafts('Trade Offer Deadline', trade(), ctx)).toEqual([]);
    expect(notificationDrafts('Scores Updated', {}, ctx)).toEqual([]);
  });
});

describe('notificationDrafts: waivers and the draft', () => {
  it('sums each team’s won and lost claims, with the reason', () => {
    const drafts = notificationDrafts(
      'Waivers Processed',
      {
        awarded: [
          { teamId: 'a', player: p('Ace'), cost: 7 },
          { teamId: 'a', playerId: 'bee', player: null, cost: 0 },
          { teamId: 'b', player: 'Cee' },
          { player: p('Nobody') }
        ],
        lost: [
          { teamId: 'b', player: p('Dee'), reason: 'Aces bid more.' },
          { teamId: 'c', player: p('Eee'), reason: 'Roster full.' },
          { teamId: 'c', playerId: 'fff', player: null },
          { reason: 'no team' }
        ]
      },
      ctx
    );
    expect(summary(drafts)).toEqual([
      ['a', 'waiver_won', 'You won 2 waiver claims', 'Added to your roster: Ace ($7) and bee.'],
      ['b', 'waiver_won', 'Waiver claim won', 'Added to your roster: Cee.'],
      ['b', 'waiver_lost', 'Waiver claim lost: Dee', 'Aces bid more.'],
      ['c', 'waiver_lost', '2 waiver claims lost', 'Eee: Roster full. fff: The claim did not go through.']
    ]);
    expect(new Set(drafts.map((d) => d.key))).toEqual(new Set(['won', 'lost']));
    expect(drafts.every((d) => d.target.section === 'roster')).toBe(true);
    expect(notificationDrafts('Waivers Processed', { awarded: 'x' }, ctx)).toEqual([]);
  });

  it('tells the team on the clock', () => {
    expect(notificationDrafts('Draft Turn Started', { teamId: 'a', pick: 13, round: 2 }, ctx)).toEqual([
      {
        teamId: 'a',
        key: '',
        kind: 'draft_on_clock',
        title: "You're on the clock",
        body: 'Pick 13 (round 2) is yours. Make it in the draft room.',
        target: { section: 'draft', tradeId: null }
      }
    ]);
    expect(notificationDrafts('Draft Turn Started', { teamId: 'a', pick: 1 }, ctx)[0]?.body).toBe(
      'Pick 1 is yours. Make it in the draft room.'
    );
    expect(notificationDrafts('Draft Turn Started', { teamId: 'a' }, ctx)[0]?.body).toBe(
      'Make your pick in the draft room.'
    );
    expect(notificationDrafts('Draft Turn Started', {}, ctx)).toEqual([]);
  });
});

describe('notificationDrafts: properties', () => {
  const team = fc.constantFrom('a', 'b', 'c', 'd');
  const player = fc.record({ name: fc.string({ minLength: 1, maxLength: 8 }) });

  it('never tells the acting team, never repeats a key per team, and only lists notifying events', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NOTIFICATION_EVENTS, 'Trade Offer Deadline', 'Chat Mention'),
        team,
        team,
        fc.array(player, { maxLength: 3 }),
        fc.array(fc.record({ teamId: team, player, cost: fc.nat(50) }), { maxLength: 6 }),
        fc.array(fc.record({ teamId: team, player, reason: fc.string() }), { maxLength: 6 }),
        (type, from, to, players, awarded, lost) => {
          const detail = {
            tradeId: 't',
            fromTeamId: from,
            toTeamId: to,
            fromPlayers: players,
            toPlayers: players,
            teamId: from,
            pick: 1,
            awarded,
            lost
          };
          const drafts = notificationDrafts(type, detail, ctx);
          if (!(NOTIFICATION_EVENTS as readonly string[]).includes(type)) expect(drafts).toEqual([]);
          const actor: Record<string, string> = {
            'Trade Proposed': from,
            'Trade Accepted': to,
            'Trade Rejected': to,
            'Trade Withdrawn': from
          };
          if (from !== to && actor[type] !== undefined) {
            expect(drafts.every((d) => d.teamId !== actor[type])).toBe(true);
          }
          const keys = drafts.map((d) => `${d.teamId}#${d.key}`);
          if (from !== to) expect(new Set(keys).size).toBe(keys.length);
          for (const d of drafts) {
            expect(d.title.length).toBeGreaterThan(0);
            expect(d.body.length).toBeGreaterThan(0);
          }
        }
      )
    );
  });
});

describe('joinNames', () => {
  it('reads like a sentence', () => {
    expect(joinNames([])).toBe('nothing');
    expect(joinNames([], 'no one')).toBe('no one');
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
  });
});
