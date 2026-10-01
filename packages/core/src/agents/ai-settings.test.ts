import { describe, expect, it } from 'vitest';
import {
  AiSettingsSchema,
  DIFFICULTY_WEEKLY_BUDGET_USD,
  MODEL_CATALOG,
  REGIONAL_PREMIUM,
  agentAllowanceUsd,
  billedPrice,
  defaultAiSettings,
  leagueAiBudget,
  leagueWeeklyBudgetUsd,
  modelChain,
  PERSONALITY_IDS,
  resolveAgentConfig,
  type AgentSeatConfig
} from '../index.js';
import { LeagueSettingsSchema, yahooDefaultSettings } from '../rules/settings.js';

const seat: AgentSeatConfig = { personalityId: PERSONALITY_IDS[0], difficulty: 'pro', archetype: 'balanced' };

describe('league AI settings', () => {
  it('defaults to an automatic budget, no overage, and the tier models', () => {
    expect(AiSettingsSchema.parse({})).toEqual(defaultAiSettings());
    expect(defaultAiSettings().models.rookie).toEqual({ decision: null, chat: null });
  });

  it('reads a league stored before AI settings existed as the default', () => {
    const { ai: _ai, ...stored } = yahooDefaultSettings();
    expect(LeagueSettingsSchema.parse(stored).ai).toEqual(defaultAiSettings());
  });

  it('rejects unknown models and out-of-range amounts', () => {
    expect(AiSettingsSchema.safeParse({ models: { rookie: { decision: 'gpt-9' } } }).success).toBe(false);
    expect(AiSettingsSchema.safeParse({ weeklyBudgetUsd: -1 }).success).toBe(false);
    expect(AiSettingsSchema.safeParse({ overageUsd: 1000 }).success).toBe(false);
  });
});

describe('leagueAiBudget', () => {
  const mix = ['rookie', 'pro', 'hall_of_famer'] as const;

  it('uses the automatic ceiling when the commissioner sets none', () => {
    expect(leagueAiBudget(defaultAiSettings(), mix)).toEqual({
      ceilingUsd: leagueWeeklyBudgetUsd(mix),
      automatic: true,
      overageUsd: 0,
      limitUsd: leagueWeeklyBudgetUsd(mix)
    });
  });

  it("uses the commissioner's budget and adds the overage to the limit", () => {
    expect(leagueAiBudget({ weeklyBudgetUsd: 10, overageUsd: 2.5 }, mix)).toEqual({
      ceilingUsd: 10,
      automatic: false,
      overageUsd: 2.5,
      limitUsd: 12.5
    });
  });

  it('allows a zero budget (no model calls)', () => {
    expect(leagueAiBudget({ weeklyBudgetUsd: 0, overageUsd: 0 }, mix).limitUsd).toBe(0);
  });
});

describe('agentAllowanceUsd', () => {
  it('splits a ceiling in proportion to the difficulties', () => {
    const mix = ['rookie', 'hall_of_famer'] as const;
    const total = DIFFICULTY_WEEKLY_BUDGET_USD.rookie + DIFFICULTY_WEEKLY_BUDGET_USD.hall_of_famer;
    expect(agentAllowanceUsd('hall_of_famer', mix, 10)).toBe(
      Math.round((10 * DIFFICULTY_WEEKLY_BUDGET_USD.hall_of_famer * 100) / total) / 100
    );
    expect(agentAllowanceUsd('rookie', [], 10)).toBe(0);
  });
});

describe('models by difficulty', () => {
  it("puts the seat's override first, then the league's choice, then the tier", () => {
    expect(modelChain('micro', 'claude-opus-5', 'nova-pro')).toEqual([
      'claude-opus-5',
      'nova-pro',
      'nova-micro',
      'nova-lite'
    ]);
    expect(modelChain('micro', undefined, 'nova-micro')).toEqual(['nova-micro', 'nova-lite']);
  });

  it("resolves a seat with the league's models for its difficulty", () => {
    const ai = defaultAiSettings();
    ai.models.pro = { decision: 'nova-pro', chat: 'nova-micro' };
    const config = resolveAgentConfig(seat, { ai });
    expect(config.models.decision[0]).toBe('nova-pro');
    expect(config.models.chat[0]).toBe('nova-micro');
    // Another difficulty keeps its tier defaults.
    const rookie = resolveAgentConfig({ ...seat, difficulty: 'rookie' }, { ai });
    expect(rookie.models.decision).toEqual(
      resolveAgentConfig({ ...seat, difficulty: 'rookie' }).models.decision
    );
  });

  it("keeps the seat's own override ahead of the league's choice", () => {
    const ai = defaultAiSettings();
    ai.models.pro = { decision: 'nova-pro', chat: null };
    const config = resolveAgentConfig({ ...seat, advanced: { modelOverride: 'claude-haiku-4-5' } }, { ai });
    expect(config.models.decision.slice(0, 2)).toEqual(['claude-haiku-4-5', 'nova-pro']);
  });
});

describe('billed prices', () => {
  it('adds the regional premium only to models Bedrock bills that way', () => {
    for (const m of MODEL_CATALOG) {
      const factor = 'regionalPremium' in m && m.regionalPremium ? REGIONAL_PREMIUM : 1;
      expect(billedPrice(m).inputPerMTok).toBeCloseTo(m.price.inputPerMTok * factor, 10);
    }
    const premium = MODEL_CATALOG.filter((m) => 'regionalPremium' in m).map((m) => m.key);
    expect(premium).toEqual(['nova-2-lite', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5']);
  });
});
