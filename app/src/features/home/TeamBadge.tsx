import type { DashboardTeam } from '../../api/types';
import { AgentAvatar, hashSeed } from '../../components/AgentAvatar';
import { useTeamAvatarSeed } from '../../routes/leagueTeams';

/** Who plays a team, for the dashboard (#166): the person, the AI manager, or an open seat. */
export function managerName(team: DashboardTeam): string {
  return team.manager?.name ?? team.ownerName ?? 'Open seat';
}

/** Up to two initials from a name: "Alice Smith" → "AS", "bob" → "B". */
export function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter((word) => /\p{L}|\p{N}/u.test(word))
    .slice(0, 2)
    .map((word) => (word.match(/\p{L}|\p{N}/u) as RegExpMatchArray)[0].toUpperCase());
  return letters.length === 0 ? '?' : letters.join('');
}

const TONES = [
  'bg-primary-100 text-primary-800',
  'bg-success-100 text-success-800',
  'bg-warning-100 text-warning-800',
  'bg-secondary-100 text-secondary-800'
] as const;

/**
 * A team's picture: an AI manager's avatar (#159), the avatar a person picked for their team (#178),
 * or their initials in a tone picked from the team id, so the same team always looks the same.
 */
export function TeamAvatar({ team, size = 32 }: { team: DashboardTeam; size?: number }) {
  const picked = useTeamAvatarSeed(team.teamId);
  if (team.manager !== null) {
    return <AgentAvatar seed={team.manager.avatarSeed} label={`${team.manager.name} avatar`} size={size} />;
  }
  if (picked !== null) {
    return <AgentAvatar seed={picked} label={`${team.teamName} avatar`} size={size} />;
  }
  const tone = TONES[hashSeed(team.teamId) % TONES.length];
  return (
    <span
      aria-hidden="true"
      data-testid="initials-avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${tone}`}
    >
      {initials(team.ownerName ?? team.teamName)}
    </span>
  );
}
