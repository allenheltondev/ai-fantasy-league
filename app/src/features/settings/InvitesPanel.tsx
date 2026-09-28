import { useState } from 'react';
import { Button, Input, StatusBadge, useToast, type StatusBadgeTone } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { InviteStatus } from '../../api/types';
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
  openHumanSeats: number;
  canCreate: boolean;
  canRevoke: boolean;
}

/** Invite links for the open human seats: create, copy, and revoke them. */
export function InvitesPanel({ leagueId, openHumanSeats, canCreate, canRevoke }: InvitesPanelProps) {
  const api = useLeagueApi();
  const { toast } = useToast();
  const invites = useLoad(() => api.listInvites(leagueId), leagueId);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

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

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Invite link copied.', { variant: 'success' });
    } catch {
      toast('Copy failed. Select the link and copy it yourself.', { variant: 'warning' });
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {openHumanSeats === 0
          ? 'No seats are waiting for a person. People who join take an AI seat instead.'
          : `${openHumanSeats} human seat(s) waiting for someone to join.`}{' '}
        Each link works once and expires in 7 days.
      </p>
      <ApiErrorAlert error={error ?? invites.error} />
      {canCreate && (
        <Button
          variant="primary"
          loading={busy}
          onClick={() =>
            void act(async () => {
              const created = await api.createInvite(leagueId);
              setLink(`${window.location.origin}${created.joinPath}`);
            })
          }
        >
          Create invite link
        </Button>
      )}
      {link !== null && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
            <Input label="Invite link" readOnly value={link} onFocus={(e) => e.target.select()} />
          </div>
          <Button variant="secondary" onClick={() => void copy(link)}>
            Copy link
          </Button>
        </div>
      )}
      {invites.data !== null && invites.data.length > 0 && (
        <ul className="divide-y divide-border" aria-label="Invites">
          {invites.data.map((invite) => (
            <li key={invite.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <StatusBadge tone={STATUS[invite.status].tone}>{STATUS[invite.status].label}</StatusBadge>
              <span>
                {invite.uses}/{invite.maxUses} used · expires{' '}
                {new Date(invite.expiresAt).toLocaleDateString()}
              </span>
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
