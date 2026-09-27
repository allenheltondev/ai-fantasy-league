import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LeagueSettings } from '../rules/settings.js';
import { context, settings, squad } from './fixtures.test-helpers.js';
import {
  TRADE_TRANSITIONS,
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
  withdrawTrade
} from './machine.js';
import { TRADE_STATUSES, type Trade } from './trade.js';

const rosters = {
  A: squad('a', 10),
  B: squad('b', 10, 'BUF'),
  C: squad('c', 10, 'MIA'),
  D: squad('d', 10, 'MIA')
};
const TEAMS = ['A', 'B', 'C', 'D'];
const ACTIONS = [
  'counter',
  'accept',
  'reject',
  'withdraw',
  'expire',
  'review',
  'vote',
  'approve',
  'veto',
  'process',
  'void'
] as const;
type Action = (typeof ACTIONS)[number];

const step = fc.record({
  action: fc.constantFrom(...ACTIONS),
  team: fc.constantFrom(...TEAMS),
  hours: fc.integer({ min: 0, max: 80 })
});

type Outcome = { ok: true; trade: Trade } | { ok: false };

function run(s: LeagueSettings, trade: Trade, action: Action, team: string, now: string): Outcome {
  const ctx = context(rosters, { now });
  switch (action) {
    case 'counter': {
      const r = counterTrade(
        s,
        trade,
        {
          tradeId: `${trade.tradeId}c`,
          byTeamId: team,
          sides: [
            { teamId: team, sends: [`${team.toLowerCase()}1`], drops: [] },
            { teamId: trade.sides[0].teamId, sends: [], drops: [] }
          ],
          nextLockTime: null
        },
        ctx
      );
      return r.ok ? { ok: true, trade: r.original } : r;
    }
    case 'accept':
      return acceptTrade(s, trade, { byTeamId: team }, ctx);
    case 'reject':
      return rejectTrade(trade, team, now);
    case 'withdraw':
      return withdrawTrade(trade, team, now);
    case 'expire':
      return expireTrade(trade, now);
    case 'review':
      return startReview(s, trade, now);
    case 'vote':
      return castVetoVote(s, trade, team, now);
    case 'approve':
      return commissionerReview(s, trade, 'approve', now);
    case 'veto':
      return commissionerReview(s, trade, 'veto', now);
    case 'process':
      return processTrade(s, trade, ctx);
    case 'void':
      return voidTrade(trade, { code: 'X', severity: 'error', path: '', message: '', fix: 'n/a' }, now);
  }
}

describe('trade state machine properties', () => {
  it('only ever makes legal transitions, and closed trades never change', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('league_vote' as const, 'commissioner' as const, 'none' as const),
        fc.array(step, { maxLength: 12 }),
        (review, steps) => {
          const s: LeagueSettings = { ...settings, trades: { ...settings.trades, review } };
          const start = proposeTrade(
            s,
            {
              tradeId: 't',
              sides: [
                { teamId: 'A', sends: ['a0'], drops: [] },
                { teamId: 'B', sends: ['b0'], drops: [] }
              ],
              nextLockTime: null
            },
            context(rosters)
          );
          if (!start.ok) throw new Error('setup failed');
          let trade = start.trade;
          let ms = new Date('2026-10-01T12:00:00Z').getTime();
          for (const { action, team, hours } of steps) {
            ms += hours * 3_600_000;
            const before = trade.status;
            const r = run(s, trade, action, team, new Date(ms).toISOString());
            if (TRADE_TRANSITIONS[before].length === 0) expect(r.ok).toBe(false);
            if (!r.ok) continue;
            if (r.trade.status !== before) expect(canTransition(before, r.trade.status)).toBe(true);
            expect(TRADE_STATUSES).toContain(r.trade.status);
            trade = r.trade;
          }
        }
      )
    );
  });
});
