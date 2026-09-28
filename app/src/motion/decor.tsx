import { useEffect, type CSSProperties } from 'react';
import { Skeleton } from '@readysetcloud/ui';

/**
 * A shimmering placeholder in the shape of the content to come. The label stays readable to screen
 * readers (and to tests), and the design system's shimmer already stops under reduced motion.
 */
export function LoadingSkeleton({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="space-y-2" data-testid="loading-skeleton">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height="1.75rem" width={`${100 - (i % 3) * 12}%`} />
      ))}
    </div>
  );
}

/** A trophy mark for champions. Decorative: the text next to it says who won. */
export function Trophy({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`inline-block h-5 w-5 text-warning-500 ${className}`}
      fill="currentColor"
    >
      <path d="M7 3h10v2h3v3a4 4 0 0 1-4 4h-.35A5 5 0 0 1 13 14.9V17h3v2H8v-2h3v-2.1A5 5 0 0 1 8.35 12H8a4 4 0 0 1-4-4V5h3V3Zm0 4H6v1a2 2 0 0 0 1 1.73V7Zm10 0v2.73A2 2 0 0 0 18 8V7h-1ZM7 20h10v1H7v-1Z" />
    </svg>
  );
}

/**
 * Prefixes the tab title while `active` (it's your pick), so a manager in another tab sees it, and
 * restores the title afterwards.
 */
export function useTitleBadge(active: boolean, badge: string) {
  useEffect(() => {
    if (!active) return undefined;
    const original = document.title;
    document.title = `${badge} · ${original}`;
    return () => {
      document.title = original;
    };
  }, [active, badge]);
}

/** Staggered entrance for the first rows of a list: row `index` waits a beat longer, up to a cap. */
export function stagger(index: number): { className: string; style: CSSProperties } {
  return { className: 'motion-stagger', style: { '--motion-i': Math.min(index, 10) } as CSSProperties };
}
