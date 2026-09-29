import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { Alert, Button, Input, Select, StatusBadge } from '@readysetcloud/ui';
import { apiFetch } from '../../api';
import { ClaimPanel } from './ClaimPanel';
import { MyClaims } from './MyClaims';
import { Transactions } from './Transactions';
import { describeError, formatTime, type LeagueStateData, type SearchPlayer } from './types';
import { TableScroll } from '../../components/TableScroll';
import { PlayerLink } from '../../players/PlayerLink';

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'] as const;
const SEARCH_LIMIT = 50;

function StatusCell({ player, teams }: { player: SearchPlayer; teams: LeagueStateData['teams'] }) {
  const a = player.availability;
  if (a?.status === 'waivers')
    return <StatusBadge tone="warning">Waivers until {formatTime(a.clearsAt ?? '')}</StatusBadge>;
  if (a?.status === 'rostered') {
    return (
      <StatusBadge tone="neutral">{teams.find((t) => t.id === a.teamId)?.name ?? 'Rostered'}</StatusBadge>
    );
  }
  return <StatusBadge tone="success">Free agent</StatusBadge>;
}

/**
 * The league's player browser: search by name and position, show where each player stands
 * (free agent, on waivers, or on a team), add or claim one with a drop and a FAAB bid, and manage
 * pending claims.
 */
export function PlayersPage() {
  const { leagueId = '' } = useParams();
  const [state, setState] = useState<LeagueStateData | null>(null);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState('');
  const [availableOnly, setAvailableOnly] = useState(true);
  const [players, setPlayers] = useState<SearchPlayer[] | null>(null);
  const [selected, setSelected] = useState<SearchPlayer | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  /** The submitted search; the form fields above are only drafts until Search is pressed. */
  const [criteria, setCriteria] = useState({ q: '', position: '' });

  useEffect(() => {
    const fail = (err: unknown) => setError(describeError(err));
    apiFetch<LeagueStateData>(`/leagues/${leagueId}/state`)
      .then((res) => setState(res.data))
      .catch(fail);
    apiFetch<{ players: SearchPlayer[] }>('/players', {
      query: {
        q: criteria.q || undefined,
        position: criteria.position || undefined,
        leagueId,
        limit: SEARCH_LIMIT
      }
    })
      .then((res) => setPlayers(res.data.players))
      .catch(fail);
  }, [leagueId, refreshKey, criteria]);

  const canClaim = state?.allowedActions.includes('claim_waiver') === true;
  const shown = (players ?? []).filter((p) => !availableOnly || p.availability?.status !== 'rostered');
  const refresh = () => setRefreshKey((k) => k + 1);

  return (
    <div data-testid="league-section-players" className="space-y-4">
      <h2 className="text-xl font-semibold">Players</h2>
      {state?.yourTeam && (
        <p className="text-sm text-muted-foreground">
          {state.yourTeam.name}: ${state.yourTeam.faabRemaining} FAAB left
          {!canClaim && ' · Adds and claims are closed right now.'}
        </p>
      )}
      {notice && <Alert variant="success">{notice}</Alert>}
      {error && <Alert variant="error">{error}</Alert>}
      <form
        role="search"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setCriteria({ q: query.trim(), position });
        }}
      >
        <Input label="Search players" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Select label="Position" value={position} onChange={(e) => setPosition(e.target.value)}>
          <option value="">All</option>
          {POSITIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={availableOnly}
            onChange={(e) => setAvailableOnly(e.target.checked)}
          />
          Available only
        </label>
        <Button type="submit" variant="primary">
          Search
        </Button>
      </form>
      {selected && (
        <ClaimPanel
          key={selected.id}
          leagueId={leagueId}
          player={selected}
          onClose={() => setSelected(null)}
          onDone={(message) => {
            setNotice(message);
            setSelected(null);
            refresh();
          }}
        />
      )}
      {players !== null && shown.length === 0 ? (
        <p className="text-muted-foreground">No players match.</p>
      ) : (
        <TableScroll label="Players">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th>Player</th>
                <th>Pos</th>
                <th>Team</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((player) => {
                const status = player.availability?.status;
                const verb = status === 'waivers' ? 'Claim' : 'Add';
                return (
                  <tr key={player.id}>
                    <td>
                      <PlayerLink player={player} />
                    </td>
                    <td>{player.position}</td>
                    <td>{player.team ?? 'FA'}</td>
                    <td>
                      <StatusCell player={player} teams={state?.teams ?? []} />
                    </td>
                    <td>
                      {status !== 'rostered' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!canClaim}
                          aria-label={`${verb} ${player.name}`}
                          onClick={() => {
                            setNotice(null);
                            setSelected(player);
                          }}
                        >
                          {verb}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
      <MyClaims leagueId={leagueId} refreshKey={refreshKey} onChanged={refresh} />
      <Transactions leagueId={leagueId} refreshKey={refreshKey} />
    </div>
  );
}
