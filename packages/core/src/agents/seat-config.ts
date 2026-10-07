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
import { leagueModelsFor, type AiSettings } from './ai-settings.js';
import { tradeAppetite, waiverMinGain } from './behavior.js';
import { MODEL_KEYS, getModel, modelChain, type ModelKey } from './models.js';
import { ResponseDelayLeverSchema } from './response-delay.js';
import { temperament } from './social.js';
import {
  AvatarSeedSchema,
  ManagerNameSchema,
  effectiveManager,
  rollAvatarSeed,
  rollManagerName,
  type ManagerIdentity
} from './names.js';
import {
  PERSONALITIES,
  PERSONALITY_IDS,
  getPersonality,
  type PersonalityId,
  type PersonalityPreset
} from './personalities.js';

export const CUSTOM_FLAVOR_MAX = 280;

/** Individual lever overrides from the Advanced drawer; anything left out comes from the difficulty. */
export const LeverOverridesSchema = DifficultyLeversSchema.omit({ research: true, responseDelay: true })
  .partial()
  .extend({
    research: ResearchAccessSchema.partial().optional(),
    responseDelay: ResponseDelayLeverSchema.partial().optional()
  })
  .strict();
export type LeverOverrides = z.infer<typeof LeverOverridesSchema>;

export const AgentSeatConfigSchema = z.strictObject({
  personalityId: z.enum(PERSONALITY_IDS).describe('Personality preset id.'),
  difficulty: DifficultySchema.describe('Difficulty tier.'),
  archetype: ArchetypeSchema.describe('Strategy archetype.'),
  name: ManagerNameSchema.optional().describe(
    "The AI manager's name, 1-40 characters on one line. Omit to keep a generated default."
  ),
  avatarSeed: AvatarSeedSchema.optional().describe(
    "Seed for the manager's avatar picture. Omit to keep a generated default."
  ),
  namesTeam: z
    .boolean()
    .optional()
    .describe(
      'Let this manager name its team (#194). On (the default): it replaces a generic name like "Team 3" and may rebrand in character, and a name the commissioner gives the team stays the manager\'s to change. Off: it never renames, and a name the commissioner gives the team is locked.'
    ),
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
  /** The manager's name: the stored one, or the default for the seat's key. */
  name: string;
  avatarSeed: string;
  personality: PersonalityPreset;
  difficulty: DifficultyTier;
  archetype: StrategyArchetype;
  /** The difficulty's levers with any Advanced overrides applied. */
  levers: DifficultyLevers;
  models: {
    /**
     * Decision model keys, primary first then fallbacks: the seat's override (if any), the league's
     * model for the difficulty (if any), then the tier's models.
     */
    decision: ModelKey[];
    /** Chat model keys, primary first then fallbacks: the league's chat model (if any) first. */
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
  if (overrides === undefined)
    return { ...base, research: { ...base.research }, responseDelay: { ...base.responseDelay } };
  const { research, responseDelay, ...rest } = overrides;
  const defined = <T extends object>(o: T | undefined) =>
    Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined));
  return DifficultyLeversSchema.parse({
    ...base,
    ...defined(rest),
    research: { ...base.research, ...defined(research) },
    responseDelay: { ...base.responseDelay, ...defined(responseDelay) }
  });
}

function personaPrompt(name: string, p: PersonalityPreset): string {
  return [
    `Your name is ${name}. You play the part of "${p.displayName}": ${p.bio}`,
    `Refer to yourself as ${name}, and sign off as ${name} when you sign a message.`,
    `Voice: ${p.voice}`,
    `Temperament: ${temperament(p)}`,
    `Trash talk: ${p.trashTalkStyle} No holds barred: roast people's teams, records, picks, and moves without sparing feelings, and back every shot with a real fact from this league.`,
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

export interface ResolveAgentConfigOptions {
  /**
   * Stable key for the seat's default name and avatar when the config has none: the agent id
   * (`<leagueId>.<teamId>`). Defaults to the personality id.
   */
  managerKey?: string;
  /**
   * The seat's name and avatar as its league shows them (`leagueManagerIdentities`), which keeps a
   * default name from repeating another seat's. Overrides the default from `managerKey`.
   */
  manager?: ManagerIdentity;
  /**
   * The league's AI settings: their model for the seat's difficulty goes to the front of each chain,
   * after the seat's own Advanced override. Omitted: the tier defaults.
   */
  ai?: Pick<AiSettings, 'models'>;
}

/** Turns a stored seat config into everything the runtime needs: models, levers, and prompt pieces. */
export function resolveAgentConfig(
  input: AgentSeatConfig,
  options: ResolveAgentConfigOptions = {}
): ResolvedAgentConfig {
  const config = AgentSeatConfigSchema.parse(input);
  const manager = options.manager ?? effectiveManager(config, options.managerKey ?? config.personalityId);
  const personality = getPersonality(config.personalityId);
  const difficulty = getDifficulty(config.difficulty);
  const archetype = getArchetype(config.archetype);
  const levers = mergeLevers(difficulty.levers, config.advanced?.levers);
  const league = leagueModelsFor(options.ai, config.difficulty);
  const decision = modelChain(levers.decisionModelTier, config.advanced?.modelOverride, league.decision);
  const chat = modelChain(levers.chatModelTier, league.chat);
  return {
    name: manager.name,
    avatarSeed: manager.avatarSeed,
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
      persona: personaPrompt(manager.name, personality),
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
 * evenly as possible (counts differ by at most one), and archetypes spread the same way. Every seat
 * gets its own manager name (none repeats, nor any in `avoidNames`) and a fresh avatar seed. The
 * same `count`, `seed`, and `avoidNames` always produce the same seats.
 */
export function randomizeAgentSeats(
  count: number,
  seed: string | number,
  avoidNames: Iterable<string> = []
): AgentSeatConfig[] {
  if (!Number.isInteger(count) || count < 0 || count > MAX_RANDOM_SEATS) {
    throw new RangeError(`count must be an integer from 0 to ${MAX_RANDOM_SEATS}`);
  }
  const random = seededRandom(`agents:${seed}`);
  const personalities: PersonalityId[] = seededShuffle(PERSONALITY_IDS, random).slice(0, count);
  const difficulties = spread(DIFFICULTIES, count, random);
  const archetypes = spread(ARCHETYPES, count, random);
  const taken = [...avoidNames];
  return personalities.map((personalityId, i) => {
    const name = rollManagerName(random, { avoid: taken, personalityId });
    taken.push(name);
    return {
      personalityId,
      difficulty: difficulties[i] as Difficulty,
      archetype: archetypes[i] as Archetype,
      name,
      avatarSeed: rollAvatarSeed(random)
    };
  });
}

/** `count` items drawn in freshly shuffled rounds of `items`, so every value appears evenly. */
function spread<T>(items: readonly T[], count: number, random: () => number): T[] {
  const out: T[] = [];
  while (out.length < count) out.push(...seededShuffle(items, random));
  return out.slice(0, count);
}
