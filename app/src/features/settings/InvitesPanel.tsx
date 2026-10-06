import { useState } from 'react';
import { Button, Input, Select, StatusBadge, useToast, type StatusBadgeTone } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { CreatedInvite, InviteStatus, TeamDetail } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';

const STATUS: Record<InviteStatus, { label: string; tone: StatusBadgeTone }> = {
  active: { label: 'Active', tone: 'success' },
  expired: { label: 'Expired', tone: 'neutral' },
  used_up: { label: 'Used', tone: 'primary' },
  revoked: { label: 'Revoked', tone: 'error' }
};

export interface InvitesPanelProps {
  leagueId: string;
  /** Every team, to name the team a takeover invite hands over. */
  teams: TeamDetail[];
  openHumanSeats: number;
  canCreate: boolean;
  /** The commissioner may hand an AI team to a person right now (create_takeover_invite). */
  canTakeover: boolean;
  canRevoke: boolean;
}

interface Created {
  link: string;
  code: string | null;
  /** The team a takeover invite hands over; null for an open-seat invite. */
  teamName: string | null;
}

/**
 * Invite links and join codes: for the open seats before the draft, and to hand one AI team to a
 * person (a takeover, which also works in season). Create, copy, and revoke them.
 */
export function InvitesPanel({
  leagueId,
  teams,
  openHumanSeats,
  canCreate,
  canTakeover,
  canRevoke
}: InvitesPanelProps) {
  const api = useLeagueApi();
  const { toast } = useToast();
  const invites = useLoad(() => api.listInvites(leagueId), leagueId);
  const [created, setCreated] = useState<Created | null>(null);
  const [takeoverTeamId, setTakeoverTeamId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const aiTeams = teams
    .filter((t) => t.seatType === 'agent' && t.open)
    .sort((a, b) => a.draftSlot - b.draftSlot);
  const teamName = (teamId: string) => teams.find((t) => t.id === teamId)?.name ?? teamId;

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      invites.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const show = (made: CreatedInvite, forTeam: string | null) =>
    setCreated({
      link: `${window.location.origin}${made.joinPath}`,
      code: made.invite.code,
      teamName: forTeam
    });

  const copy = async (text: string, what: 'link' | 'code') => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`Invite ${what} copied.`, { variant: 'success' });
    } catch {
      toast(`Copy failed. Select the ${what} and copy it yourself.`, { variant: 'warning' });
    }
  };

  return (
    <div className="space-y-4">
      {canCreate && (
        <p className="text-sm text-muted-foreground">
          {openHumanSeats === 0
            ? 'No seats are waiting for a person. People who join take an AI seat instead.'
            : `${openHumanSeats} human seat(s) waiting for someone to join.`}{' '}
          Each link and code works once and expires in 7 days. Friends can open the link, or enter the code
          under Join a league.
        </p>
      )}
      <ApiErrorAlert error={error ?? invites.error} />
      {canCreate && (
        <Button
          variant="primary"
          loading={busy}
          onClick={() => void act(async () => show(await api.createInvite(leagueId), null))}
        >
          Create invite link
        </Button>
      )}
      {canTakeover && aiTeams.length > 0 && (
        <form
          className="space-y-2"
          aria-label="Hand an AI team to a person"
          onSubmit={(e) => {
            e.preventDefault();
            const teamId = takeoverTeamId;
            void act(async () => show(await api.createTakeoverInvite(leagueId, teamId), teamName(teamId)));
          }}
        >
          <p className="text-sm text-muted-foreground">
            Hand an AI team to a person: they take over its roster and record, and its AI manager stops
            playing it. The code works once, expires in 7 days, and is entered under Join a league.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56">
              <Select
                label="AI team to hand over"
                value={takeoverTeamId}
                onChange={(e) => setTakeoverTeamId(e.target.value)}
              >
                <option value="">Pick a team</option>
                {aiTeams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.manager ? ` (${t.manager.name})` : ''}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              type="submit"
              variant={canCreate ? 'secondary' : 'primary'}
              disabled={takeoverTeamId === ''}
              loading={busy}
            >
              Create takeover code
            </Button>
          </div>
        </form>
      )}
      {created !== null && (
        <div className="space-y-3">
          {created.teamName !== null && <p className="text-sm font-medium">Takes over {created.teamName}</p>}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-64 flex-1">
              <Input label="Invite link" readOnly value={created.link} onFocus={(e) => e.target.select()} />
            </div>
            <Button variant="secondary" onClick={() => void copy(created.link, 'link')}>
              Copy link
            </Button>
          </div>
          {created.code !== null && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-40">
                <Input
                  label="Join code"
                  readOnly
                  value={created.code}
                  className="font-mono tracking-widest"
                  onFocus={(e) => e.target.select()}
                />
              </div>
              <Button variant="secondary" onClick={() => void copy(created.code!, 'code')}>
                Copy code
              </Button>
            </div>
          )}
        </div>
      )}
      {invites.data !== null && invites.data.length > 0 && (
        <ul className="divide-y divide-border" aria-label="Invites">
          {invites.data.map((invite) => (
            <li key={invite.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <StatusBadge tone={STATUS[invite.status].tone}>{STATUS[invite.status].label}</StatusBadge>
              {invite.code !== null && (
                <span className="font-mono tracking-widest">
                  <span className="sr-only">Join code </span>
                  {invite.code}
                </span>
              )}
              {invite.teamId !== null && (
                <span className="font-medium">Takes over {teamName(invite.teamId)}</span>
              )}
              <span>
                {invite.uses}/{invite.maxUses} used · expires{' '}
                {new Date(invite.expiresAt).toLocaleDateString()}
              </span>
              {invite.code !== null && invite.status === 'active' && (
                <Button size="sm" variant="ghost" onClick={() => void copy(invite.code!, 'code')}>
                  Copy code
                </Button>
              )}
              {canRevoke && invite.status === 'active' && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void act(() => api.revokeInvite(leagueId, invite.id).then(() => undefined))}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
