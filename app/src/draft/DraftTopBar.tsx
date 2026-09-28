import { Button, StatusBadge } from '@readysetcloud/ui';
import { ConfirmButton } from '../components/ConfirmButton';
import { formatClock, roundPick, type DraftBoard } from './board';
import { TeamMark } from './marks';

const STATUS = {
  in_progress: { tone: 'success', label: 'Live' },
  paused: { tone: 'warning', label: 'Paused' },
  complete: { tone: 'neutral', label: 'Complete' }
} as const;

/** Under this many seconds on your own clock, the clock itself pulses. */
export const URGENT_SECONDS = 10;

export interface DraftTopBarProps {
  board: DraftBoard;
  /** Seconds left on the clock, or null when nobody is on it. */
  seconds: number | null;
  yourTurn: boolean;
  /** "Updating live" or "Refreshing every 3s". */
  updates: string;
  live: boolean;
  sound: { enabled: boolean; toggle(): void };
  /** Commissioner controls, when you may pause or resume. */
  commissioner: { busy: boolean; onPause(): void; onResume(): void } | null;
}

/**
 * The draft room's top bar: who is on the clock and the countdown, round and pick, your next pick,
 * the draft's status, and (for the commissioner) pause and resume. Sticky on a phone.
 */
export function DraftTopBar({
  board,
  seconds,
  yourTurn,
  updates,
  live,
  sound,
  commissioner
}: DraftTopBarProps) {
  const clock = board.onTheClock;
  const team = clock === null ? undefined : board.order.find((t) => t.teamId === clock.teamId);
  const next = board.yourNextPick;
  const urgent = yourTurn && board.status === 'in_progress' && seconds !== null && seconds <= URGENT_SECONDS;
  return (
    <header
      data-testid="draft-topbar"
      aria-label="Draft clock"
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2 ${
        yourTurn ? 'motion-attention border-primary-500 bg-primary-50' : 'border-border bg-surface'
      }`}
    >
      {clock === null ? (
        <p className="font-semibold">
          {board.status === 'complete'
            ? 'The draft is complete. Good luck this season!'
            : 'Waiting for the next pick.'}
        </p>
      ) : (
        <div className="flex min-w-0 items-center gap-3">
          <span
            data-testid="pick-clock"
            role="timer"
            aria-label="Pick clock"
            className={`font-mono text-2xl font-bold tabular-nums ${urgent ? 'motion-urgent text-error-700' : yourTurn ? 'text-primary-800' : ''}`}
          >
            {formatClock(seconds ?? 0)}
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="flex min-w-0 items-center gap-1.5">
              {team !== undefined && (
                <TeamMark teamId={team.teamId} teamName={team.teamName} manager={team.manager} size={20} />
              )}
              <span className="truncate" data-testid="on-the-clock">
                {yourTurn ? (
                  <strong>You are on the clock!</strong>
                ) : (
                  <>
                    <strong>{clock.teamName}</strong> is on the clock
                  </>
                )}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              Round {clock.round}, pick {clock.pick} · #{clock.overall} overall (
              {roundPick(clock.round, clock.pick)})
            </span>
          </span>
        </div>
      )}
      {!yourTurn && next !== null && clock !== null && (
        <p data-testid="your-next-pick" className="text-sm">
          <span className="text-muted-foreground">Your pick </span>
          <strong>#{next.overall}</strong>{' '}
          <span className="text-muted-foreground">
            in {next.picksAway} pick{next.picksAway === 1 ? '' : 's'}
          </span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
        <StatusBadge tone={STATUS[board.status].tone}>{STATUS[board.status].label}</StatusBadge>
        {board.status === 'paused' && (
          <span className="text-xs text-muted-foreground">
            The commissioner paused the draft. The clock is frozen.
          </span>
        )}
        <span
          className="hidden items-center gap-1 text-xs text-muted-foreground lg:flex"
          data-testid="draft-updates"
        >
          {live && <span className="motion-live-dot" aria-hidden="true" />}
          {updates}
        </span>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={sound.enabled}
          onClick={sound.toggle}
          title={sound.enabled ? 'Mute the your-turn chime' : 'Play a chime when you are up'}
          className="lg:min-h-0 lg:py-0.5"
        >
          {sound.enabled ? 'Sound on' : 'Sound off'}
        </Button>
        {commissioner !== null && board.status === 'in_progress' && (
          <ConfirmButton
            label="Pause draft"
            title="Pause the draft?"
            message="The pick clock freezes for everyone and nobody can pick until you resume. The team on the clock keeps the time it has left."
            confirmLabel="Pause draft"
            disabled={commissioner.busy}
            onConfirm={commissioner.onPause}
          />
        )}
        {commissioner !== null && board.status === 'paused' && (
          <Button size="sm" loading={commissioner.busy} onClick={commissioner.onResume}>
            Resume draft
          </Button>
        )}
      </div>
    </header>
  );
}
