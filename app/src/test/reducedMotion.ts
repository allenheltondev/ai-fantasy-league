import { vi } from 'vitest';

/**
 * Stubs `matchMedia` so `prefers-reduced-motion` reads `reduced`, and lets a test flip it. Returns
 * a restore function (call it in afterEach).
 */
export function mockReducedMotion(reduced: boolean) {
  const original = window.matchMedia;
  const listeners = new Set<() => void>();
  let matches = reduced;
  window.matchMedia = vi.fn(
    (query: string) =>
      ({
        get matches() {
          return query.includes('reduce') ? matches : false;
        },
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: (_: string, l: () => void) => listeners.add(l),
        removeEventListener: (_: string, l: () => void) => listeners.delete(l),
        dispatchEvent: () => false
      }) as unknown as MediaQueryList
  );
  return {
    set(next: boolean) {
      matches = next;
      listeners.forEach((l) => l());
    },
    restore() {
      window.matchMedia = original;
    }
  };
}
