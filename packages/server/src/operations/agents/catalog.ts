import { randomUUID } from 'node:crypto';
import {
  AgentSeatConfigSchema,
  ARCHETYPES,
  DIFFICULTIES,
  DIFFICULTY_TIERS,
  MAX_RANDOM_SEATS,
  getModel,
  MODEL_TIER_MODELS,
  MODEL_TIERS,
  PERSONALITIES,
  PERSONALITY_IDS,
  randomizeAgentSeats,
  STRATEGY_ARCHETYPES,
  type ModelTier
} from '@fantasy/core';
import { z } from 'zod';
import { defineOperation } from '../../registry/operation.js';

/** Every model a tier lists, once, with the weakest tier that lists it. */
function tieredModels(): { key: string; displayName: string; tier: ModelTier }[] {
  const seen = new Map<string, { key: string; displayName: string; tier: ModelTier }>();
  for (const tier of MODEL_TIERS) {
    for (const key of MODEL_TIER_MODELS[tier]) {
      if (!seen.has(key)) seen.set(key, { key, displayName: getModel(key).displayName, tier });
    }
  }
  return [...seen.values()];
}

export const getAgentCatalog = defineOperation({
  name: 'get_agent_catalog',
  method: 'GET',
  path: '/agents/catalog',
  summary: 'The agent presets: personalities, difficulties, strategies, and models',
  description: [
    'Lists every choice configure_agent_seat accepts: the personality presets (with a bio and avatar seed), the difficulty tiers (with the model tier each one decides with), the strategy archetypes, the model tiers, and the catalog models an Advanced model override may name.',
    'Pass `suggest` (1-20) to also get that many varied seat configs (no repeated personality, difficulties and strategies spread evenly), the same mix randomize_agent_seats would write; the same `seed` gives the same mix. Reading the catalog changes nothing.'
  ].join(' '),
  tags: ['agents'],
  mutation: false,
  auth: 'user',
  input: z.object({
    suggest: z
      .number()
      .int()
      .min(1)
      .max(MAX_RANDOM_SEATS)
      .optional()
      .describe(`How many suggested seat configs to return (1-${MAX_RANDOM_SEATS}).`),
    seed: z.string().min(1).max(100).optional().describe('Seed for a repeatable suggestion.')
  }),
  output: z.object({
    personalities: z.array(
      z.object({
        id: z.enum(PERSONALITY_IDS),
        displayName: z.string(),
        teamNameSuggestion: z.string(),
        bio: z.string(),
        avatarSeed: z.string()
      })
    ),
    difficulties: z.array(
      z.object({
        id: z.enum(DIFFICULTIES),
        displayName: z.string(),
        description: z.string(),
        decisionModelTier: z.enum(MODEL_TIERS)
      })
    ),
    archetypes: z.array(
      z.object({ id: z.enum(ARCHETYPES), displayName: z.string(), description: z.string() })
    ),
    modelTiers: z.array(z.enum(MODEL_TIERS)).describe('Weakest to strongest.'),
    models: z.array(
      z.object({
        key: z.string().describe('Use as advanced.modelOverride.'),
        displayName: z.string(),
        tier: z.enum(MODEL_TIERS).describe('The weakest tier that lists this model.')
      })
    ),
    suggestion: z
      .object({ seed: z.string(), seats: z.array(AgentSeatConfigSchema) })
      .nullable()
      .describe('Suggested seat configs when `suggest` was given, else null.')
  }),
  handler: async (_ctx, input) => {
    const seed = input.seed ?? randomUUID();
    return {
      personalities: PERSONALITIES.map(({ id, displayName, teamNameSuggestion, bio, avatarSeed }) => ({
        id,
        displayName,
        teamNameSuggestion,
        bio,
        avatarSeed
      })),
      difficulties: DIFFICULTIES.map((id) => {
        const tier = DIFFICULTY_TIERS[id];
        return {
          id,
          displayName: tier.displayName,
          description: tier.description,
          decisionModelTier: tier.levers.decisionModelTier
        };
      }),
      archetypes: ARCHETYPES.map((id) => {
        const { displayName, description } = STRATEGY_ARCHETYPES[id];
        return { id, displayName, description };
      }),
      modelTiers: [...MODEL_TIERS],
      models: tieredModels(),
      suggestion:
        input.suggest === undefined ? null : { seed, seats: randomizeAgentSeats(input.suggest, seed) }
    };
  }
});
