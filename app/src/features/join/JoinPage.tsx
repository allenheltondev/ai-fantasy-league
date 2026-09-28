import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Alert, Button, Card, CardBody, Container, Input, LoadingPage } from '@readysetcloud/ui';
import { useAuth } from '@readysetcloud/ui/auth';
import { useLeagueApi } from '../../api/league';
import type { InvitePreview } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';

/** Why an invite cannot be used right now, or null when it can. */
export function notJoinableReason(preview: InvitePreview): string | null {
  if (preview.joinable) return null;
  if (preview.status === 'revoked') return 'The commissioner revoked this invite. Ask them for a new link.';
  if (preview.status === 'expired') return 'This invite has expired. Ask the commissioner for a new link.';
  if (preview.status === 'used_up')
    return 'This invite has been used up. Ask the commissioner for a new link.';
  if (preview.phase !== 'setup') return 'This league has already started its draft, so no one new can join.';
  return 'Every seat in this league is taken.';
}

/** `/join/:token`: preview an invite, sign in if needed, and take a seat. */
export function JoinPage() {
  const { token = '' } = useParams();
  const api = useLeagueApi();
  const preview = useLoad(() => api.getInvite(token), token);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <Container className="max-w-xl py-10">
        {preview.data === null ? (
          preview.error ? (
            <ApiErrorAlert error={preview.error} />
          ) : (
            <LoadingPage text="Opening invite…" />
          )
        ) : (
          <InviteCard token={token} preview={preview.data} />
        )}
      </Container>
    </main>
  );
}

function InviteCard({ token, preview }: { token: string; preview: InvitePreview }) {
  const api = useLeagueApi();
  const navigate = useNavigate();
  const { signedIn } = useAuth();
  const [teamName, setTeamName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const reason = notJoinableReason(preview);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const joined = await api.joinLeague(token, teamName.trim() || undefined);
      navigate(`/leagues/${joined.league.id}/settings`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardBody className="space-y-4">
        <p className="text-sm uppercase tracking-wide text-muted-foreground">You're invited to</p>
        <h1 className="font-display text-2xl font-semibold">{preview.leagueName}</h1>
        <p className="text-muted-foreground">
          {preview.season} season · {preview.teamCount} teams · commissioner {preview.commissionerName} ·{' '}
          {preview.openSeats} open seat(s)
        </p>
        <ApiErrorAlert error={error} />
        {reason !== null ? (
          <Alert variant="info">{reason}</Alert>
        ) : signedIn ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void join();
            }}
          >
            <Input
              label="Team name (optional)"
              maxLength={40}
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
            />
            <Button type="submit" variant="primary" loading={busy}>
              Join league
            </Button>
          </form>
        ) : (
          <Link to="/login" state={{ from: `/join/${token}` }}>
            <Button variant="primary">Sign in to join</Button>
          </Link>
        )}
      </CardBody>
    </Card>
  );
}
