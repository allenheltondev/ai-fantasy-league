import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PLAYER_STATUSES } from '../rules/positions.js';
import { ARCHETYPES, STRATEGY_ARCHETYPES } from './archetypes.js';
import {
  agentBehavior,
  lineupProjection,
  tradeAcceptEdge,
  tradeAppetite,
  tradeVetoRatio,
  tradeVetoVote,
  waiverMinGain
} from './behavior.js';
import { DIFFICULTIES, DIFFICULTY_TIERS } from './difficulty.js';
import { resolveAgentConfig } from './seat-config.js';

const resolved = (
  archetype: (typeof ARCHETYPES)[number],
  difficulty: (typeof DIFFICULTIES)[number] = 'pro'
) => resolveAgentConfig({ personalityId: 'stats-nerd', difficulty, archetype });

describe('archetype behavior levers', () => {
  it('gives every archetype a distinct behavior profile', () => {
    const profiles = ARCHETYPES.map((a) => {
      const b = agentBehavior(resolved(a));
      const weights = JSON.stringify(STRATEGY_ARCHETYPES[a].valuation.positionWeights ?? {});
      return JSON.stringify([b, weights, STRATEGY_ARCHETYPES[a].valuation.recencyBias]);
    });
    expect(new Set(profiles).size).toBe(ARCHETYPES.length);
  });

  it('makes a waiver hawk claim smaller upgrades than a trade-happy manager', () => {
    const hawk = agentBehavior(resolved('waiver_hawk'));
    const dealer = agentBehavior(resolved('trade_happy'));
    expect(hawk.waiverMinGain).toBeLessThan(dealer.waiverMinGain);
    expect(waiverMinGain(1)).toBe(0.1);
    expect(waiverMinGain(0)).toBe(1.5);
    expect(waiverMinGain(Number.NaN)).toBe(1.5);
  });

  it('makes a trade-happy manager propose more and demand less than an analytics manager', () => {
    const dealer = agentBehavior(resolved('trade_happy')).trade;
    const quant = agentBehavior(resolved('analytics_only')).trade;
    expect(dealer.proposalsPerWeek).toBeGreaterThan(quant.proposalsPerWeek);
    expect(dealer.acceptEdge).toBeLessThan(quant.acceptEdge);
  });

  it('sets the trade accept edge from the appetite', () => {
    expect(tradeAcceptEdge(0)).toBe(5);
    expect(tradeAcceptEdge(1)).toBe(-5);
    expect(tradeAcceptEdge(Number.NaN)).toBe(5);
    expect(tradeAppetite(resolved('trade_happy')).acceptEdge).toBe(-4);
  });

  it('takes the counter-offer budget from the difficulty', () => {
    for (const d of DIFFICULTIES) {
      expect(tradeAppetite(resolved('balanced', d)).maxCounters).toBe(
        DIFFICULTY_TIERS[d].levers.negotiationRounds
      );
    }
  });

  it('discounts injured starters less for a risk taker', () => {
    const cautious = resolved('win_now').valuation.riskTolerance ?? 0.5;
    const bold = resolved('gut_feel_homer').valuation.riskTolerance ?? 0.5;
    expect(lineupProjection(10, 'questionable', cautious)).toBeLessThan(9.5);
    expect(lineupProjection(10, 'questionable', bold)).toBeGreaterThan(9.5);
    expect(lineupProjection(10, 'active', cautious)).toBe(10);
  });

  it('puts the appetite in the strategy prompt', () => {
    expect(resolved('trade_happy').prompt.strategy).toMatch(/propose up to 4 trade\(s\) a week/);
    expect(resolved('win_now').prompt.strategy).toContain('bench questionable players');
    expect(resolved('gut_feel_homer').prompt.strategy).toContain('start a questionable player');
    expect(resolved('balanced').prompt.strategy).toContain('weigh injury designations');
  });

  it('keeps every lever in range and monotonic (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.constantFrom(...PLAYER_STATUSES),
        fc.double({ min: 0, max: 60, noNaN: true }),
        (a, b, status, points) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(waiverMinGain(hi)).toBeLessThanOrEqual(waiverMinGain(lo));
          expect(lineupProjection(points, status, hi)).toBeGreaterThanOrEqual(
            lineupProjection(points, status, lo)
          );
          expect(lineupProjection(points, status, lo)).toBeLessThanOrEqual(Math.round(points * 100) / 100);
          const levers = DIFFICULTY_TIERS.pro.levers;
          const t = tradeAppetite({ tradeFrequency: hi, levers });
          expect(t.proposalsPerWeek).toBeGreaterThanOrEqual(
            tradeAppetite({ tradeFrequency: lo, levers }).proposalsPerWeek
          );
          expect(t.proposalsPerWeek).toBeLessThanOrEqual(4);
        }
      )
    );
  });

  it('vetoes lopsided trades always, and near-lopsided ones by archetype', () => {
    expect(tradeVetoRatio(0)).toBe(0.7);
    expect(tradeVetoRatio(1)).toBe(1);
    const cautious = { tradeFrequency: 0.2 };
    const addict = { tradeFrequency: 0.9 };
    const near = { lineupGap: 24, valueGap: 5, lopsided: false };
    expect(tradeVetoVote(near, cautious)).toEqual({ veto: true, ratio: 0.76, severity: 0.8 });
    expect(tradeVetoVote(near, addict).veto).toBe(false);
    expect(tradeVetoVote({ lineupGap: 2, valueGap: -3, lopsided: false }, cautious).veto).toBe(false);
    expect(tradeVetoVote({ lineupGap: 40, valueGap: 0, lopsided: true }, addict).veto).toBe(true);
  });

  it('never lets a lopsided trade pass, whatever the archetype (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: -200, max: 200, noNaN: true }),
        fc.double({ min: -200, max: 200, noNaN: true }),
        (tradeFrequency, lineupGap, valueGap) => {
          const lopsided = Math.abs(lineupGap) >= 30 || Math.abs(valueGap) >= 30;
          const vote = tradeVetoVote({ lineupGap, valueGap, lopsided }, { tradeFrequency });
          if (lopsided) expect(vote.veto).toBe(true);
          // A more trade-happy agent never vetoes something a more cautious one lets pass.
          const stricter = tradeVetoVote({ lineupGap, valueGap, lopsided }, { tradeFrequency: 0 });
          if (vote.veto) expect(stricter.veto).toBe(true);
        }
      )
    );
  });
});
