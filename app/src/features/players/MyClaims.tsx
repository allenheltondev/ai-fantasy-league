import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle } from '@readysetcloud/ui';
import { apiFetch } from '../../api';
import { describeError, formatTime, type Claim } from './types';
import { PlayerLink } from '../../players/PlayerLink';

/** Pending waiver claims (list_waiver_claims), each with a cancel button (cancel_waiver_claim). */
export function MyClaims({
  leagueId,
  refreshKey,
  onChanged
}: {
  leagueId: string;
  refreshKey: number;
  onChanged: () => void;
}) {
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiFetch<{ claims: Claim[] }>(`/leagues/${leagueId}/waivers/claims`)
      .then((res) => live && setClaims(res.data.claims))
      .catch((err: unknown) => live && setError(describeError(err)));
    return () => {
      live = false;
    };
  }, [leagueId, refreshKey]);

  async function cancel(claim: Claim) {
    try {
      await apiFetch(`/leagues/${leagueId}/waivers/claims/${claim.id}`, { method: 'DELETE' });
      onChanged();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <Card role="region" aria-label="My claims">
      <CardHeader>
        <CardTitle>My claims</CardTitle>
      </CardHeader>
      <CardBody className="space-y-2">
        {error && <Alert variant="error">{error}</Alert>}
        {claims?.length === 0 && <p className="text-muted-foreground">No pending claims.</p>}
        <ul className="space-y-2">
          {claims?.map((claim) => (
            <li key={claim.id} className="flex items-center justify-between gap-2">
              <span>
                {claim.priority}. <PlayerLink player={claim.player} /> for ${claim.bid}
                {claim.drop && (
                  <>
                    , dropping <PlayerLink player={claim.drop} />
                  </>
                )}{' '}
                <span className="text-sm text-muted-foreground">({formatTime(claim.processesAt)})</span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                aria-label={`Cancel claim for ${claim.player.name}`}
                onClick={() => void cancel(claim)}
              >
                Cancel
              </Button>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
