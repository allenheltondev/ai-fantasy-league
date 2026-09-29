import { useLeagueTeams } from '../routes/leagueTeams';

/**
 * A personality's avatar: its `avatarSeed` hashed into a symmetric 5x5 pattern in one of the design
 * system's tones, so the same personality always looks the same without shipping images.
 */

const TONES = [
  'bg-primary-100 text-primary-700',
  'bg-success-100 text-success-700',
  'bg-warning-100 text-warning-700',
  'bg-error-100 text-error-700',
  'bg-secondary-100 text-secondary-700'
] as const;

/** FNV-1a, 32-bit. */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Filled cells of the 5x5 grid: 15 bits cover the left three columns, mirrored to the right. */
export function avatarCells(seed: string): { x: number; y: number }[] {
  const hash = hashSeed(seed);
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if ((hash >>> (y * 3 + x)) & 1) {
        cells.push({ x, y });
        if (x < 2) cells.push({ x: 4 - x, y });
      }
    }
  }
  return cells;
}

export function AgentAvatar({ seed, label, size = 48 }: { seed: string; label: string; size?: number }) {
  const tone = TONES[hashSeed(seed) % TONES.length];
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="-1 -1 7 7"
      width={size}
      height={size}
      className={`shrink-0 rounded-lg ${tone}`}
    >
      {avatarCells(seed).map(({ x, y }) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="currentColor" />
      ))}
    </svg>
  );
}

/**
 * Who manages a team, for lists (standings, matchups, the draft): an AI manager's avatar and name
 * (#159), with its personality as a tooltip; or, given `teamId`, a person's team avatar (#178) and
 * their name once they have picked one. Renders nothing otherwise.
 */
export function ManagerTag({
  manager,
  teamId,
  size = 20,
  className = ''
}: {
  manager: { name: string; avatarSeed: string; personality?: string | null } | null | undefined;
  teamId?: string;
  size?: number;
  className?: string;
}) {
  const person = useLeagueTeams().find((t) => t.id === teamId);
  const shown =
    manager ??
    (person?.avatarSeed && person.ownerName
      ? { name: person.ownerName, avatarSeed: person.avatarSeed }
      : null);
  if (shown === null) return null;
  const personality = manager?.personality;
  return (
    <span
      data-testid="manager-tag"
      className={`inline-flex min-w-0 max-w-full items-center gap-1 text-xs font-normal text-muted-foreground ${className}`}
      title={personality ?? undefined}
    >
      <AgentAvatar seed={shown.avatarSeed} label={`${shown.name} avatar`} size={size} />
      <span className="truncate">{shown.name}</span>
    </span>
  );
}
