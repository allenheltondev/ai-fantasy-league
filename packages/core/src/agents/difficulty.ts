import { z } from 'zod';
import { seededRandom } from '../schedule/random.js';
import { MODEL_TIERS } from './models.js';

/**
 * Difficulty tiers. Each tier bundles the levers an Advanced drawer can override one at a time:
 * which models it uses, what research it can see, how hard it thinks, how often it acts, how long it
 * negotiates, and how accurately it values players.
 */

export const DIFFICULTIES = ['rookie', 'amateur', 'pro', 'all_pro', 'hall_of_famer'] as const;
export const DifficultySchema = z.enum(DIFFICULTIES);
export type Difficulty = z.infer<typeof DifficultySchema>;

export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Research an agent may use. Maps to which read tools the agent receives. */
export const ResearchAccessSchema = z.strictObject({
  projections: z.boolean(),
  news: z.boolean(),
  trending: z.boolean(),
  matchupOutlook: z.boolean()
});
export type ResearchAccess = z.infer<typeof ResearchAccessSchema>;
export const RESEARCH_KINDS = ['projections', 'news', 'trending', 'matchupOutlook'] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];

export const DifficultyLeversSchema = z.strictObject({
  /** Model tier for decisions (draft, trades, waivers, lineups). */
  decisionModelTier: z.enum(MODEL_TIERS),
  /** Cheaper model tier for chat and news summaries. */
  chatModelTier: z.enum(MODEL_TIERS),
  research: ResearchAccessSchema,
  reasoningEffort: z.enum(REASONING_EFFORTS),
  /** Upper bound on model/tool loop iterations per task. */
  maxToolSteps: z.number().int().min(1).max(40),
  /** Mutating actions allowed per trigger. */
  actionsPerTrigger: z.number().int().min(1).max(10),
  /** Minimum minutes between two non-urgent triggers for the same agent. */
  cooldownMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60),
  /** Counter-offers the agent may make in one trade negotiation. */
  negotiationRounds: z.number().int().min(0).max(10),
  /** Relative error on player values: 0.2 means values are off by up to ±20%. */
  valuationNoise: z.number().min(0).max(0.5)
});
export type DifficultyLevers = z.infer<typeof DifficultyLeversSchema>;

export interface DifficultyTier {
  id: Difficulty;
  displayName: string;
  description: string;
  levers: DifficultyLevers;
}

export const DIFFICULTY_TIERS: Readonly<Record<Difficulty, DifficultyTier>> = {
  rookie: {
    id: 'rookie',
    displayName: 'Rookie',
    description: 'Learning the game. Only sees projections, acts rarely, and misjudges value often.',
    levers: {
      decisionModelTier: 'micro',
      chatModelTier: 'micro',
      research: { projections: true, news: false, trending: false, matchupOutlook: false },
      reasoningEffort: 'low',
      maxToolSteps: 4,
      actionsPerTrigger: 1,
      cooldownMinutes: 240,
      negotiationRounds: 1,
      valuationNoise: 0.25
    }
  },
  amateur: {
    id: 'amateur',
    displayName: 'Amateur',
    description: 'A casual manager. Checks projections and trending players, sometimes overreacts.',
    levers: {
      decisionModelTier: 'lite',
      chatModelTier: 'micro',
      research: { projections: true, news: false, trending: true, matchupOutlook: false },
      reasoningEffort: 'low',
      maxToolSteps: 6,
      actionsPerTrigger: 2,
      cooldownMinutes: 120,
      negotiationRounds: 1,
      valuationNoise: 0.15
    }
  },
  pro: {
    id: 'pro',
    displayName: 'Pro',
    description: 'A sharp manager who reads the news and haggles a little.',
    levers: {
      decisionModelTier: 'standard',
      chatModelTier: 'lite',
      research: { projections: true, news: true, trending: true, matchupOutlook: false },
      reasoningEffort: 'medium',
      maxToolSteps: 10,
      actionsPerTrigger: 3,
      cooldownMinutes: 60,
      negotiationRounds: 2,
      valuationNoise: 0.08
    }
  },
  all_pro: {
    id: 'all_pro',
    displayName: 'All-Pro',
    description: 'Full research, quick to act, and a patient negotiator.',
    levers: {
      decisionModelTier: 'advanced',
      chatModelTier: 'lite',
      research: { projections: true, news: true, trending: true, matchupOutlook: true },
      reasoningEffort: 'medium',
      maxToolSteps: 14,
      actionsPerTrigger: 4,
      cooldownMinutes: 30,
      negotiationRounds: 3,
      valuationNoise: 0.04
    }
  },
  hall_of_famer: {
    id: 'hall_of_famer',
    displayName: 'Hall of Famer',
    description: 'The strongest models, every research source, deep reasoning, and exact valuations.',
    levers: {
      decisionModelTier: 'frontier',
      chatModelTier: 'standard',
      research: { projections: true, news: true, trending: true, matchupOutlook: true },
      reasoningEffort: 'high',
      maxToolSteps: 20,
      actionsPerTrigger: 6,
      cooldownMinutes: 15,
      negotiationRounds: 4,
      valuationNoise: 0
    }
  }
};

export function getDifficulty(id: Difficulty): DifficultyTier {
  return DIFFICULTY_TIERS[id];
}

/**
 * Deterministic valuation noise: the multiplier a weaker agent applies to a player's value. The
 * same `seed` and `playerId` always give the same multiplier, in [1 − noise, 1 + noise].
 */
export function valuationNoiseMultiplier(noise: number, seed: string, playerId: string): number {
  if (noise <= 0) return 1;
  const r = seededRandom(`${seed}:${playerId}`)();
  return 1 + noise * (2 * r - 1);
}

/** Applies `valuationNoiseMultiplier` to a value, rounded to 2 decimals. */
export function applyValuationNoise(value: number, noise: number, seed: string, playerId: string): number {
  return Math.round(value * valuationNoiseMultiplier(noise, seed, playerId) * 100) / 100;
}
