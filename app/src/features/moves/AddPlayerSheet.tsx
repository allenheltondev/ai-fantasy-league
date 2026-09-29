import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, StatusBadge } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { ClaimPreview, ClaimResult, MarketPlayer, Roster, RosterEntry } from '../../api/types';
import { gameContext, gameText } from '../season/gameState';
import { statusLabel } from '../season/slots';
import { FaabExplainer } from './FaabExplainer';
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
  return (
    <Modal open onClose={onClose} aria-label={`${verb} ${row.player.name}`}>
      <div className="space-y-4 p-4 sm:p-5" data-testid="add-sheet">
        <header className="space-y-1">
          <h2 className="text-lg font-semibold">
            {verb} {row.player.name}
          </h2>
          <p className="text-sm text-muted-foreground">
            {row.player.position} · {row.player.team ?? 'FA'} · {gameText(row.game)} · proj{' '}
            <strong className="text-foreground">{pts(row.projectedPoints)}</strong> · avg {pts(row.average)}
          </p>
          {claim && row.availability.clearsAt !== undefined && (
            <p className="text-sm">
              On waivers: your claim is processed{' '}
              {waiverTime(preview?.processesAt ?? row.availability.clearsAt)}.
            </p>
          )}
        </header>

        {(full || drop !== '') && (
          <fieldset className="space-y-2">
            <legend className="font-semibold">
              {full ? 'Your roster is full: pick who to drop' : 'Drop'}
            </legend>
            <p className="text-sm text-muted-foreground">Lowest projected first. Locked players stay.</p>
            <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {!full && (
                <DropChoice label="Nobody" note="You have room" value="" drop={drop} onPick={setDrop} />
              )}
              {candidates.map((entry) => (
                <DropChoice
                  key={entry.player.id}
                  entry={entry}
                  label={entry.player.name}
                  note={`${entry.player.position} · ${roleOf(entry)} · proj ${pts(entry.projectedPoints)}`}
                  value={entry.player.id}
                  drop={drop}
                  onPick={setDrop}
                />
              ))}
            </ul>
          </fieldset>
        )}
        {!full && drop === '' && candidates[0] !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11"
            onClick={() => setDrop((candidates[0] as RosterEntry).player.id)}
          >
            Drop someone too
          </Button>
        )}

        {dropping !== null && <Compare row={row} drop={dropping} />}

        {faab && (
          <div className="flex items-start gap-1">
            <div className="min-w-0 flex-1">
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
            </div>
            <div className="pt-6">
              <FaabExplainer remaining={preview?.faabRemaining} />
            </div>
          </div>
        )}
        {!claim && waiverType === 'faab' && (
          <p className="text-sm text-muted-foreground" data-testid="free-agent-cost">
            Free agent: costs $0, no bid needed.
          </p>
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
  return (
    <li>
      <label
        className={`flex min-h-12 items-center gap-3 px-3 py-2 ${locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted'}`}
      >
        <input
          type="radio"
          name="drop"
          value={props.value}
          checked={props.drop === props.value}
          disabled={locked}
          onChange={() => props.onPick(props.value)}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{props.label}</span>
          <span className="block text-xs text-muted-foreground">{props.note}</span>
        </span>
        {locked && <StatusBadge tone="neutral">Locked</StatusBadge>}
        {!locked && status !== null && (
          <StatusBadge tone={entry?.onBye ? 'warning' : 'error'}>{status}</StatusBadge>
        )}
      </label>
    </li>
  );
}

/** The pickup against the drop: this week's projection and game, and the season average. */
function Compare({ row, drop }: { row: MarketPlayer; drop: RosterEntry }) {
  const line = (label: string, add: string, out: string) => (
    <tr>
      <th scope="row" className="py-1 pr-2 text-left font-normal text-muted-foreground">
        {label}
      </th>
      <td className="py-1 pr-2 tabular-nums">{add}</td>
      <td className="py-1 tabular-nums">{out}</td>
    </tr>
  );
  return (
    <table className="w-full text-sm" aria-label="Compare" data-testid="compare">
      <thead>
        <tr>
          <td />
          <th scope="col" className="pb-1 text-left font-semibold text-success-700">
            + {row.player.name}
          </th>
          <th scope="col" className="pb-1 text-left font-semibold text-error-700">
            − {drop.player.name}
          </th>
        </tr>
      </thead>
      <tbody>
        {line('Proj this week', pts(row.projectedPoints), pts(drop.projectedPoints))}
        {line('Season avg', pts(row.average), pts(drop.seasonAverage?.average))}
        {line('This week', gameText(row.game), gameContext(drop))}
      </tbody>
    </table>
  );
}
