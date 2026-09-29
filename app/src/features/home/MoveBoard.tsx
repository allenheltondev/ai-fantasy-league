import { Link } from 'react-router';
import { Button, Card, CardBody, CardHeader, CardTitle } from '@readysetcloud/ui';
import type { Move, MoveSide, MoveType, PlayerRef } from '../../api/types';
import { useArrivals } from '../../motion/useArrivals';
import { leagueTabPath } from '../../routes/leagueRoutes';
import { managerName, TeamAvatar } from './TeamBadge';
import { PlayerLink } from '../../players/PlayerLink';

/**
 * The move board (#166): the league's trades, pickups, drops, and waiver awards, one card per move,
 * and team renames (#194): "Team 3 is now Regression to the Mean".
 */

const LABELS: Record<MoveType, string> = {
  trade: 'Trade',
  add: 'Free-agent add',
  drop: 'Drop',
  waiver: 'Waiver claim',
  team_renamed: 'New team name'
};

/** Icon tile colours per move type (literal class names, so Tailwind keeps them). */
const TONES: Record<MoveType, string> = {
  trade: 'bg-primary-100 text-primary-700',
  add: 'bg-success-100 text-success-700',
  drop: 'bg-error-100 text-error-700',
  waiver: 'bg-warning-100 text-warning-700',
  team_renamed: 'bg-secondary-100 text-secondary-700'
};

const PATHS: Record<MoveType, string> = {
  // Two arrows passing each other.
  trade: 'M7 7h11l-3-3m3 3-3 3M17 17H6l3 3m-3-3 3-3',
  add: 'M12 5v14M5 12h14',
  drop: 'M5 12h14',
  // A gavel.
  waiver: 'm14 5 5 5m-7-3 5 5m-9 2 6-6m-9 9 5-5m-2 7h8',
  // A name tag.
  team_renamed: 'M3 12V4h8l10 10-8 8L3 12zM7.5 7.5h.01'
};

