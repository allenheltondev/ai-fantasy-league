import { useEffect, useState } from 'react';
import type { RedZoneTeam, RosterEntry } from '../../api/types';
import './redZone.css';

/** Positions whose points come from their own team's drives. A defense scores on the other side's. */
export const RED_ZONE_POSITIONS: readonly string[] = ['QB', 'RB', 'WR', 'TE', 'K'];

/** The red-zone drive a player's NFL team is on, or null (not an offensive position, or no drive). */
export function redZoneFor(
  entry: Pick<RosterEntry, 'player'>,
  redZone: readonly RedZoneTeam[]
): RedZoneTeam | null {
  const { team, position } = entry.player;
  if (team === null || !RED_ZONE_POSITIONS.includes(position)) return null;
  return redZone.find((r) => r.team === team) ?? null;
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** Whether the viewer asked for less motion, following changes to the setting. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(REDUCED_MOTION).matches);
  useEffect(() => {
    const query = window.matchMedia(REDUCED_MOTION);
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Classes for a red-zone row or card: the static highlight, plus the pulse unless motion is reduced. */
export function redZoneClass(base: 'red-zone-row' | 'red-zone-card', reducedMotion: boolean): string {
  return reducedMotion ? base : `${base} red-zone-pulse`;
}

/**
 * "Red zone · 2nd & 4 at DAL 7": the text says it, so the highlight never relies on color alone,
 * and screen readers read it with the row.
 */
export function RedZoneChip({ zone, className = 'ml-2' }: { zone: RedZoneTeam; className?: string }) {
  return (
    <span
      data-testid="red-zone-chip"
      className={`${className} inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-error-300 bg-error-50 px-2 py-0.5 text-xs font-medium text-error-700`}
    >
      Red zone
      {zone.downDistance !== null && (
        <>
          <span aria-hidden="true">·</span>
          <span>{zone.downDistance}</span>
        </>
      )}
    </span>
  );
}
