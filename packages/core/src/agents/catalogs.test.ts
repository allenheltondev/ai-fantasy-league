import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ARCHETYPES,
  AgentSeatConfigSchema,
  CUSTOM_FLAVOR_MAX,
  DIFFICULTY_WEEKLY_BUDGET_USD,
  LEAGUE_WEEKLY_BUDGET_CAP_USD,
  LEAGUE_WEEKLY_BUDGET_FLOOR_USD,
  leagueWeeklyBudgetUsd,
  DIFFICULTIES,
  DIFFICULTY_TIERS,
  MAX_RANDOM_SEATS,
  MODEL_CATALOG,
  MODEL_KEYS,
  MODEL_TIERS,
  MODEL_TIER_MODELS,
  PERSONALITIES,
  STRATEGY_ARCHETYPES,
  applyValuationNoise,
  catalogBedrockIds,
  estimateCostUsd,
  getModel,
  isModelKey,
  modelByBedrockId,
  modelChain,
  randomizeAgentSeats,
  resolveAgentConfig,
  valuationNoiseMultiplier,
  type AgentSeatConfig,
  type ModelKey
} from './index.js';

describe('model catalog', () => {
  it('has unique keys and Bedrock ids, all verified against Bedrock with estimated prices', () => {
    expect(new Set(MODEL_KEYS).size).toBe(MODEL_CATALOG.length);
    expect(new Set(catalogBedrockIds()).size).toBe(MODEL_CATALOG.length);
    for (const m of MODEL_CATALOG) {
      expect(m.verified).toBe(true);
      expect(m.priceIsEstimate).toBe(true);
      expect(m.price.inputPerMTok).toBeGreaterThan(0);
      expect(m.price.outputPerMTok).toBeGreaterThanOrEqual(m.price.inputPerMTok);
      if (m.inferenceProfile) {
        expect(m.bedrockId.startsWith('us.')).toBe(true);
        expect(m.foundationModelId).toBe(m.bedrockId.slice(3));
      } else {
        expect(m.foundationModelId).toBe(m.bedrockId);
      }
    }
  });

  it('covers every candidate family', () => {
    expect(new Set(MODEL_CATALOG.map((m) => m.provider))).toEqual(
      new Set(['amazon', 'moonshot', 'anthropic'])
    );
  });

  it('maps every tier to catalog models with distinct fallbacks', () => {
    for (const tier of MODEL_TIERS) {
      const chain = MODEL_TIER_MODELS[tier];
      expect(chain.length).toBeGreaterThanOrEqual(2);
      expect(new Set(chain).size).toBe(chain.length);
      for (const key of chain) expect(isModelKey(key)).toBe(true);
    }
  });

  it('builds model chains with an override first and no duplicates', () => {
    expect(modelChain('frontier')).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(modelChain('frontier', 'claude-sonnet-5')).toEqual(['claude-sonnet-5', 'claude-opus-5']);
    expect(modelChain('micro', 'kimi-k2-thinking')).toEqual(['kimi-k2-thinking', 'nova-micro', 'nova-lite']);
  });

  it('looks models up by key and Bedrock id', () => {
    expect(getModel('nova-pro').bedrockId).toBe('us.amazon.nova-pro-v1:0');
    expect(() => getModel('nope' as ModelKey)).toThrow(/Unknown model/);
    expect(modelByBedrockId('us.amazon.nova-lite-v1:0')?.key).toBe('nova-lite');
    expect(modelByBedrockId('missing')).toBeNull();
    expect(isModelKey('gpt')).toBe(false);
  });

  it('estimates cost from the price table, with the regional premium Bedrock bills on `us.` profiles', () => {
    // Opus 5 lists at $5/$25; its `us.` profile bills 10% more.
    expect(estimateCostUsd('claude-opus-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(33);
    // Nova (1) profiles bill at list price.
    expect(estimateCostUsd('us.amazon.nova-micro-v1:0', { inputTokens: 1000, outputTokens: 1000 })).toBe(
      0.000175
    );
    expect(estimateCostUsd('unknown', { inputTokens: 5, outputTokens: 5 })).toBe(0);
  });
});

describe('difficulty tiers', () => {
  it('gives every tier a catalog model tier and sane levers, strictly stronger up the ladder', () => {
    let previous: (typeof DIFFICULTY_TIERS)[keyof typeof DIFFICULTY_TIERS] | null = null;
    for (const id of DIFFICULTIES) {
      const tier = DIFFICULTY_TIERS[id];
      expect(tier.id).toBe(id);
      expect(MODEL_TIERS).toContain(tier.levers.decisionModelTier);
      expect(MODEL_TIERS).toContain(tier.levers.chatModelTier);
      expect(tier.levers.research.projections).toBe(true);
      if (previous !== null) {
        expect(tier.levers.maxToolSteps).toBeGreaterThan(previous.levers.maxToolSteps);
        expect(tier.levers.valuationNoise).toBeLessThan(previous.levers.valuationNoise);
        expect(tier.levers.cooldownMinutes).toBeLessThan(previous.levers.cooldownMinutes);
        expect(tier.levers.negotiationRounds).toBeGreaterThanOrEqual(previous.levers.negotiationRounds);
        // Better managers are sharper and quicker (#189).
        expect(tier.levers.responseDelay.multiplier).toBeLessThan(previous.levers.responseDelay.multiplier);
        expect(tier.levers.responseDelay.immediateChance).toBeGreaterThan(
          previous.levers.responseDelay.immediateChance
        );
        expect(MODEL_TIERS.indexOf(tier.levers.decisionModelTier)).toBeGreaterThan(
          MODEL_TIERS.indexOf(previous.levers.decisionModelTier)
        );
      }
      previous = tier;
    }
  });

  it('applies deterministic, bounded valuation noise', () => {
    expect(valuationNoiseMultiplier(0, 's', 'p')).toBe(1);
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 0.5, noNaN: true }),
        fc.string(),
        fc.string(),
        (noise, seed, id) => {
          const m = valuationNoiseMultiplier(noise, seed, id);
          expect(m).toBeGreaterThanOrEqual(1 - noise);
          expect(m).toBeLessThanOrEqual(1 + noise);
          expect(valuationNoiseMultiplier(noise, seed, id)).toBe(m);
        }
      )
    );
    expect(applyValuationNoise(100, 0, 'x', 'y')).toBe(100);
    expect(applyValuationNoise(100, 0.25, 'seed', 'p1')).not.toBe(
      applyValuationNoise(100, 0.25, 'seed', 'p2')
    );
  });
});

