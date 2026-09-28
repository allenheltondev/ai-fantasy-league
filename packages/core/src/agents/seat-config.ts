import { z } from 'zod';
import { seededRandom, seededShuffle } from '../schedule/random.js';
import type { ValuationWeights } from '../valuation/value.js';
import {
  ARCHETYPES,
  ArchetypeSchema,
  getArchetype,
  type Archetype,
  type StrategyArchetype
} from './archetypes.js';
import {
  DIFFICULTIES,
  DifficultyLeversSchema,
  DifficultySchema,
  ResearchAccessSchema,
  getDifficulty,
  type Difficulty,
  type DifficultyLevers,
  type DifficultyTier
} from './difficulty.js';
import { tradeAppetite, waiverMinGain } from './behavior.js';
import { MODEL_KEYS, getModel, modelChain, type ModelKey } from './models.js';
import {
  PERSONALITIES,
  PERSONALITY_IDS,
  getPersonality,
  type PersonalityId,
  type PersonalityPreset
} from './personalities.js';

export const CUSTOM_FLAVOR_MAX = 280;

/** Individual lever overrides from the Advanced drawer; anything left out comes from the difficulty. */
export const LeverOverridesSchema = DifficultyLeversSchema.omit({ research: true })
  .partial()
  .extend({ research: ResearchAccessSchema.partial().optional() })
  .strict();
export type LeverOverrides = z.infer<typeof LeverOverridesSchema>;

export const AgentSeatConfigSchema = z.strictObject({
  personalityId: z.enum(PERSONALITY_IDS).describe('Personality preset id.'),
  difficulty: DifficultySchema.describe('Difficulty tier.'),
  archetype: ArchetypeSchema.describe('Strategy archetype.'),
  advanced: z
    .strictObject({
      modelOverride: z
        .enum(MODEL_KEYS)
        .optional()
        .describe('Catalog model key to use for decisions ahead of the tier default.'),
      levers: LeverOverridesSchema.optional().describe('Individual difficulty levers to override.'),
      customFlavor: z
        .string()
        .trim()
        .min(1)
        .max(CUSTOM_FLAVOR_MAX)
        .optional()
        .describe(`Extra personality flavor, up to ${CUSTOM_FLAVOR_MAX} characters.`)
    })
    .optional()
    .describe('Advanced drawer settings.')
});
export type AgentSeatConfig = z.infer<typeof AgentSeatConfigSchema>;

export interface ResolvedAgentConfig {
  personality: PersonalityPreset;
  difficulty: DifficultyTier;
  archetype: StrategyArchetype;
  /** The difficulty's levers with any Advanced overrides applied. */
  levers: DifficultyLevers;
  models: {
    /** Decision model keys, primary first then fallbacks. The override (if any) is first. */
    decision: ModelKey[];
    /** Chat model keys, primary first then fallbacks. */
    chat: ModelKey[];
    decisionBedrockIds: string[];
    chatBedrockIds: string[];
  };
  /** Core valuation weights for the archetype. */
  valuation: ValuationWeights;
  waiverAggressiveness: number;
  tradeFrequency: number;
  /** Prompt building blocks; the runtime assembles them with league rules and the task. */
  prompt: {
    persona: string;
    strategy: string;
    difficulty: string;
    customFlavor: string | null;
  };
}

function mergeLevers(base: DifficultyLevers, overrides: LeverOverrides | undefined): DifficultyLevers {
  if (overrides === undefined) return { ...base, research: { ...base.research } };
  const { research, ...rest } = overrides;
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const researchDefined = Object.fromEntries(
    Object.entries(research ?? {}).filter(([, v]) => v !== undefined)
  );
  return DifficultyLeversSchema.parse({
    ...base,
    ...defined,
    research: { ...base.research, ...researchDefined }
  });
}

function personaPrompt(p: PersonalityPreset): string {
  return [
    `You are "${p.displayName}". ${p.bio}`,
    `Voice: ${p.voice}`,
    `Trash talk: ${p.trashTalkStyle} Keep it about fantasy football, playful and never cruel.`,
    `Example lines: ${p.sampleLines.map((l) => `"${l}"`).join(' ')}`
  ].join('\n');
}

