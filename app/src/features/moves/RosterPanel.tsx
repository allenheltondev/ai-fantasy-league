import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, StatusBadge } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { Roster, RosterEntry, WaiverClaim } from '../../api/types';
import { gameContext } from '../season/gameState';
import { placementOf, seats, statusLabel, willPlay } from '../season/slots';
import { canMoveToIr, dropCandidates, moveErrorText, pts, slotPosition, waiverTime } from './moves';

export interface RosterPanelProps {
  leagueId: string;
  roster: Roster;
  claims: WaiverClaim[];
  waiverType: 'faab' | 'rolling';
  /** When a player dropped now clears waivers. */
  dropClearsAt: string | null;
  canDrop: boolean;
  canSetLineup: boolean;
  canEditClaims: boolean;
  tradeHref: (entry: RosterEntry) => string;
  /** Opens the market, filtered to a position ('' for all). */
  onFind: (position: string) => void;
  /** A move went through: say so and read everything again. */
  onChanged: (message: string) => void;
}

/**
 * Your roster (#205): starters by slot, pending claims, the bench, and IR, each player with his
 * game, injury, projection this week, and season average. A player opens his moves in place: Drop
 * (confirmed, with when he clears waivers), IR in or out, and Trade. Locked players say so and
 * cannot be dropped.
 */
export function RosterPanel(props: RosterPanelProps) {
  const { roster } = props;
  const [open, setOpen] = useState<string | null>(null);
  const bench = roster.players.filter((p) => p.slot === 'BN');
  const ir = roster.players.filter((p) => p.slot === 'IR');
  const irRoom = roster.slots.find((s) => s.slot === 'IR')?.count ?? 0;
  const rowProps = { ...props, open, setOpen };
  return (
    <section aria-labelledby="roster-title" className="rounded-lg border border-border bg-surface">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-3 py-2">
        <h2 id="roster-title" className="text-lg font-semibold">
          Your roster
        </h2>
        <span className="text-sm text-muted-foreground">
          Week {roster.week}
          {roster.projectedPoints !== undefined && ` · projected ${roster.projectedPoints.toFixed(1)}`}
        </span>
      </header>
      <Group title="Starters">
        {seats(roster.players, roster.slots, placementOf(roster.players)).map((seat) =>
          seat.entry === null ? (
            <li key={seat.key} className="flex items-center gap-2 px-2 sm:px-3">
              <SlotTag slot={seat.slot} />
              <button
                type="button"
                onClick={() => props.onFind(slotPosition(seat.slot))}
                className="my-1.5 flex min-h-11 flex-1 items-center rounded-md border border-dashed border-border px-3 text-left text-sm text-muted-foreground hover:border-primary-300 hover:text-primary-700"
              >
                Empty {seat.slot}: find a player
              </button>
            </li>
          ) : (
            <PlayerRow key={seat.key} entry={seat.entry} slot={seat.slot} {...rowProps} />
          )
        )}
      </Group>
      <PendingClaims {...props} />
      <Group title={`Bench (${bench.length})`}>
        {bench.map((entry) => (
          <PlayerRow key={entry.player.id} entry={entry} slot="BN" {...rowProps} />
        ))}
        {bench.length === 0 && (
          <li className="px-3 py-3 text-sm text-muted-foreground">Nobody on the bench.</li>
        )}
      </Group>
      {irRoom > 0 && (
        <Group title={`IR (${ir.length}/${irRoom})`}>
          {ir.map((entry) => (
            <PlayerRow key={entry.player.id} entry={entry} slot="IR" {...rowProps} />
          ))}
          {ir.length === 0 && (
            <li className="px-3 py-3 text-sm text-muted-foreground">
              Out or IR players can rest here without using a spot.
            </li>
          )}
        </Group>
      )}
    </section>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="bg-muted px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <ul aria-label={title.replace(/ \(.*\)$/, '')} className="divide-y divide-border">
        {children}
      </ul>
    </div>
  );
}

function SlotTag({ slot }: { slot: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex w-11 shrink-0 justify-center font-mono text-xs font-semibold text-muted-foreground"
    >
      {slot}
    </span>
  );
}