export function MoveIcon({ type }: { type: MoveType }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${TONES[type]}`}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={PATHS[type]} />
      </svg>
    </span>
  );
}

/** "Week 3 · Sep 21". */
export function moveWhen(move: Pick<Move, 'at' | 'week'>): string {
  const day = new Date(move.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `Week ${move.week} · ${day}`;
}

function PlayerChip({ player, tone }: { player: PlayerRef; tone: 'in' | 'out' }) {
  return (
    <li
      className={`inline-flex max-w-full flex-wrap items-baseline gap-x-1 rounded-md px-2 py-0.5 text-sm ${
        tone === 'in' ? 'bg-success-50' : 'bg-error-50 line-through decoration-error-400'
      }`}
    >
      <span className="sr-only">{tone === 'in' ? 'In: ' : 'Out: '}</span>
      <PlayerLink player={player} className="break-words font-medium" />
      <span className="text-xs text-muted-foreground">
        {player.position}
        {player.team === null ? '' : ` · ${player.team}`}
      </span>
    </li>
  );
}

function Players({ players, tone, label }: { players: PlayerRef[]; tone: 'in' | 'out'; label: string }) {
  if (players.length === 0) return null;
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1">
      {players.map((p) => (
        <PlayerChip key={p.id} player={p} tone={tone} />
      ))}
    </ul>
  );
}

function SideSummary({ side, you, verb }: { side: MoveSide; you: boolean; verb: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="flex min-w-0 items-center gap-2">
        <TeamAvatar team={side} size={24} />
        <span className="min-w-0">
          <span className="block truncate font-medium">
            {side.teamName}
            {you && <span className="ml-1 text-xs font-normal text-primary-700">(you)</span>}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{managerName(side)}</span>
        </span>
      </p>
      <Players players={side.added} tone="in" label={`${side.teamName} ${verb}`} />
      <Players players={side.dropped} tone="out" label={`${side.teamName} drops`} />
    </div>
  );
}

/** Who renamed a team, as the card says it. */
const RENAMED_BY = {
  owner: 'its manager',
  commissioner: 'the commissioner',
  agent: 'its AI manager'
} as const;

function RenameSummary({
  side,
  rename,
  you
}: {
  side: MoveSide;
  rename: NonNullable<Move['rename']>;
  you: boolean;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="flex min-w-0 items-center gap-2">
        <TeamAvatar team={side} size={24} />
        <span className="min-w-0">
          <span className="block break-words font-medium">
            {rename.to}
            {you && <span className="ml-1 text-xs font-normal text-primary-700">(you)</span>}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{managerName(side)}</span>
        </span>
      </p>
      <p className="break-words text-sm text-muted-foreground" data-testid="renamed-from">
        Renamed from <span className="line-through decoration-muted-foreground">{rename.from}</span> by{' '}
        {RENAMED_BY[rename.by]}
      </p>
    </div>
  );
}

export function MoveCard({ move, yourTeamId }: { move: Move; yourTeamId: string | null }) {
  const [first] = move.teams;
  const cost = first?.cost ?? null;
  const verb = move.type === 'trade' ? 'gets' : move.type === 'waiver' ? 'wins' : 'adds';
  return (
    <article
      data-testid={`move-${move.type}`}
      aria-label={
        move.rename
          ? `${LABELS[move.type]}: ${move.rename.from} is now ${move.rename.to}`
          : `${LABELS[move.type]}: ${move.teams.map((t) => t.teamName).join(' and ')}`
      }
      className={`flex gap-3 rounded-lg border p-3 ${
        move.teams.some((t) => t.teamId === yourTeamId) ? 'border-primary-200 bg-primary-50' : 'border-border'
      }`}
    >
      <MoveIcon type={move.type} />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
          <span className="font-semibold">
            {LABELS[move.type]}
            {move.type === 'waiver' && cost !== null && (
              <span className="ml-2 rounded bg-warning-100 px-1.5 py-0.5 text-xs font-semibold text-warning-800">
                ${cost} FAAB
              </span>
            )}
          </span>
          <span className="text-xs text-muted-foreground">{moveWhen(move)}</span>
        </p>
        <div className={move.teams.length > 1 ? 'grid gap-3 sm:grid-cols-2' : undefined}>
          {move.teams.map((side) =>
            move.rename ? (
              <RenameSummary
                key={side.teamId}
                side={side}
                rename={move.rename}
                you={side.teamId === yourTeamId}
              />
            ) : (
              <SideSummary key={side.teamId} side={side} you={side.teamId === yourTeamId} verb={verb} />
            )
          )}
        </div>
      </div>
    </article>
  );
}

/** Moves added per "Show more"; the dashboard serves at most `MAX_MOVES`. */
export const MOVES_PAGE = 8;
export const MORE_MOVES = 10;
export const MAX_MOVES = 50;

export function MoveBoard({
  leagueId,
  moves,
  hasMore,
  yourTeamId,
  loadingMore,
  onShowMore
}: {
  leagueId: string;
  moves: Move[];
  hasMore: boolean;
  yourTeamId: string | null;
  loadingMore: boolean;
  onShowMore: () => void;
}) {
  const arrived = useArrivals(moves.map((m) => m.id));
  return (
    <Card role="region" aria-label="Move board">
      <CardHeader>
        <CardTitle>Move board</CardTitle>
        <p className="text-sm text-muted-foreground">
          Trades, pickups, drops, waiver awards, and new team names.
        </p>
      </CardHeader>
      <CardBody className="space-y-3">
        {moves.length === 0 ? (
          <p className="text-muted-foreground">
            No moves yet. Trades and pickups show up here as they happen.
          </p>
        ) : (
          <ol aria-label="Latest moves" className="space-y-2">
            {moves.map((move) => (
              <li key={move.id} className={arrived(move.id) ? 'motion-pop' : undefined}>
                <MoveCard move={move} yourTeamId={yourTeamId} />
              </li>
            ))}
          </ol>
        )}
        {hasMore &&
          (moves.length < MAX_MOVES ? (
            <Button
              variant="secondary"
              size="sm"
              className="min-h-11"
              loading={loadingMore}
              onClick={onShowMore}
            >
              Show more
            </Button>
          ) : (
            <Link
              to={leagueTabPath(leagueId, 'transactions')}
              className="inline-flex min-h-11 items-center text-sm font-medium text-primary-700 hover:underline"
            >
              See every transaction
            </Link>
          ))}
      </CardBody>
    </Card>
  );
}