function strategyPrompt(archetype: StrategyArchetype, levers: DifficultyLevers): string {
  const trade = tradeAppetite({ tradeFrequency: archetype.tradeFrequency, levers });
  const risk = archetype.valuation.riskTolerance;
  const lineup =
    risk >= 0.7
      ? 'You will start a questionable player with upside.'
      : risk <= 0.35
        ? 'You bench questionable players for a safe floor.'
        : 'You weigh injury designations sensibly.';
  return [
    `Strategy: ${archetype.displayName}. ${archetype.promptGuidance}`,
    `Appetite: propose up to ${trade.proposalsPerWeek} trade(s) a week; claim waiver upgrades worth at least ${waiverMinGain(archetype.waiverAggressiveness)} projected points a week. ${lineup}`
  ].join('\n');
}

function difficultyPrompt(tier: DifficultyTier, levers: DifficultyLevers): string {
  const research = (Object.entries(levers.research) as [string, boolean][])
    .filter(([, on]) => on)
    .map(([k]) => k);
  return [
    `Skill level: ${tier.displayName}. ${tier.description}`,
    `Research you can use: ${research.length > 0 ? research.join(', ') : 'none'}.`,
    `Take at most ${levers.actionsPerTrigger} action(s) per task and at most ${levers.negotiationRounds} counter-offer(s) per trade.`
  ].join('\n');
}

/** Turns a stored seat config into everything the runtime needs: models, levers, and prompt pieces. */
export function resolveAgentConfig(input: AgentSeatConfig): ResolvedAgentConfig {
  const config = AgentSeatConfigSchema.parse(input);
  const personality = getPersonality(config.personalityId);
  const difficulty = getDifficulty(config.difficulty);
  const archetype = getArchetype(config.archetype);
  const levers = mergeLevers(difficulty.levers, config.advanced?.levers);
  const decision = modelChain(levers.decisionModelTier, config.advanced?.modelOverride);
  const chat = modelChain(levers.chatModelTier);
  return {
    personality,
    difficulty,
    archetype,
    levers,
    models: {
      decision,
      chat,
      decisionBedrockIds: decision.map((k) => getModel(k).bedrockId),
      chatBedrockIds: chat.map((k) => getModel(k).bedrockId)
    },
    valuation: {
      riskTolerance: archetype.valuation.riskTolerance,
      recencyBias: archetype.valuation.recencyBias,
      ...(archetype.valuation.positionWeights === undefined
        ? {}
        : { positionWeights: { ...archetype.valuation.positionWeights } })
    },
    waiverAggressiveness: archetype.waiverAggressiveness,
    tradeFrequency: archetype.tradeFrequency,
    prompt: {
      persona: personaPrompt(personality),
      strategy: strategyPrompt(archetype, levers),
      difficulty: difficultyPrompt(difficulty, levers),
      customFlavor: config.advanced?.customFlavor ?? null
    }
  };
}

/** The most agent seats one randomize call can fill: one per personality, no duplicates. */
export const MAX_RANDOM_SEATS = PERSONALITIES.length;

/**
 * A varied, deterministic lineup of agent seats: no duplicate personalities, difficulties spread as
 * evenly as possible (counts differ by at most one), and archetypes spread the same way. The same
 * `count` and `seed` always produce the same seats.
 */
export function randomizeAgentSeats(count: number, seed: string | number): AgentSeatConfig[] {
  if (!Number.isInteger(count) || count < 0 || count > MAX_RANDOM_SEATS) {
    throw new RangeError(`count must be an integer from 0 to ${MAX_RANDOM_SEATS}`);
  }
  const random = seededRandom(`agents:${seed}`);
  const personalities: PersonalityId[] = seededShuffle(PERSONALITY_IDS, random).slice(0, count);
  const difficulties = spread(DIFFICULTIES, count, random);
  const archetypes = spread(ARCHETYPES, count, random);
  return personalities.map((personalityId, i) => ({
    personalityId,
    difficulty: difficulties[i] as Difficulty,
    archetype: archetypes[i] as Archetype
  }));
}

/** `count` items drawn in freshly shuffled rounds of `items`, so every value appears evenly. */
function spread<T>(items: readonly T[], count: number, random: () => number): T[] {
  const out: T[] = [];
  while (out.length < count) out.push(...seededShuffle(items, random));
  return out.slice(0, count);
}
