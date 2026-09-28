import { useEffect, useRef, useState, type HTMLAttributes } from 'react';
import { useCountUp } from './useCountUp';

type Direction = 'up' | 'down';

/** Remembers the direction of the last change to `value` (null until it first changes). */
function useChange(value: number | null): { dir: Direction; n: number; delta: number } | null {
  const previous = useRef(value);
  const [change, setChange] = useState<{ dir: Direction; n: number; delta: number } | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (value === null || before === null || value === before) return;
    setChange((c) => ({ dir: value > before ? 'up' : 'down', n: (c?.n ?? 0) + 1, delta: value - before }));
  }, [value]);
  return change;
}

/**
 * A live total: counts to each new value and flashes green (up) or red (down) as it changes.
 * Tabular digits and a minimum width keep it from nudging its neighbours while it counts.
 */
export function AnimatedNumber({
  value,
  decimals = 2,
  className = '',
  ...rest
}: { value: number; decimals?: number } & HTMLAttributes<HTMLSpanElement>) {
  const shown = useCountUp(value);
  const change = useChange(value);
  // Literal class names: Tailwind keeps only the classes it can find in the source.
  const flash = change === null ? '' : change.dir === 'up' ? ' motion-flash-up' : ' motion-flash-down';
  return (
    <span
      key={change?.n ?? 0}
      {...rest}
      data-flash={change?.dir}
      className={`inline-block min-w-[6ch] rounded text-right tabular-nums${flash} ${className}`}
    >
      {shown.toFixed(decimals)}
    </span>
  );
}

const FLOAT_MS = 1400;

/**
 * "+6.0" drifting up from a player's points when they score (or "-2.0" on a correction). It is
 * absolutely positioned inside a `relative` parent, so it never moves the row; it removes itself.
 */
export function DeltaFloater({ value }: { value: number | null }) {
  const change = useChange(value);
  const [visible, setVisible] = useState<number | null>(null);
  useEffect(() => {
    if (change === null) return undefined;
    setVisible(change.n);
    const timer = setTimeout(() => setVisible(null), FLOAT_MS);
    return () => clearTimeout(timer);
  }, [change]);
  if (change === null || visible !== change.n) return null;
  return (
    <span
      key={change.n}
      aria-hidden="true"
      data-testid="delta-floater"
      className={`motion-floater pointer-events-none absolute right-0 top-0 text-xs font-semibold ${
        change.dir === 'up' ? 'text-success-700' : 'text-error-700'
      }`}
    >
      {change.delta > 0 ? '+' : ''}
      {change.delta.toFixed(1)}
    </span>
  );
}
