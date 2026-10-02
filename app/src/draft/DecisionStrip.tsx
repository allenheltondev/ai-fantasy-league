import { needsFromSlots, needsLine, teamAt, type DraftBoard, type PlayerRef } from './board';
import type { DraftQueue } from './queue';

/** The decision context stays visible while browsing, comparing, or chatting. */
export function DecisionStrip({
  board,
  queue,
  onOpen
}: {
  board: DraftBoard;
  queue: DraftQueue;
  onOpen(player: PlayerRef): void;
}) {
  if (board.yourTeamId === null || board.status === 'complete') return null;
  const available = queue.players.filter((p) => !board.picks.some((pick) => pick.player.id === p.id));
  const next = board.yourNextPick?.overall;
  const following =
    next === undefined
      ? undefined
      : Array.from(
          { length: Math.max(0, board.rounds * board.order.length - next) },
          (_, i) => next + i + 1
        ).find((pick) => teamAt(board.order, pick)?.teamId === board.yourTeamId);
  const needs =
    board.yourRoster == null ? needsFromSlots(board.yourNeeds) : needsLine(board.yourRoster.starters);
  const lastPick = board.picks.at(-1);
  const lost =
    lastPick && lastPick.teamId !== board.yourTeamId && queue.has(lastPick.player.id) ? lastPick : null;
  return (
    <section
      aria-label="Your next decision"
      className="rounded-lg border border-primary-200 bg-primary-50/50 px-3 py-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
        <p>
          <strong className="text-primary-800">Your game plan</strong>
          <span className="ml-2 text-muted-foreground">
            {needs ? `Open starters: ${needs}` : 'Starting lineup filled · build your bench'}
          </span>
        </p>
        {next !== undefined && (
          <p className="text-muted-foreground">
            Pick #{next}
            {following === undefined
              ? ' · your final pick'
              : following === next + 1
                ? ` → #${following} · back-to-back picks`
                : ` → #${following} · ${following - next - 1} picks between turns`}
          </p>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5" aria-label="Queue preview">
        <span className="mr-1 text-xs text-muted-foreground">Shortlist</span>
        {available.slice(0, 3).map((player, i) => (
          <button
            key={player.id}
            type="button"
            onClick={() => onOpen(player)}
            className="rounded-md border border-border bg-surface px-2 py-1 text-xs hover:border-primary-400"
            aria-label={`Research queued player ${player.name}`}
          >
            <span className="mr-1.5 text-muted-foreground">{i + 1}.</span>
            {player.name}
            <span className="ml-1.5 text-muted-foreground">{player.position}</span>
          </button>
        ))}
        {available.length === 0 && (
          <span className="text-xs text-muted-foreground">
            Add a few favorites with ＋. Your backup plan starts here.
          </span>
        )}
        {available.length > 3 && (
          <span className="text-xs text-muted-foreground">+{available.length - 3} more</span>
        )}
      </div>
      {lost && (
        <p role="status" className="mt-1 text-xs text-primary-800">
          {lost.player.name} went to{' '}
          {board.order.find((team) => team.teamId === lost.teamId)?.teamName ?? 'another team'}.{' '}
          {available[0]
            ? `${available[0].name} is now first in your queue.`
            : 'Your shortlist is open for a new favorite.'}
        </p>
      )}
      <p className="mt-1 text-xs text-muted-foreground" data-testid="autopick-plan">
        {!queue.ready
          ? 'Loading your saved queue…'
          : queue.saving
            ? 'Saving your queue… Autopick uses your last saved order until this finishes.'
            : queue.error !== null
              ? 'Queue changes could not be saved. Autopick uses your last saved queue.'
              : available[0]
                ? `At timeout: try ${available[0].name} if available and roster-eligible, then the next eligible queued player.`
                : 'At timeout: autopick chooses an available player that keeps your roster valid.'}
        {queue.ready && !queue.saving && queue.error !== null && (
          <>
            {' '}
            <button
              type="button"
              className="min-h-11 font-medium text-primary-800 underline md:min-h-0"
              onClick={queue.retry}
            >
              Retry save
            </button>
          </>
        )}
      </p>
    </section>
  );
}
