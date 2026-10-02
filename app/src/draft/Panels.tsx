import { Alert, Button } from '@readysetcloud/ui';
import { needsFromSlots, needsLine, type DraftBoard, type PlayerRef } from './board';
import { PositionChip } from './marks';
import type { DraftQueue } from './queue';

const ROW = 'flex min-h-9 items-center gap-2 px-2 py-1';

function Name({ player, onOpen }: { player: PlayerRef; onOpen(player: PlayerRef): void }) {
  return (
    <button
      type="button"
      className="min-w-0 truncate text-left hover:underline"
      onClick={() => onOpen(player)}
    >
      {player.name}
    </button>
  );
}

/**
 * Your roster at a glance: every starting seat, filled or empty, then the bench spots, with what you
 * still need ("Open starters: 1 TE, 1 DEF, 1 K"). Falls back to a plain list of your players when the server
 * does not lay the roster out.
 */
export function RosterPanel({ board, onOpen }: { board: DraftBoard; onOpen(player: PlayerRef): void }) {
  const layout = board.yourRoster;
  if (board.yourTeamId === null) {
    return <p className="p-2 text-sm text-muted-foreground">You do not have a team in this draft.</p>;
  }
  const need = layout == null ? needsFromSlots(board.yourNeeds) : needsLine(layout.starters);
  const players = board.rosters.find((r) => r.teamId === board.yourTeamId)?.players ?? [];
  const benchOpen = layout == null ? 0 : Math.max(0, layout.benchSize - layout.bench.length);
  return (
    <div className="space-y-2 text-sm">
      <p
        data-testid="roster-needs"
        className={`rounded-md px-2 py-1.5 font-medium ${need === '' ? 'bg-success-50 text-success-800' : 'bg-muted text-foreground'}`}
      >
        {need === '' ? 'Starting lineup filled.' : `Open starters: ${need}`}
      </p>
      {layout == null ? (
        <ol aria-label="Your roster" className="divide-y divide-border">
          {players.map((p) => (
            <li key={p.id} className={ROW}>
              <PositionChip position={p.position} />
              <Name player={p} onOpen={onOpen} />
            </li>
          ))}
        </ol>
      ) : (
        <ol aria-label="Your roster" className="divide-y divide-border rounded-md border border-border">
          {layout.starters.map((seat, i) => (
            <li
              key={`s-${i}`}
              data-testid={`seat-${i}`}
              data-empty={seat.player === null ? 'true' : undefined}
              className={`${ROW} ${seat.player === null ? 'bg-muted/40' : ''}`}
            >
              <span className="w-12 shrink-0 font-mono text-xs font-semibold text-muted-foreground">
                {seat.slot}
              </span>
              {seat.player === null ? (
                <span className="text-muted-foreground">Empty</span>
              ) : (
                <>
                  <PositionChip position={seat.player.position} />
                  <Name player={seat.player} onOpen={onOpen} />
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {seat.player.team ?? 'FA'}
                  </span>
                </>
              )}
            </li>
          ))}
          {layout.bench.map((p) => (
            <li key={p.id} className={ROW}>
              <span className="w-12 shrink-0 font-mono text-xs font-semibold text-muted-foreground">BN</span>
              <PositionChip position={p.position} />
              <Name player={p} onOpen={onOpen} />
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{p.team ?? 'FA'}</span>
            </li>
          ))}
          {Array.from({ length: benchOpen }, (_, i) => (
            <li key={`b-${i}`} data-empty="true" className={`${ROW} bg-muted/40`}>
              <span className="w-12 shrink-0 font-mono text-xs font-semibold text-muted-foreground">BN</span>
              <span className="text-muted-foreground">Empty</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * Your queue, compact. Empty, it is one quiet line; the pick clock's autopick takes the first queued
 * player still available.
 */
export function QueuePanel({
  queue,
  drafted,
  canDraft,
  picking,
  onDraft,
  onOpen
}: {
  queue: DraftQueue;
  drafted: ReadonlySet<string>;
  canDraft: boolean;
  picking: string | null;
  onDraft(player: PlayerRef): void;
  onOpen(player: PlayerRef): void;
}) {
  const queued = queue.players.filter((p) => !drafted.has(p.id));
  return (
    <div className="space-y-2 text-sm">
      {queue.error !== null && (
        <Alert variant="error" role="alert">
          {queue.error}
        </Alert>
      )}
      {queued.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground" data-testid="queue-hint">
          Queue players with ＋ to line up your picks. Autopick takes the first one left.
        </p>
      ) : (
        <ol aria-label="Your queue" className="divide-y divide-border rounded-md border border-border">
          {queued.map((player, index) => (
            <li key={player.id} className={ROW}>
              <span className="w-5 shrink-0 text-right font-mono text-xs text-muted-foreground">
                {index + 1}.
              </span>
              <PositionChip position={player.position} />
              <Name player={player} onOpen={onOpen} />
              <span className="ml-auto flex shrink-0 gap-0.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() => queue.move(player.id, -1)}
                  aria-label={`Move ${player.name} up`}
                  className="min-w-11 lg:min-h-0 lg:min-w-0 lg:px-1.5 lg:py-0.5"
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => queue.remove(player.id)}
                  aria-label={`Remove ${player.name} from the queue`}
                  className="min-w-11 lg:min-h-0 lg:min-w-0 lg:px-1.5 lg:py-0.5"
                >
                  ✕
                </Button>
                <Button
                  size="sm"
                  disabled={!canDraft || picking !== null}
                  loading={picking === player.id}
                  onClick={() => onDraft(player)}
                  aria-label={`Draft ${player.name} from the queue`}
                  className="lg:min-h-0 lg:px-2 lg:py-0.5"
                >
                  Draft
                </Button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
