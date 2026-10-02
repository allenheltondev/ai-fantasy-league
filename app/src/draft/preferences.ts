import { useState } from 'react';

export type DraftDensity = 'essentials' | 'research';
const KEY = 'fantasy:draft-density';

export function useDraftDensity(): [DraftDensity, (density: DraftDensity) => void] {
  const [density, setDensity] = useState<DraftDensity>(() => {
    try {
      return localStorage.getItem(KEY) === 'research' ? 'research' : 'essentials';
    } catch {
      return 'essentials';
    }
  });
  return [
    density,
    (next) => {
      setDensity(next);
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* Usable even when storage is blocked. */
      }
    }
  ];
}
