import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Alert, Button, Card, CardBody, Container, Input, LoadingPage } from '@readysetcloud/ui';
import { useAuth } from '@readysetcloud/ui/auth';
import { useLeagueApi } from '../../api/league';
import type { InvitePreview } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { parseJoinCode } from '../../lib/joinCode';
import { useLoad } from '../../lib/useLoad';

/** Why an invite cannot be used right now, or null when it can. */
export function notJoinableReason(preview: InvitePreview): string | null {
  if (preview.joinable) return null;
  if (preview.status === 'revoked') return 'The commissioner revoked this invite. Ask them for a new link.';
  if (preview.status === 'expired') return 'This invite has expired. Ask the commissioner for a new link.';
  if (preview.status === 'used_up')
    return 'This invite has been used up. Ask the commissioner for a new link.';
  if (preview.takeover !== null) {
    if (!preview.takeover.available)
      return `Someone already took over ${preview.takeover.teamName ?? 'this team'}. Ask the commissioner for a new invite.`;
    if (preview.phase === 'drafting') return 'The draft is running. Come back once it is finished.';
    return 'The season is over, so no one can take over a team.';
  }
  if (preview.phase !== 'setup') return 'This league has already started its draft, so no one new can join.';
  return 'Every seat in this league is taken.';
}

/**
 * `/join/:token`: preview an invite, sign in if needed, and take a seat. The token is the secret
 * from an invite link, or a join code typed by hand. Links preview without signing in; a code needs
 * a signed-in person (the server counts wrong guesses), so a signed-out visitor is sent to sign in
 * and lands back here.
 */
export function JoinPage() {
  const { token = '' } = useParams();
  const { signedIn } = useAuth();
  const code = parseJoinCode(token);
  return (
    <main className="min-h-screen bg-background text-foreground">
      <Container className="max-w-xl py-10">
        {code !== null && !signedIn ? <CodeSignIn token={token} /> : <InvitePreview token={token} />}
      </Container>
    </main>
  );
}

function CodeSignIn({ token }: { token: string }) {
  return (
    <Card>
      <CardBody className="space-y-4">
        <h1 className="font-display text-2xl font-semibold">Sign in to join with your code</h1>
        <p className="text-muted-foreground">
          Sign in or create an account, and we will find the league that code belongs to.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link to="/login" state={{ from: `/join/${token}` }}>
            <Button variant="primary">Sign in</Button>
          </Link>
          <Link to="/signup" state={{ from: `/join/${token}` }}>
            <Button variant="secondary">Create an account</Button>
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}

function InvitePreview({ token }: { token: string }) {
  const api = useLeagueApi();
  const preview = useLoad(() => api.getInvite(token), token);

  if (preview.data !== null) return <InviteCard token={token} preview={preview.data} />;
  return preview.error ? <ApiErrorAlert error={preview.error} /> : <LoadingPage text="Opening invite…" />;
}

function InviteCard({ token, preview }: { token: string; preview: InvitePreview }) {
  const api = useLeagueApi();
  const navigate = useNavigate();
  const { signedIn } = useAuth();
  const [teamName, setTeamName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const reason = notJoinableReason(preview);
  const takeover = preview.takeover;

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const joined = await api.joinLeague(token, teamName.trim() || undefined);
      // A taken-over team is already playing: go straight to it.
      navigate(`/leagues/${joined.league.id}/${takeover === null ? 'settings' : 'home'}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardBody className="space-y-4">
        <p className="text-sm uppercase tracking-wide text-muted-foreground">
          {takeover?.teamName ? `You're invited to take over ${takeover.teamName} in` : "You're invited to"}
        </p>
        <h1 className="font-display text-2xl font-semibold">{preview.leagueName}</h1>
        <p className="text-muted-foreground">
          {preview.season} season · {preview.teamCount} teams · commissioner {preview.commissionerName}
          {takeover === null && ` · ${preview.openSeats} open seat(s)`}
        </p>
        {takeover !== null && reason === null && (
          <p className="text-sm text-muted-foreground">
            You get the team as it stands: its roster, record, and waiver budget. Its AI manager steps aside.
          </p>
        )}
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
              label={takeover === null ? 'Team name (optional)' : 'New team name (optional)'}
              placeholder={takeover === null ? undefined : `Keep ${takeover.teamName}`}
              maxLength={40}
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
            />
            <Button type="submit" variant="primary" loading={busy}>
              {takeover === null ? 'Join league' : 'Take over team'}
            </Button>
          </form>
        ) : (
          <div className="flex flex-wrap gap-3">
            <Link to="/login" state={{ from: `/join/${token}` }}>
              <Button variant="primary">Sign in to join</Button>
            </Link>
            <Link to="/signup" state={{ from: `/join/${token}` }}>
              <Button variant="secondary">Create an account</Button>
            </Link>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
