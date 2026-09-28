import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function media(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null;
}

/** True when the viewer asked the OS for less motion. Read at call time (event handlers, effects). */
export function prefersReducedMotion(): boolean {
  return media()?.matches ?? false;
}

function subscribe(onChange: () => void): () => void {
  const list = media();
  list?.addEventListener('change', onChange);
  return () => list?.removeEventListener('change', onChange);
}

/**
 * `prefers-reduced-motion`, live: it re-renders when the viewer flips the OS setting. Every motion
 * primitive here checks it, so count-ups jump, confetti never renders, and transitions are instant.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion);
}
