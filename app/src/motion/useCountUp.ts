import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from './reducedMotion';

/** Fast out, soft landing: the number settles instead of stopping dead. */
export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/**
 * Eases a displayed number from its last value to `target` over `durationMs`, counting up or down.
 * The first render shows `target` as is (no animation on first paint), and under reduced motion
 * every change jumps straight to the new value.
 */
export function useCountUp(target: number, durationMs = 700): number {
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState(target);
  const shown = useRef(target);

  useEffect(() => {
    const from = shown.current;
    if (from === target) return undefined;
    if (reduced) {
      shown.current = target;
      setValue(target);
      return undefined;
    }
    let frame = 0;
    let start: number | null = null;
    const step = (now: number) => {
      start ??= now;
      const t = Math.min(1, (now - start) / durationMs);
      const next = t >= 1 ? target : from + (target - from) * easeOutCubic(t);
      shown.current = next;
      setValue(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, reduced, durationMs]);

  return value;
}
