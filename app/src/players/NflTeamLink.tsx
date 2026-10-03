import type { ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router';
import { nflTeamPath } from '../routes/leagueRoutes';

/**
 * An NFL team's abbreviation that goes to its page (the depth chart). A free agent shows "FA";
 * outside a league, or outside a router (a component rendered on its own), it is plain text.
 */
export function NflTeamLink({
  team,
  leagueId,
  className = '',
  onClick,
  children
}: {
  team: string | null;
  leagueId: string | null | undefined;
  className?: string;
  /** Runs before navigating, e.g. to close the drawer the link sits in. */
  onClick?: () => void;
  children?: ReactNode;
}) {
  const routed = useInRouterContext();
  const label = children ?? team ?? 'FA';
  if (team === null || !routed || leagueId === null || leagueId === undefined || leagueId === '') {
    return <span className={className}>{label}</span>;
  }
  return (
    <Link
      to={nflTeamPath(leagueId, team)}
      title={`${team} depth chart`}
      data-nfl-team-link=""
      className={`underline-offset-2 hover:underline focus-visible:underline ${className}`}
      onClick={onClick}
    >
      {label}
    </Link>
  );
}
