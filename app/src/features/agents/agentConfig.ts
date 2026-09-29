import type { StatusBadgeTone } from '@readysetcloud/ui';
import type { AgentCatalog, AgentSeatConfig, Personality } from '../../api/types';

/** A different personality for one seat, preferring ones no other seat uses, with a new name and avatar. */
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
  return rerollManager({ ...current, personalityId: pick.id }, configs, index, catalog, random);
}

export const MANAGER_NAME_MAX = 40;

/** Why a typed manager name would be refused, or null when it is fine (mirrors the API's rules). */
export function managerNameError(name: string, taken: readonly string[] = []): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Enter a name.';
  if (trimmed.length > MANAGER_NAME_MAX) return `Use at most ${MANAGER_NAME_MAX} characters.`;
  if (/[\p{Cc}\p{Cf}]/u.test(trimmed)) return 'Use one line with no special characters.';
  if (taken.some((t) => t.trim().toLowerCase() === trimmed.toLowerCase())) {
    return 'Another manager already has that name.';
  }
  return null;
}

/**
 * A manager name from the catalog's pool that `avoid` does not have: "First Last", or now and then
 * `First "Nickname" Last` with one of the personality's nicknames. Null when the catalog has no pool.
 */
export function rollManagerName(
  catalog: AgentCatalog,
  personalityId: string,
  avoid: readonly string[],
  random: () => number = Math.random
): string | null {
  const pool = catalog.managerNames;
  if (pool === undefined || pool.first.length === 0 || pool.last.length === 0) return null;
  const nicknames = catalog.personalities.find((p) => p.id === personalityId)?.nicknames ?? [];
  const pick = (xs: readonly string[]) => xs[Math.floor(random() * xs.length)] as string;
  let name = '';
  for (let attempt = 0; attempt < 50; attempt++) {
    const nick = nicknames.length > 0 && random() < 1 / 3 ? pick(nicknames) : null;
    const first = pick(pool.first);
    const last = pick(pool.last);
    name = nick === null ? `${first} ${last}` : `${first} "${nick}" ${last}`;
    if (managerNameError(name, avoid) === null) return name;
  }
  return name;
}

/** A fresh avatar seed. */
export function rollAvatarSeed(random: () => number = Math.random): string {
  return Array.from(
    { length: 10 },
    () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(random() * 36)]
  ).join('');
}

/** The names every other seat in `configs` uses. */
export function otherNames(configs: readonly AgentSeatConfig[], index: number): string[] {
  return configs.flatMap((c, i) => (i !== index && c.name !== undefined ? [c.name] : []));
}

/** The seat at `index` with a new name (unique among `configs`) and a new avatar. */
export function rerollManager(
  config: AgentSeatConfig,
  configs: readonly AgentSeatConfig[],
  index: number,
  catalog: AgentCatalog,
  random: () => number = Math.random
): AgentSeatConfig {
  const name = rollManagerName(catalog, config.personalityId, otherNames(configs, index), random);
  return { ...config, ...(name === null ? {} : { name }), avatarSeed: rollAvatarSeed(random) };
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
  for (const nested of ['research', 'responseDelay']) {
    const value = levers[nested] as Record<string, unknown> | undefined;
    if (value === undefined) continue;
    const kept = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
    if (Object.keys(kept).length === 0) delete levers[nested];
    else levers[nested] = kept;
  }
  const clean: NonNullable<AgentSeatConfig['advanced']> = {};
  if (advanced.modelOverride) clean.modelOverride = advanced.modelOverride;
  if (advanced.customFlavor?.trim()) clean.customFlavor = advanced.customFlavor.trim();
  if (Object.keys(levers).length > 0) clean.levers = levers;
  const { advanced: _drop, ...base } = config;
  return Object.keys(clean).length > 0 ? { ...base, advanced: clean } : base;
}
