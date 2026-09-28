import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, Input, Select } from '@readysetcloud/ui';
import { apiFetch } from '../../api';
import { describeError, formatTime, type ClaimPreview, type ClaimResult, type SearchPlayer } from './types';

interface ClaimPanelProps {
  leagueId: string;
  player: SearchPlayer;
  onDone: (message: string) => void;
  onClose: () => void;
}

/**
 * Add a free agent or claim a player on waivers: previews the move (preview_waiver_claim) as the
 * drop and bid change, then submits it (claim_waiver).
 */
export function ClaimPanel({ leagueId, player, onDone, onClose }: ClaimPanelProps) {
  const onWaivers = player.availability?.status === 'waivers';
  const [drop, setDrop] = useState('');
  const [bid, setBid] = useState('0');
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let live = true;
    apiFetch<ClaimPreview>(`/leagues/${leagueId}/waivers/preview`, {
      query: { playerId: player.id, dropPlayerId: drop || undefined, bid: Number(bid) || 0 }
    })
      .then((res) => live && setPreview(res.data))
      .catch((err: unknown) => live && setError(describeError(err)));
    return () => {
      live = false;
    };
  }, [leagueId, player.id, drop, bid]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch<ClaimResult>(`/leagues/${leagueId}/waivers/claims`, {
        method: 'POST',
        body: { playerId: player.id, bid: Number(bid) || 0, ...(drop ? { dropPlayerId: drop } : {}) }
      });
      const { claim } = res.data;
      onDone(
        claim === null
          ? `Added ${player.name}.`
          : `Claim for ${player.name} ($${claim.bid}) queued; it runs ${formatTime(claim.processesAt)}.`
      );
    } catch (err) {
      setError(describeError(err));
      setSubmitting(false);
    }
  }

  const verb = onWaivers ? 'Claim' : 'Add';
  return (
    <Card aria-label={`${verb} ${player.name}`} role="region">
      <CardHeader>
        <CardTitle>
          {verb} {player.name}{' '}
          <span className="text-sm text-muted-foreground">
            {player.position} {player.team ?? 'FA'}
          </span>
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <Select label="Drop player" value={drop} onChange={(e) => setDrop(e.target.value)}>
          <option value="">No drop</option>
          {(preview?.currentRoster ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.position})
            </option>
          ))}
        </Select>
        {onWaivers && (
          <Input
            label="FAAB bid"
            type="number"
            min={0}
            value={bid}
            hint={
              preview
                ? `You have $${preview.faabRemaining}; $${preview.faabAfter} left if it wins.`
                : undefined
            }
            onChange={(e) => setBid(e.target.value)}
          />
        )}
        {preview?.processesAt && <p className="text-sm">Processes {formatTime(preview.processesAt)}.</p>}
        {preview?.issues.map((issue) => (
          <Alert key={issue.code} variant="error">
            {issue.message} {issue.fix}
          </Alert>
        ))}
        {error && <Alert variant="error">{error}</Alert>}
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={!preview?.wouldSucceed}
            loading={submitting}
            onClick={() => void submit()}
          >
            {onWaivers ? 'Submit claim' : 'Add player'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
