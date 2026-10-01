import { z } from 'zod';
import { DIFFICULTIES, type Difficulty } from './difficulty.js';
import { MODEL_KEYS, type ModelKey } from './models.js';

/** The most a commissioner can set as a league's weekly AI budget. */
export const MAX_WEEKLY_AI_BUDGET_USD = 100;
/** The most overage a commissioner can allow past the weekly budget. */
export const MAX_AI_OVERAGE_USD = 100;

const usd = (max: number) => z.number().min(0).max(max);

const ModelChoiceSchema = z
  .enum(MODEL_KEYS)
  .nullable()
  .default(null)
  .describe('Catalog model key to try first; null keeps the difficulty tier default.');

export const DifficultyModelsSchema = z.strictObject({
  decision: ModelChoiceSchema.describe(
    'Model this difficulty tries first for decisions (draft, lineups, waivers, trades); null keeps the tier default.'
  ),
  chat: ModelChoiceSchema.describe(
    'Model this difficulty tries first for chat and summaries; null keeps the tier default.'
  )
});
export type DifficultyModels = z.infer<typeof DifficultyModelsSchema>;

const noModels = (): DifficultyModels => ({ decision: null, chat: null });

export const DifficultyModelMapSchema = z.strictObject(
  Object.fromEntries(DIFFICULTIES.map((d) => [d, DifficultyModelsSchema.default(noModels)])) as Record<
    Difficulty,
    z.ZodDefault<typeof DifficultyModelsSchema>
  >
);
export type DifficultyModelMap = Record<Difficulty, DifficultyModels>;

/**
 * The commissioner's AI controls. The weekly budget is the soft ceiling agents spend against;
 * `overageUsd` lets them keep using models past it, up to that much more, before they fall back to
 * deterministic moves. `models` puts a chosen model at the front of a difficulty's chain; a seat's
 * own Advanced model override still comes first.
 */
export const AiSettingsSchema = z.strictObject({
  weeklyBudgetUsd: usd(MAX_WEEKLY_AI_BUDGET_USD)
    .nullable()
    .default(null)
    .describe(
      "Weekly model spend ceiling in USD (estimates). null: automatic, from the agent seats' difficulties."
    ),
  overageUsd: usd(MAX_AI_OVERAGE_USD)
    .default(0)
    .describe('Extra USD agents may spend past the weekly ceiling before falling back; 0 turns overage off.'),
  models: DifficultyModelMapSchema.default(() => defaultAiSettings().models).describe(
    'Per difficulty: the model tried first for decisions and for chat.'
  )
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

export function defaultAiSettings(): AiSettings {
  return {
    weeklyBudgetUsd: null,
    overageUsd: 0,
    models: Object.fromEntries(DIFFICULTIES.map((d) => [d, noModels()])) as DifficultyModelMap
  };
}

/** The league's chosen models for one difficulty, as `resolveAgentConfig` takes them. */
export function leagueModelsFor(
  ai: Pick<AiSettings, 'models'> | undefined,
  difficulty: Difficulty
): { decision?: ModelKey; chat?: ModelKey } {
  const chosen = ai?.models[difficulty];
  return {
    ...(chosen?.decision == null ? {} : { decision: chosen.decision }),
    ...(chosen?.chat == null ? {} : { chat: chosen.chat })
  };
}
