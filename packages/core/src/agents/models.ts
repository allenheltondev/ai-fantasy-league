/**
 * The Bedrock model catalog for agents (us-east-1).
 *
 * Every id here is a Bedrock model id or cross-region inference profile id that the agent runtime
 * passes to Converse. `scripts/verify-models.mjs` checks every id against `bedrock
 * list-inference-profiles` and `list-foundation-models` with the deploy credentials and fails the
 * deploy when one is missing. Every id below was verified that way against the deploy account on
 * 2026-09-28 (#105); a new entry must pass the same check before it ships.
 *
 * Fallbacks: each model tier lists catalog models best-first. The runtime uses the first model in
 * the list and moves to the next one when a call fails because the model is unavailable (access not
 * granted, throttled out, or retired). If every model in a tier fails, the agent falls back to its
 * deterministic behavior (autopick, the lineup optimizer, no waiver claims, rejecting trades).
 *
 * Prices are ESTIMATES in USD per million tokens, used only for budget tracking and the cost
 * dashboard. They are not billing data; check the Bedrock pricing page before relying on them.
 *
 * This file has no imports so `scripts/verify-models.mjs` can load it directly.
 */

export const MODEL_PROVIDERS = ['amazon', 'moonshot', 'anthropic'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface ModelPrice {
  /** Estimated USD per million input tokens. */
  inputPerMTok: number;
  /** Estimated USD per million output tokens. */
  outputPerMTok: number;
}

export interface CatalogModel {
  /** Stable catalog key used in configs; never changes when the Bedrock id does. */
  key: string;
  displayName: string;
  provider: ModelProvider;
  /** The id passed to Bedrock Converse: an inference profile id (`us.` prefix) or a model id. */
  bedrockId: string;
  /**
   * The underlying foundation model id. For an inference profile this is the id without the
   * geography prefix; IAM needs both the profile ARN and the foundation-model ARN.
   */
  foundationModelId: string;
  /** True when `bedrockId` is a cross-region inference profile rather than an in-region model. */
  inferenceProfile: boolean;
  /** False until `scripts/verify-models.mjs` has confirmed the id in us-east-1. */
  verified: boolean;
  /** Estimated price; see the file comment. */
  price: ModelPrice;
  /** Whether the price is an estimate. Always true today. */
  priceIsEstimate: true;
  /**
   * True when the model takes an extended-thinking budget (Anthropic `thinking.budget_tokens` in
   * Converse `additionalModelRequestFields`). The runtime maps the difficulty's reasoning effort to
   * that budget; for other models reasoning effort only sets the response token limit.
   */
  thinkingBudget?: true;
  /**
   * True when the model rejects `thinking.type: enabled` and takes adaptive thinking instead
   * (`thinking.type: adaptive` plus `output_config.effort`), as the Claude 5 models do. Set
   * together with `thinkingBudget`; the runtime then sends the reasoning effort, not a budget.
   */
  adaptiveThinking?: true;
  /**
   * True when the model reasons in its visible output rather than in a separate thinking budget
   * (Kimi K2 Thinking), so its reasoning counts against the response limit. The runtime gives it
   * more room there, by reasoning effort.
   */
  reasoningInOutput?: true;
}

export const MODEL_REGION = 'us-east-1';

function model(
  input: Omit<CatalogModel, 'foundationModelId' | 'priceIsEstimate' | 'verified'>
): CatalogModel {
  const foundationModelId = input.inferenceProfile ? input.bedrockId.replace(/^us\./, '') : input.bedrockId;
  return { ...input, foundationModelId, verified: true, priceIsEstimate: true };
}

export const MODEL_CATALOG = [
  model({
    key: 'nova-micro',
    displayName: 'Amazon Nova Micro',
    provider: 'amazon',
    bedrockId: 'us.amazon.nova-micro-v1:0',
    inferenceProfile: true,
    price: { inputPerMTok: 0.035, outputPerMTok: 0.14 }
  }),
  model({
    key: 'nova-lite',
    displayName: 'Amazon Nova Lite',
    provider: 'amazon',
    bedrockId: 'us.amazon.nova-lite-v1:0',
    inferenceProfile: true,
    price: { inputPerMTok: 0.06, outputPerMTok: 0.24 }
  }),
  model({
    key: 'nova-2-lite',
    displayName: 'Amazon Nova 2 Lite',
    provider: 'amazon',
    bedrockId: 'us.amazon.nova-2-lite-v1:0',
    inferenceProfile: true,
    price: { inputPerMTok: 0.3, outputPerMTok: 2.5 }
  }),
  model({
    key: 'nova-pro',
    displayName: 'Amazon Nova Pro',
    provider: 'amazon',
    bedrockId: 'us.amazon.nova-pro-v1:0',
    inferenceProfile: true,
    price: { inputPerMTok: 0.8, outputPerMTok: 3.2 }
  }),
  model({
    key: 'kimi-k2-thinking',
    reasoningInOutput: true,
    displayName: 'Moonshot Kimi K2 Thinking',
    provider: 'moonshot',
    bedrockId: 'moonshot.kimi-k2-thinking',
    inferenceProfile: false,
    price: { inputPerMTok: 0.6, outputPerMTok: 2.5 }
  }),
  model({
    key: 'claude-haiku-4-5',
    thinkingBudget: true,
    displayName: 'Claude Haiku 4.5',
    provider: 'anthropic',
    bedrockId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    inferenceProfile: true,
    price: { inputPerMTok: 1, outputPerMTok: 5 }
  }),
  model({
    key: 'claude-sonnet-5',
    thinkingBudget: true,
    adaptiveThinking: true,
    displayName: 'Claude Sonnet 5',
    provider: 'anthropic',
    bedrockId: 'us.anthropic.claude-sonnet-5',
    inferenceProfile: true,
    price: { inputPerMTok: 2, outputPerMTok: 10 }
  }),
  model({
    key: 'claude-opus-5',
    thinkingBudget: true,
    adaptiveThinking: true,
    displayName: 'Claude Opus 5',
    provider: 'anthropic',
    bedrockId: 'us.anthropic.claude-opus-5',
    inferenceProfile: true,
    price: { inputPerMTok: 5, outputPerMTok: 25 }
  })
] as const satisfies readonly CatalogModel[];

export type ModelKey = (typeof MODEL_CATALOG)[number]['key'];
export const MODEL_KEYS = MODEL_CATALOG.map((m) => m.key) as [ModelKey, ...ModelKey[]];

/**
 * Model tiers, weakest to strongest. Each lists catalog models best-first; later entries are the
 * fallbacks when an earlier one is unavailable. Tiers mix model families on purpose (SPEC §8), so
 * agents at different difficulties value players differently.
 */
export const MODEL_TIERS = ['micro', 'lite', 'standard', 'advanced', 'frontier'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const MODEL_TIER_MODELS: Readonly<Record<ModelTier, readonly [ModelKey, ...ModelKey[]]>> = {
  micro: ['nova-micro', 'nova-lite'],
  lite: ['nova-lite', 'nova-2-lite', 'nova-micro'],
  standard: ['kimi-k2-thinking', 'nova-pro', 'claude-haiku-4-5'],
  advanced: ['claude-sonnet-5', 'claude-haiku-4-5', 'nova-pro'],
  frontier: ['claude-opus-5', 'claude-sonnet-5']
};

export function getModel(key: ModelKey): CatalogModel {
  const found = MODEL_CATALOG.find((m) => m.key === key);
  if (found === undefined) throw new Error(`Unknown model key "${key}"`);
  return found;
}

export function isModelKey(value: string): value is ModelKey {
  return (MODEL_KEYS as readonly string[]).includes(value);
}

/** Looks a model up by its Bedrock id (as reported in usage), or null. */
export function modelByBedrockId(bedrockId: string): CatalogModel | null {
  return MODEL_CATALOG.find((m) => m.bedrockId === bedrockId) ?? null;
}

/** The ordered model chain (primary first, then fallbacks) for a tier, optionally with an override first. */
export function modelChain(tier: ModelTier, override?: ModelKey): ModelKey[] {
  const chain: ModelKey[] = override === undefined ? [] : [override];
  for (const key of MODEL_TIER_MODELS[tier]) if (!chain.includes(key)) chain.push(key);
  return chain;
}

/** Every Bedrock id in the catalog: what `scripts/verify-models.mjs` checks and what IAM must allow. */
export function catalogBedrockIds(): string[] {
  return MODEL_CATALOG.map((m) => m.bedrockId);
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Estimated USD cost of a call (see the price disclaimer above). Unknown models cost 0. */
export function estimateCostUsd(modelKeyOrBedrockId: string, usage: TokenUsage): number {
  const m = MODEL_CATALOG.find((c) => c.key === modelKeyOrBedrockId) ?? modelByBedrockId(modelKeyOrBedrockId);
  if (m === undefined || m === null) return 0;
  const cost =
    (usage.inputTokens * m.price.inputPerMTok + usage.outputTokens * m.price.outputPerMTok) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
