import type { StatusBadgeTone } from '@readysetcloud/ui';
import type { AgentCatalog, AgentSeatConfig, Personality } from '../../api/types';

/** A different personality for one seat, preferring ones no other seat uses. */
export function shufflePersonality(
  configs: readonly AgentSeatConfig[],
  index: number,
  catalog: AgentCatalog,
  random: () => number = Math.random
): AgentSeatConfig {
  const current = configs[index] as AgentSeatConfig;
  const taken = new Set(configs.map((c) => c.personalityId));
  const others = catalog.personalities.filter((p) => p.id !== current.personalityId);
  const unused = others.filter((p) => !taken.has(p.id));
  const pool = unused.length > 0 ? unused : others;
  // The catalog has 20 personalities, so `pool` is never empty.
  const pick = pool[Math.floor(random() * pool.length)] as Personality;
  return { ...current, personalityId: pick.id };
}

const DIFFICULTY_TONES: readonly StatusBadgeTone[] = ['neutral', 'primary', 'success', 'warning', 'error'];

/** Rookie through Hall of Famer, coolest to hottest. */
export function difficultyTone(catalog: AgentCatalog, difficulty: string): StatusBadgeTone {
  const index = catalog.difficulties.findIndex((d) => d.id === difficulty);
  return DIFFICULTY_TONES[index] ?? 'neutral';
}

/** Drops empty Advanced values so an untouched drawer sends nothing. */
export function withAdvanced(
  config: AgentSeatConfig,
  advanced: NonNullable<AgentSeatConfig['advanced']>
): AgentSeatConfig {
  const levers = Object.fromEntries(
    Object.entries(advanced.levers ?? {}).filter(([, v]) => v !== undefined && v !== '')
  );
  const research = levers.research as Record<string, boolean> | undefined;
  if (research !== undefined && Object.keys(research).length === 0) delete levers.research;
  const clean: NonNullable<AgentSeatConfig['advanced']> = {};
  if (advanced.modelOverride) clean.modelOverride = advanced.modelOverride;
  if (advanced.customFlavor?.trim()) clean.customFlavor = advanced.customFlavor.trim();
  if (Object.keys(levers).length > 0) clean.levers = levers;
  const { advanced: _drop, ...base } = config;
  return Object.keys(clean).length > 0 ? { ...base, advanced: clean } : base;
}