describe('strategy archetypes', () => {
  it('includes the seven SPEC archetypes with bounded knobs and guidance', () => {
    for (const id of [
      'zero_rb',
      'contrarian',
      'win_now',
      'analytics_only',
      'gut_feel_homer',
      'trade_happy',
      'waiver_hawk'
    ]) {
      expect(ARCHETYPES).toContain(id);
    }
    for (const id of ARCHETYPES) {
      const a = STRATEGY_ARCHETYPES[id];
      expect(a.id).toBe(id);
      for (const v of [
        a.valuation.riskTolerance,
        a.valuation.recencyBias,
        a.waiverAggressiveness,
        a.tradeFrequency
      ]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(a.promptGuidance.length).toBeGreaterThan(40);
    }
    expect(STRATEGY_ARCHETYPES.zero_rb.valuation.positionWeights?.RB).toBeLessThan(1);
  });
});

describe('personality presets', () => {
  it('has at least 16 complete, distinct presets', () => {
    expect(PERSONALITIES.length).toBeGreaterThanOrEqual(16);
    for (const field of ['id', 'displayName', 'teamNameSuggestion', 'avatarSeed'] as const) {
      expect(new Set(PERSONALITIES.map((p) => p[field])).size).toBe(PERSONALITIES.length);
    }
    for (const p of PERSONALITIES) {
      expect(p.id).toMatch(/^[a-z][a-z0-9-]+$/);
      for (const text of [
        p.displayName,
        p.teamNameSuggestion,
        p.bio,
        p.voice,
        p.trashTalkStyle,
        p.avatarSeed
      ]) {
        expect(text.trim().length).toBeGreaterThan(0);
      }
      expect(p.sampleLines).toHaveLength(3);
      for (const line of p.sampleLines) expect(line.trim().length).toBeGreaterThan(5);
    }
  });
});

describe('agent seat config', () => {
  const base: AgentSeatConfig = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'zero_rb' };

  it('resolves models, levers, valuation, and prompt pieces', () => {
    const resolved = resolveAgentConfig(base);
    expect(resolved.models.decision).toEqual(['kimi-k2-thinking', 'nova-pro', 'claude-haiku-4-5']);
    expect(resolved.models.chat).toEqual(['nova-lite', 'nova-2-lite', 'nova-micro']);
    expect(resolved.models.decisionBedrockIds[0]).toBe('moonshot.kimi-k2-thinking');
    expect(resolved.levers).toEqual(DIFFICULTY_TIERS.pro.levers);
    expect(resolved.valuation.positionWeights?.RB).toBe(0.75);
    expect(resolved.prompt.persona).toContain('The Spreadsheet');
    expect(resolved.prompt.strategy).toContain('Zero RB');
    expect(resolved.prompt.difficulty).toContain('projections, news, trending');
    expect(resolved.prompt.customFlavor).toBeNull();
    expect(resolveAgentConfig({ ...base, archetype: 'balanced' }).valuation.positionWeights).toBeUndefined();
  });

  it('applies advanced overrides without touching the catalog', () => {
    const resolved = resolveAgentConfig({
      ...base,
      difficulty: 'rookie',
      advanced: {
        modelOverride: 'claude-sonnet-5',
        levers: { maxToolSteps: 12, research: { news: true } },
        customFlavor: '  Loves kickers.  '
      }
    });
    expect(resolved.models.decision[0]).toBe('claude-sonnet-5');
    expect(resolved.models.chat[0]).toBe('nova-micro');
    expect(resolved.levers.maxToolSteps).toBe(12);
    expect(resolved.levers.actionsPerTrigger).toBe(DIFFICULTY_TIERS.rookie.levers.actionsPerTrigger);
    expect(resolved.levers.research).toEqual({
      projections: true,
      news: true,
      trending: false,
      matchupOutlook: false
    });
    expect(resolved.prompt.customFlavor).toBe('Loves kickers.');
    expect(resolved.prompt.difficulty).toContain('projections, news');
    expect(DIFFICULTY_TIERS.rookie.levers.research.news).toBe(false);
    expect(resolved.levers.responseDelay).toEqual(DIFFICULTY_TIERS.rookie.levers.responseDelay);
    const none = resolveAgentConfig({
      ...base,
      advanced: { levers: { research: { projections: false, news: false, trending: false } } }
    });
    expect(none.prompt.difficulty).toContain('Research you can use: none.');
  });

  it('round-trips a response delay override, one field at a time (#189)', () => {
    const config: AgentSeatConfig = {
      ...base,
      difficulty: 'rookie',
      advanced: { levers: { responseDelay: { immediateChance: 0.5 } } }
    };
    expect(AgentSeatConfigSchema.parse(JSON.parse(JSON.stringify(config)))).toEqual(config);
    expect(resolveAgentConfig(config).levers.responseDelay).toEqual({ multiplier: 2, immediateChance: 0.5 });
    const off = resolveAgentConfig({ ...base, advanced: { levers: { responseDelay: { multiplier: 0 } } } });
    expect(off.levers.responseDelay).toEqual({ multiplier: 0, immediateChance: 0.15 });
    expect(DIFFICULTY_TIERS.pro.levers.responseDelay.multiplier).toBe(1);
  });

  it.each([
    [{ ...base, advanced: { levers: { responseDelay: { multiplier: 9 } } } }],
    [{ ...base, advanced: { levers: { responseDelay: { immediateChance: 1.5 } } } }],
    [{ ...base, advanced: { levers: { responseDelay: { sleeps: true } } } }],
    [{ ...base, personalityId: 'unknown' }],
    [{ ...base, difficulty: 'legend' }],
    [{ ...base, archetype: 'yolo' }],
    [{ ...base, extra: true }],
    [{ ...base, advanced: { modelOverride: 'gpt-9' } }],
    [{ ...base, advanced: { customFlavor: 'x'.repeat(CUSTOM_FLAVOR_MAX + 1) } }],
    [{ ...base, advanced: { customFlavor: '   ' } }],
    [{ ...base, advanced: { levers: { maxToolSteps: 0 } } }],
    [{ ...base, advanced: { levers: { valuationNoise: 0.9 } } }],
    [{ ...base, advanced: { levers: { cheat: true } } }],
    [{ ...base, advanced: { levers: { research: { mindReading: true } } } }]
  ])('rejects %o', (input) => {
    expect(AgentSeatConfigSchema.safeParse(input).success).toBe(false);
  });

  it('accepts a flavor at exactly the limit', () => {
    const flavor = 'y'.repeat(CUSTOM_FLAVOR_MAX);
    expect(
      AgentSeatConfigSchema.parse({ ...base, advanced: { customFlavor: flavor } }).advanced?.customFlavor
    ).toBe(flavor);
  });
});