function PlayerRow(
  props: RosterPanelProps & {
    entry: RosterEntry;
    slot: string;
    open: string | null;
    setOpen: (id: string | null) => void;
  }
) {
  const { entry } = props;
  const id = entry.player.id;
  const expanded = props.open === id;
  const status = statusLabel(entry);
  return (
    <li data-testid={`roster-row-${id}`}>
      <div className="flex items-center gap-2 px-2 sm:px-3">
        <SlotTag slot={props.slot} />
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${entry.player.name}, ${props.slot}${entry.locked ? ', locked' : ''}: moves`}
          onClick={() => props.setOpen(expanded ? null : id)}
          className="flex min-h-14 min-w-0 flex-1 items-center gap-2 rounded-md py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">
              {entry.player.name}{' '}
              <span className="text-xs font-normal text-muted-foreground">
                {entry.player.position} · {entry.player.team ?? 'FA'}
              </span>
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              {!entry.onBye && <span>{gameContext(entry)}</span>}
              {entry.locked && <StatusBadge tone="neutral">Locked</StatusBadge>}
              {status !== null && (
                <StatusBadge tone={entry.onBye || willPlay(entry) ? 'warning' : 'error'}>
                  {status}
                </StatusBadge>
              )}
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end text-right tabular-nums">
            <span className="text-base font-semibold">
              <span className="sr-only">Projected </span>
              {pts(entry.projectedPoints)}
            </span>
            <span className="text-[0.7rem] text-muted-foreground">
              <span aria-hidden="true">avg </span>
              <span className="sr-only">Season average </span>
              {pts(entry.seasonAverage?.average)}
            </span>
          </span>
        </button>
      </div>
      {expanded && <RowMoves {...props} />}
    </li>
  );
}

/** A player's moves, in place under his row. */
function RowMoves(props: RosterPanelProps & { entry: RosterEntry; setOpen: (id: string | null) => void }) {
  const { entry, leagueId, roster } = props;
  const api = useLeagueApi();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = entry.player.name;
  const run = (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setProblem(null);
    action().then(
      () => {
        props.setOpen(null);
        props.onChanged(message);
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(moveErrorText(e, { player: name, drop: name }));
      }
    );
  };
  const lineup = (slot: string) => () =>
    api.setLineup(leagueId, roster.teamId, roster.week, [{ playerId: entry.player.id, slot }]);
  const clears =
    props.dropClearsAt === null
      ? 'He becomes a free agent right away.'
      : `He goes to waivers until ${waiverTime(props.dropClearsAt)}.`;

  if (confirming) {
    return (
      <div
        role="group"
        aria-label={`Drop ${name}?`}
        className="motion-pop mx-2 mb-2 space-y-2 rounded-lg border border-error-600 bg-error-50 p-3 text-sm sm:mx-3"
      >
        <p>
          <strong>Drop {name}?</strong> {clears}
        </p>
        {problem !== null && (
          <p role="alert" className="font-medium text-error-700">
            {problem}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            variant="error"
            size="sm"
            className="min-h-11"
            loading={busy}
            onClick={() => run(() => api.dropPlayer(leagueId, entry.player.id), `Dropped ${name}. ${clears}`)}
          >
            Drop {name}
          </Button>
          <Button variant="ghost" size="sm" className="min-h-11" onClick={() => setConfirming(false)}>
            Keep him
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div
      className="mx-2 mb-2 space-y-2 rounded-lg border border-border bg-muted p-2 sm:mx-3"
      data-testid={`moves-${entry.player.id}`}
    >
      {entry.locked && (
        <p className="px-1 text-sm">
          His game has started: he is locked until the week rolls over, so he cannot be dropped or moved.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!entry.locked && (
          <Button
            variant="secondary"
            size="sm"
            className="min-h-11"
            disabled={!props.canDrop}
            onClick={() => setConfirming(true)}
          >
            Drop
          </Button>
        )}
        {!entry.locked && props.canSetLineup && entry.slot !== 'IR' && canMoveToIr(roster, entry) && (
          <Button
            variant="secondary"
            size="sm"
            className="min-h-11"
            loading={busy}
            onClick={() => run(lineup('IR'), `Moved ${name} to IR.`)}
          >
            Move to IR
          </Button>
        )}
        {!entry.locked && props.canSetLineup && entry.slot === 'IR' && (
          <Button
            variant="secondary"
            size="sm"
            className="min-h-11"
            loading={busy}
            onClick={() => run(lineup('BN'), `Activated ${name} to your bench.`)}
          >
            Activate
          </Button>
        )}
        <Link to={props.tradeHref(entry)} className="btn btn-ghost inline-flex min-h-11 items-center">
          Trade {name.split(' ')[0]}
        </Link>
      </div>
      {problem !== null && (
        <p role="alert" className="px-1 text-sm font-medium text-error-700">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * Pending claims (#205), inline where they will change the roster: "Claiming X, dropping Y · $12
 * · processes Wed 3:00 AM". Each can change its bid or drop, be cancelled, or move up or down the
 * order the team's claims are tried in.
 */
function PendingClaims(props: RosterPanelProps) {
  const { claims } = props;
  const api = useLeagueApi();
  const [editing, setEditing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (claims.length === 0) return null;
  const act = (action: Promise<unknown>, message: string, names: { player: string; drop: string | null }) => {
    setProblem(null);
    action.then(
      () => {
        setEditing(null);
        props.onChanged(message);
      },
      (e: unknown) => setProblem(moveErrorText(e, names))
    );
  };
  const move = (index: number, by: number) => {
    const ids = claims.map((c) => c.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + by, 0, id as string);
    act(api.reorderClaims(props.leagueId, ids), 'Claim order saved.', { player: '', drop: null });
  };
  return (
    <div data-testid="pending-claims">
      <h3 className="bg-warning-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-warning-800">
        Pending claims ({claims.length})
      </h3>
      <p className="px-3 pt-2 text-xs text-muted-foreground">
        {props.waiverType === 'faab'
          ? 'Highest bid wins each player. Yours are tried top to bottom when two need the same drop.'
          : 'Claims go by waiver priority, tried top to bottom.'}
      </p>
      {problem !== null && (
        <p role="alert" className="px-3 pt-2 text-sm font-medium text-error-700">
          {problem}
        </p>
      )}
      <ol aria-label="Pending claims" className="divide-y divide-border">
        {claims.map((claim, index) => (
          <li key={claim.id} className="px-3 py-2" data-testid={`claim-${claim.id}`}>
            <div className="flex items-start gap-2">
              <span className="w-5 shrink-0 pt-0.5 text-sm font-semibold tabular-nums text-muted-foreground">
                {index + 1}.
              </span>
              <p className="min-w-0 flex-1 text-sm">
                Claiming <strong>{claim.player.name}</strong>
                {claim.drop !== null && (
                  <>
                    , dropping <strong>{claim.drop.name}</strong>
                  </>
                )}
                <span className="text-muted-foreground">
                  {props.waiverType === 'faab' && ` · $${claim.bid} bid`} · processes{' '}
                  {waiverTime(claim.processesAt)}
                </span>
              </p>
            </div>
            {editing === claim.id ? (
              <ClaimEditor
                claim={claim}
                roster={props.roster}
                faab={props.waiverType === 'faab'}
                onCancel={() => setEditing(null)}
                onSave={(changes) =>
                  act(
                    api.updateClaim(props.leagueId, claim.id, changes),
                    `Claim for ${claim.player.name} updated.`,
                    {
                      player: claim.player.name,
                      drop:
                        props.roster.players.find((p) => p.player.id === changes.dropPlayerId)?.player.name ??
                        null
                    }
                  )
                }
              />
            ) : (
              props.canEditClaims && (
                <div className="mt-1 flex flex-wrap gap-1 pl-7">
                  <Button variant="ghost" size="sm" className="min-h-11" onClick={() => setEditing(claim.id)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-11"
                    aria-label={`Cancel claim for ${claim.player.name}`}
                    onClick={() =>
                      act(
                        api.cancelClaim(props.leagueId, claim.id),
                        `Claim for ${claim.player.name} cancelled.`,
                        { player: claim.player.name, drop: null }
                      )
                    }
                  >
                    Cancel claim
                  </Button>
                  {claims.length > 1 && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-11 min-w-11"
                        disabled={index === 0}
                        aria-label={`Move ${claim.player.name} up`}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-11 min-w-11"
                        disabled={index === claims.length - 1}
                        aria-label={`Move ${claim.player.name} down`}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </Button>
                    </>
                  )}
                </div>
              )
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ClaimEditor(props: {
  claim: WaiverClaim;
  roster: Roster;
  faab: boolean;
  onCancel: () => void;
  onSave: (changes: { bid?: number; dropPlayerId?: string; clearDrop?: boolean }) => void;
}) {
  const [bid, setBid] = useState(String(props.claim.bid));
  const [drop, setDrop] = useState(props.claim.drop?.id ?? '');
  const save = () =>
    props.onSave({
      ...(props.faab ? { bid: Math.max(0, Math.floor(Number(bid) || 0)) } : {}),
      ...(drop === '' ? { clearDrop: true } : { dropPlayerId: drop })
    });
  return (
    <div
      className="mt-2 space-y-2 rounded-lg border border-border bg-muted p-2 pl-7"
      role="group"
      aria-label={`Edit claim for ${props.claim.player.name}`}
    >
      <div className="flex flex-wrap gap-3">
        {props.faab && (
          <label className="flex flex-col text-sm">
            Bid ($)
            <input
              className="input min-h-11 w-24"
              type="number"
              inputMode="numeric"
              min={0}
              value={bid}
              onChange={(e) => setBid(e.target.value)}
            />
          </label>
        )}
        <label className="flex min-w-0 flex-1 flex-col text-sm">
          Drop
          <select className="input min-h-11" value={drop} onChange={(e) => setDrop(e.target.value)}>
            <option value="">Nobody</option>
            {dropCandidates(props.roster).map((e) => (
              <option key={e.player.id} value={e.player.id} disabled={e.locked}>
                {e.player.name} ({e.player.position}){e.locked ? ' · locked' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" className="min-h-11" onClick={save}>
          Save claim
        </Button>
        <Button variant="ghost" size="sm" className="min-h-11" onClick={props.onCancel}>
          Keep as is
        </Button>
      </div>
    </div>
  );
}
