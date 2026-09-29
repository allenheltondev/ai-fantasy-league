import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, StatusBadge } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { ClaimPreview, ClaimResult, MarketPlayer, Roster, RosterEntry } from '../../api/types';
import { PlayerHeadshot, TeamLogo } from '../../players/PlayerHeadshot';
import { gameContext, gameText } from '../season/gameState';
import { statusLabel } from '../season/slots';
import { dropCandidates, moveErrorText, pts, roleOf, waiverTime } from './moves';

export interface AddSheetProps {
  leagueId: string;
  row: MarketPlayer;
  /** Your roster this week, for the drop step. */
  roster: Roster;
  waiverType: 'faab' | 'rolling';
  onClose: () => void;
  onDone: (result: ClaimResult, dropName: string | null) => void;
}

/**
 * The add flow (#205), without leaving the page: Add a free agent or Claim a player on waivers.
 * When the roster is full it asks who to drop (lowest value first; locked players cannot be
 * picked) and compares the two; a waiver claim takes a FAAB bid. It checks the move with
 * preview_waiver_claim as the choices change and makes it with claim_waiver.
 */
export function AddPlayerSheet({ leagueId, row, roster, waiverType, onClose, onDone }: AddSheetProps) {
  const api = useLeagueApi();
  const claim = row.availability.status === 'waivers';
  const faab = claim && waiverType === 'faab';
  const [drop, setDrop] = useState('');
  const [bid, setBid] = useState('0');
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [full, setFull] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const candidates = dropCandidates(roster);
  const dropping = candidates.find((e) => e.player.id === drop) ?? null;
  const names = { player: row.player.name, drop: dropping?.player.name ?? null };
  const bidValue = Math.max(0, Math.floor(Number(bid) || 0));

  useEffect(() => {
    let live = true;
    api
      .previewClaim(leagueId, {
        playerId: row.player.id,
        ...(drop === '' ? {} : { dropPlayerId: drop }),
        ...(faab ? { bid: bidValue } : {})
      })
      .then(
        (next) => {
          if (!live) return;
          setPreview(next);
          if (drop === '' && next.issues.some((i) => i.code === 'ROSTER_FULL')) setFull(true);
        },
        (e: unknown) => live && setProblem(moveErrorText(e, names))
      );
    return () => {
      live = false;
    };
    // `names` follows `drop`; the preview reruns when the player, the drop, or the bid change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, leagueId, row.player.id, drop, faab, bidValue]);

  const submit = () => {
    setBusy(true);
    setProblem(null);
    api
      .claimPlayer(leagueId, {
        playerId: row.player.id,
        ...(drop === '' ? {} : { dropPlayerId: drop }),
        ...(faab ? { bid: bidValue } : {})
      })
      .then(
        (result) => onDone(result, names.drop),
        (e: unknown) => {
          setBusy(false);
          setProblem(moveErrorText(e, names));
        }
      );
  };

  // ROSTER_FULL is the drop step's job; any other issue explains why the move would fail.
  const issues = (preview?.issues ?? []).filter((i) => i.code !== 'ROSTER_FULL');
  const verb = claim ? 'Claim' : 'Add';
  const ready = preview?.wouldSucceed === true && !busy && (!full || drop !== '');
  const stacked = full || drop !== '';
  return (
    <Modal
      open
      onClose={onClose}
      aria-label={`${verb} ${row.player.name}`}
      className={stacked ? 'sm:!w-[min(58rem,calc(100vw-2rem))]' : undefined}
    >
      <div className="space-y-4 p-4 sm:p-5" data-testid="add-sheet">
        <header className="flex items-center gap-3">
          <PlayerHeadshot player={row.player} size={56} eager />
          <div className="min-w-0 space-y-0.5">
            <h2 className="truncate text-lg font-semibold">
              {verb} {row.player.name}
            </h2>
            <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
              <TeamLogo team={row.player.team} size={14} />
              <span>
                {row.player.position} · {row.player.team ?? 'FA'} · {gameText(row.game)} · proj{' '}
                <strong className="text-foreground">{pts(row.projectedPoints)}</strong> · avg{' '}
                {pts(row.average)}
              </span>
            </p>
          </div>
        </header>
        {claim && row.availability.clearsAt !== undefined && (
          <p className="text-sm">
            On waivers: your claim is processed{' '}
            {waiverTime(preview?.processesAt ?? row.availability.clearsAt)}.
          </p>
        )}

        {stacked && (
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <fieldset className="min-w-0 space-y-2">
              <legend className="font-semibold">
                {full ? 'Your roster is full: pick who to drop' : 'Drop'}
              </legend>
              <p className="text-sm text-muted-foreground">Lowest projected first. Locked players stay.</p>
              <ul className="max-h-[min(22rem,45dvh)] divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {!full && (
                  <DropChoice label="Nobody" note="You have room" value="" drop={drop} onPick={setDrop} />
                )}
                {candidates.map((entry) => (
                  <DropChoice
                    key={entry.player.id}
                    entry={entry}
                    label={entry.player.name}
                    note={`${entry.player.position} · ${roleOf(entry)}`}
                    value={entry.player.id}
                    drop={drop}
                    onPick={setDrop}
                  />
                ))}
              </ul>
            </fieldset>
            <Compare row={row} drop={dropping} />
          </div>
        )}
        {!stacked && candidates[0] !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11"
            onClick={() => setDrop((candidates[0] as RosterEntry).player.id)}
          >
            Drop someone too
          </Button>
        )}

        {faab && (
          <Input
            label="FAAB bid ($)"
            type="number"
            inputMode="numeric"
            min={0}
            value={bid}
            onChange={(e) => setBid(e.target.value)}
            hint={
              preview === null
                ? undefined
                : `$${preview.faabRemaining} left; $${preview.faabAfter} if this claim wins.`
            }
          />
        )}
        {claim && !faab && (
          <p className="text-sm text-muted-foreground">
            Rolling waivers: claims go by waiver priority, no bid.
          </p>
        )}

        {issues.map((issue) => (
          <Alert key={issue.code} variant="error">
            {issue.message} {issue.fix}
          </Alert>
        ))}
        {problem !== null && (
          <Alert variant="error" role="alert">
            {problem}
          </Alert>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} className="min-h-11">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={!ready}
            loading={busy}
            loadingLabel="Saving…"
            className="min-h-11"
          >
            {claim
              ? `Place claim${faab ? ` ($${bidValue})` : ''}`
              : dropping === null
                ? 'Add player'
                : `Add, drop ${dropping.player.name}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DropChoice(props: {
  entry?: RosterEntry;
  label: string;
  note: string;
  value: string;
  drop: string;
  onPick: (id: string) => void;
}) {
  const { entry } = props;
  const locked = entry?.locked === true;
  const status = entry === undefined ? null : statusLabel(entry);
  const picked = props.drop === props.value;
  return (
    <li>
      <label
        className={`flex min-h-14 items-center gap-3 px-3 py-2 ${
          locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted'
        } ${picked ? 'bg-primary-50 ring-1 ring-inset ring-primary-400' : ''}`}
      >
        <input
          type="radio"
          name="drop"
          value={props.value}
          checked={picked}
          disabled={locked}
          onChange={() => props.onPick(props.value)}
        />
        {entry !== undefined && <PlayerHeadshot player={entry.player} size={40} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{props.label}</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {entry !== undefined && <TeamLogo team={entry.player.team} size={12} />}
            <span className="truncate">{props.note}</span>
          </span>
          {(locked || status !== null) && (
            <span className="mt-0.5 flex flex-wrap gap-1">
              {locked && <StatusBadge tone="neutral">Locked</StatusBadge>}
              {!locked && status !== null && (
                <StatusBadge tone={entry?.onBye ? 'warning' : 'error'}>{status}</StatusBadge>
              )}
            </span>
          )}
        </span>
        {entry !== undefined && (
          <span className="shrink-0 text-right tabular-nums">
            <span className="block text-base font-semibold">
              <span className="sr-only">Projected </span>
              {pts(entry.projectedPoints)}
            </span>
            <span className="block text-[0.7rem] text-muted-foreground">
              <span aria-hidden="true">avg </span>
              <span className="sr-only">Season average </span>
              {pts(entry.seasonAverage?.average)}
            </span>
          </span>
        )}
      </label>
    </li>
  );
}

/** One comparable line: what each player has, and which side wins when it is a number. */
interface CompareLine {
  label: string;
  add: string;
  out: string;
  /** Positive when the pickup is ahead, negative when the drop is, null when it is not a number. */
  edge: number | null;
}

function healthOf(status: string, injury: string | null, bye: boolean): string {
  if (bye) return 'Bye';
  return status === 'active' ? 'Healthy' : (injury ?? status.toUpperCase());
}

function edgeOf(add: number | null | undefined, out: number | null | undefined): number | null {
  return add === null || add === undefined || out === null || out === undefined ? null : add - out;
}

/**
 * The pickup beside the player he would replace: headshots, then this week's projection, the
 * season average, games played, health, and game, each with the better side marked (text as well
 * as color). Before a drop is picked it holds the pickup's card and says to choose.
 */
function Compare({ row, drop }: { row: MarketPlayer; drop: RosterEntry | null }) {
  if (drop === null) {
    return (
      <div
        data-testid="compare"
        className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground"
      >
        <PlayerHeadshot player={row.player} size={56} />
        <span>
          Pick a player to drop to compare him with <strong>{row.player.name}</strong>.
        </span>
      </div>
    );
  }
  const projEdge = edgeOf(row.projectedPoints, drop.projectedPoints);
  const dropGames = drop.seasonAverage?.games;
  const lines: CompareLine[] = [
    {
      label: 'Proj this week',
      add: pts(row.projectedPoints),
      out: pts(drop.projectedPoints),
      edge: projEdge
    },
    {
      label: 'Season avg',
      add: pts(row.average),
      out: pts(drop.seasonAverage?.average),
      edge: edgeOf(row.average, drop.seasonAverage?.average)
    },
    {
      label: 'Games played',
      add: String(row.games),
      out: dropGames === undefined ? '–' : String(dropGames),
      edge: null
    },
    {
      label: 'Health',
      add: healthOf(row.status, row.injuryStatus, row.game.state === 'bye'),
      out: healthOf(drop.status, drop.injuryStatus, drop.onBye),
      edge: null
    },
    { label: 'This week', add: gameText(row.game), out: gameContext(drop), edge: null }
  ];
  const cell = (value: string, edge: number | null, side: 'add' | 'out') => {
    const wins = edge !== null && edge !== 0 && (side === 'add' ? edge > 0 : edge < 0);
    return (
      <td className={`px-2 py-2 text-center tabular-nums ${wins ? 'font-semibold text-success-700' : ''}`}>
        {wins && <span aria-hidden="true">▲ </span>}
        {value}
        {wins && <span className="sr-only"> (better)</span>}
      </td>
    );
  };
  return (
    <div className="min-w-0 space-y-2" data-testid="compare">
      {projEdge !== null && (
        <p
          className={`rounded-md px-3 py-2 text-sm font-medium ${
            projEdge > 0
              ? 'bg-success-50 text-success-800'
              : projEdge < 0
                ? 'bg-error-50 text-error-800'
                : 'bg-muted text-muted-foreground'
          }`}
        >
          {projEdge === 0
            ? 'Projected the same this week.'
            : `${row.player.name} projects ${Math.abs(projEdge).toFixed(1)} ${
                projEdge > 0 ? 'more' : 'fewer'
              } points this week.`}
        </p>
      )}
      <table className="w-full table-fixed text-sm" aria-label="Compare">
        <thead>
          <tr className="align-top">
            <th scope="col" className="w-1/3 px-2 pb-2 font-semibold text-success-700">
              <span className="flex flex-col items-center gap-1 text-center">
                <PlayerHeadshot player={row.player} size={48} />
                <span className="break-words">+ {row.player.name}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {row.player.position} · {row.player.team ?? 'FA'}
                </span>
              </span>
            </th>
            <td className="w-1/3" />
            <th scope="col" className="w-1/3 px-2 pb-2 font-semibold text-error-700">
              <span className="flex flex-col items-center gap-1 text-center">
                <PlayerHeadshot player={drop.player} size={48} />
                <span className="break-words">− {drop.player.name}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {drop.player.position} · {drop.player.team ?? 'FA'}
                </span>
              </span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border border-t border-border">
          {lines.map((line) => (
            <tr key={line.label}>
              {cell(line.add, line.edge, 'add')}
              <th scope="row" className="px-1 py-2 text-center text-xs font-normal text-muted-foreground">
                {line.label}
              </th>
              {cell(line.out, line.edge, 'out')}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