describe('randomizeAgentSeats', () => {
  it('is deterministic, diverse, and valid for any count and seed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_RANDOM_SEATS }), fc.string(), (count, seed) => {
        const seats = randomizeAgentSeats(count, seed);
        expect(randomizeAgentSeats(count, seed)).toEqual(seats);
        expect(seats).toHaveLength(count);
        expect(new Set(seats.map((s) => s.personalityId)).size).toBe(count);
        for (const seat of seats) expect(AgentSeatConfigSchema.safeParse(seat).success).toBe(true);
        const spreadOk = (values: string[], universe: readonly string[]) => {
          const counts = universe.map((u) => values.filter((v) => v === u).length);
          return Math.max(...counts) - Math.min(...counts) <= 1;
        };
        expect(
          spreadOk(
            seats.map((s) => s.difficulty),
            DIFFICULTIES
          )
        ).toBe(true);
        expect(
          spreadOk(
            seats.map((s) => s.archetype),
            ARCHETYPES
          )
        ).toBe(true);
        expect(new Set(seats.map((s) => s.difficulty)).size).toBe(Math.min(count, DIFFICULTIES.length));
      })
    );
  });

  it('varies with the seed', () => {
    const a = JSON.stringify(randomizeAgentSeats(7, 'league-a'));
    const b = JSON.stringify(randomizeAgentSeats(7, 'league-b'));
    expect(a).not.toBe(b);
  });

  it.each([-1, 1.5, MAX_RANDOM_SEATS + 1])('rejects count %s', (count) => {
    expect(() => randomizeAgentSeats(count, 's')).toThrow(RangeError);
  });
});

describe('league weekly budget', () => {
  it('sums seat allowances and clamps to the floor and cap', () => {
    expect(leagueWeeklyBudgetUsd([])).toBe(LEAGUE_WEEKLY_BUDGET_FLOOR_USD);
    expect(leagueWeeklyBudgetUsd(['pro', 'all_pro'])).toBe(
      DIFFICULTY_WEEKLY_BUDGET_USD.pro + DIFFICULTY_WEEKLY_BUDGET_USD.all_pro
    );
    expect(leagueWeeklyBudgetUsd(Array.from({ length: 11 }, () => 'hall_of_famer' as const))).toBe(
      LEAGUE_WEEKLY_BUDGET_CAP_USD
    );
  });
});
