import { useRef } from 'react';

/**
 * Which keys of a live list arrived after it first loaded (a new draft pick, say), so only those get
 * an enter animation. The first snapshot (`keys` once it is not null) is remembered; anything not in
 * it counts as an arrival. Pair it with an element keyed by the item so the CSS animation runs once,
 * on mount, and never replays on later renders.
 */
export function useArrivals(keys: readonly string[] | null): (key: string) => boolean {
  const initial = useRef<ReadonlySet<string> | null>(null);
  if (initial.current === null && keys !== null) initial.current = new Set(keys);
  const base = initial.current;
  return (key) => base !== null && !base.has(key);
}
