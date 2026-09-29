import { AgentAvatar, hashSeed } from '../components/AgentAvatar';
import type { Manager } from '../api/types';
import { useTeamAvatarSeed } from '../routes/leagueTeams';
import { positionTone } from './board';

/** A position label in its board color: QB red, RB green, WR blue, TE orange, K and DEF gray. */
export function PositionChip({ position, className = '' }: { position: string; className?: string }) {
  return (
    <span
      data-position={position}
      className={`inline-flex min-w-[2.25rem] shrink-0 justify-center rounded px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-none ${positionTone(position).chip} ${className}`}
    >
      {position}
    </span>
  );
}

const INITIAL_TONES = [
  'bg-primary-100 text-primary-800',
  'bg-success-100 text-success-800',
  'bg-warning-100 text-warning-800',
  'bg-error-100 text-error-800',
  'bg-secondary-100 text-secondary-800'
] as const;

function initials(name: string): string {
  const words = name
    .replace(/[’']s\b/g, '')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  return (
    words
      .slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase())
      .join('') || '?'
  );
}

/**
 * A team's mark: its AI manager's avatar (#161), the avatar its person picked (#178), or its
 * initials in a tone of its own. Decorative next to the team's name, so it is hidden from screen readers.
 */
export function TeamMark({
  teamId,
  teamName,
  manager,
  size = 20
}: {
  teamId: string;
  teamName: string;
  manager?: Manager | null;
  size?: number;
}) {
  const picked = useTeamAvatarSeed(teamId);
  if (manager !== null && manager !== undefined) {
    return (
      <span aria-hidden="true" className="inline-flex shrink-0" title={manager.name}>
        <AgentAvatar seed={manager.avatarSeed} label={`${manager.name} avatar`} size={size} />
      </span>
    );
  }
  if (picked !== null) {
    return (
      <span aria-hidden="true" className="inline-flex shrink-0" title={teamName}>
        <AgentAvatar seed={picked} label={`${teamName} avatar`} size={size} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-testid="team-initials"
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-semibold ${INITIAL_TONES[hashSeed(teamId) % INITIAL_TONES.length]}`}
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.42)) }}
    >
      {initials(teamName)}
    </span>
  );
}
