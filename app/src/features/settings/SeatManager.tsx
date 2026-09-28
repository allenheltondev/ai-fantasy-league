import { useState } from 'react';
import { Button, Input, SegmentedControl, StatusBadge } from '@readysetcloud/ui';
import type { LeagueApi } from '../../api/league';
import type { LeagueDetail, LeagueState, SeatType, TeamDetail } from '../../api/types';
import { ConfirmButton } from '../../components/ConfirmButton';

export interface SeatManagerProps {
  league: LeagueDetail;
  state: LeagueState;
  can: (action: string) => boolean;
  /** Runs one API call, shows its error, and reloads the league on success. */
  act: (work: (api: LeagueApi) => Promise<unknown>, success: string) => void;
  busy: boolean;
}

const SEAT_OPTIONS: { value: SeatType; label: string }[] = [
  { value: 'human', label: 'Human' },
  { value: 'agent', label: 'AI' }
];

/** Every seat: who holds it, whether an open seat waits for a person or an AI, and the member actions. */
export function SeatManager({ league, state, can, act, busy }: SeatManagerProps) {
  const teams = [...league.teams].sort((a, b) => a.draftSlot - b.draftSlot);
  return (
    <ul className="divide-y divide-border" aria-label="Seats">
      {teams.map((team) => (
        <SeatRow key={team.id} team={team} league={league} state={state} can={can} act={act} busy={busy} />
      ))}
    </ul>
  );
}

function SeatRow({ team, league, state, can, act, busy }: SeatManagerProps & { team: TeamDetail }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(team.name);
  const yours = state.yourTeam?.id === team.id;
  const canRename = can('rename_team') && (yours || (state.youAreCommissioner && team.open));
  const otherMember = team.ownerUserId !== null && team.ownerUserId !== league.commissioner.userId;

  return (
    <li className="flex flex-wrap items-center gap-3 py-3" data-testid={`seat-${team.id}`}>
      <span className="w-6 text-sm text-muted-foreground">{team.draftSlot}</span>
      <div className="min-w-48 flex-1">
        {renaming ? (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setRenaming(false);
              act((api) => api.renameTeam(league.id, team.id, name.trim()), 'Team renamed.');
            }}
          >
            <Input label="Team name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" size="sm" variant="primary">
              Save
            </Button>
          </form>
        ) : (
          <p className="font-medium">
            {team.name}
            {yours && <span className="ml-2 text-sm text-muted-foreground">(you)</span>}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {team.ownerName ?? (team.seatType === 'human' ? 'Open, waiting for an invite' : 'AI manager')}
          {team.ownerUserId === league.commissioner.userId && ' · Commissioner'}
        </p>
      </div>
      {team.open && can('set_seat_type') ? (
        <SegmentedControl
          aria-label={`Seat type for ${team.name}`}
          options={SEAT_OPTIONS.map((o) => ({ ...o, disabled: busy }))}
          value={team.seatType}
          onChange={(seatType) =>
            act(
              (api) => api.setSeatType(league.id, team.id, seatType),
              `${team.name} is now ${seatType === 'human' ? 'a human' : 'an AI'} seat.`
            )
          }
        />
      ) : (
        <StatusBadge tone={team.seatType === 'human' ? 'primary' : 'neutral'}>
          {team.seatType === 'human' ? 'Human' : 'AI'}
        </StatusBadge>
      )}
      <div className="flex gap-2">
        {canRename && !renaming && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRenaming(true)}>
            Rename
          </Button>
        )}
        {otherMember && can('transfer_commissioner') && (
          <ConfirmButton
            label="Make commissioner"
            title="Transfer the commissioner role?"
            message={`${team.ownerName} will run the league. You keep your team but lose commissioner controls.`}
            confirmLabel="Transfer"
            disabled={busy}
            onConfirm={() =>
              act(
                (api) => api.transferCommissioner(league.id, team.ownerUserId as string),
                `${team.ownerName} is now the commissioner.`
              )
            }
          />
        )}
        {otherMember && can('remove_member') && (
          <ConfirmButton
            label="Remove"
            title={`Remove ${team.ownerName}?`}
            message="Their seat goes back to an AI manager and they lose access to the league."
            confirmLabel="Remove member"
            variant="error"
            disabled={busy}
            onConfirm={() =>
              act(
                (api) => api.removeMember(league.id, team.ownerUserId as string),
                `${team.ownerName} was removed.`
              )
            }
          />
        )}
      </div>
    </li>
  );
}
