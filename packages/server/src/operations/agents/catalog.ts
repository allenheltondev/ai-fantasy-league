import { randomUUID } from 'node:crypto';
import {
  AgentSeatConfigSchema,
  ARCHETYPES,
  DIFFICULTIES,
  DIFFICULTY_TIERS,
  MAX_RANDOM_SEATS,
  getModel,
  MANAGER_FIRST_NAMES,
  MANAGER_LAST_NAMES,
  MANAGER_NAME_MAX,
  MODEL_TIER_MODELS,
  MODEL_TIERS,
  PERSONALITIES,
  PERSONALITY_IDS,
  PERSONALITY_NICKNAMES,
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
    'Lists every choice configure_agent_seat accepts: the personality presets (with a bio, avatar seed, and nicknames), the difficulty tiers (with the model tier each one decides with), the strategy archetypes, the model tiers, and the catalog models an Advanced model override may name.',
    `\`managerNames\` is the pool AI manager names are drawn from ("First Last", sometimes \`First "Nickname" Last\` with a personality nickname, at most ${MANAGER_NAME_MAX} characters); any name that fits the limit is accepted.`,
    `Pass \`suggest\` (1-${MAX_RANDOM_SEATS}) to also get that many varied seat configs (no repeated personality or manager name, difficulties and strategies spread evenly, a fresh avatar each), the same mix randomize_agent_seats would write; the same \`seed\` gives the same mix. Reading the catalog changes nothing.`
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
        avatarSeed: z.string(),
        nicknames: z.array(z.string()).describe('Nicknames a manager with this personality may carry.')
      })
    ),
    managerNames: z
      .object({ first: z.array(z.string()), last: z.array(z.string()) })
      .describe('The first and last names AI manager names are drawn from.'),
    difficulties: z.array(
      z.object({
        id: z.enum(DIFFICULTIES),
        displayName: z.string(),
        description: z.string(),
        decisionModelTier: z.enum(MODEL_TIERS)
      })
    ),
    archetypes: z.array(
      z.object({
        id: z.enum(ARCHETYPES),
        displayName: z.string(),
        description: z.string(),
        waiverAggressiveness: z.number().describe('0 rarely claims, 1 claims every week and bids big.'),
        tradeFrequency: z.number().describe('Trade appetite: 0 only answers offers, 1 proposes constantly.'),
        riskTolerance: z.number().describe('0 benches anyone with an injury tag, 1 ignores injury tags.')
      })
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
        avatarSeed,
        nicknames: [...PERSONALITY_NICKNAMES[id]]
      })),
      managerNames: { first: [...MANAGER_FIRST_NAMES], last: [...MANAGER_LAST_NAMES] },
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
        const { displayName, description, waiverAggressiveness, tradeFrequency, valuation } =
          STRATEGY_ARCHETYPES[id];
        return {
          id,
          displayName,
          description,
          waiverAggressiveness,
          tradeFrequency,
          riskTolerance: valuation.riskTolerance
        };
      }),
      modelTiers: [...MODEL_TIERS],
      models: tieredModels(),
      suggestion:
        input.suggest === undefined ? null : { seed, seats: randomizeAgentSeats(input.suggest, seed) }
    };
  }
});
