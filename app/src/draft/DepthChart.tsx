import { useEffect, useState } from 'react';
import { ApiError, type ApiFetch } from '../api';
import { POSITIONS, type PlayerRef } from './board';
import type { DraftDepth, TeamDepth } from './research';

export interface DepthChartProps {
  api: ApiFetch;
  leagueId: string;
  /** Changes whenever the board does (the pick count), to refetch. */
  version: number;
  onOpen(player: PlayerRef): void;
}

/** "RB 1/2" for a position's own starting slot, or null when the league does not start one. */
function fill(team: TeamDepth, position: string): { filled: number; required: number } | null {
  const slot = team.slots.find((s) => s.slot === position);
  return slot === undefined ? null : { filled: slot.filled, required: slot.required };
}

/**
 * Teams × positions: each team's drafted players, its starting-slot fill (RB 1/2), and gaps
 * highlighted. Your team is pinned first; teams picking before your next turn are emphasized.
 */
export function DepthChart({ api, leagueId, version, onOpen }: DepthChartProps) {
  const [depth, setDepth] = useState<DraftDepth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<DraftDepth>(`/leagues/${leagueId}/draft/depth`)
      .then((res) => {
        if (!live) return;
        setDepth(res.data);
        setError(null);
      })
      .catch(
        (e: unknown) => live && setError(e instanceof ApiError ? e.message : 'Could not reach the server.')
      );
    return () => {
      live = false;
    };
  }, [api, leagueId, version]);

  if (depth === null) {
    return error === null ? (
      <p className="text-muted-foreground">Loading depth…</p>
    ) : (
      <p role="alert">{error}</p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table aria-label="Depth chart" className="min-w-full text-sm">
        <thead>
          <tr>
            <th scope="col" className="text-left">
              Team
            </th>
            {POSITIONS.map((p) => (
              <th key={p} scope="col" className="px-2 text-left">
                {p}
              </th>
            ))}
            <th scope="col" className="px-2 text-left">
              Flex and gaps
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {depth.teams.map((team) => {
            const flex = team.slots.filter((s) => !(POSITIONS as readonly string[]).includes(s.slot));
            return (
              <tr
                key={team.teamId}
                data-testid={`depth-${team.teamId}`}
                className={team.yours ? 'bg-primary-100' : team.picksBeforeYou > 0 ? 'font-semibold' : ''}
              >
                <th scope="row" className="py-2 pr-2 text-left align-top">
                  {team.teamName}
                  {team.yours && <span className="block text-xs text-primary-800">You</span>}
                  {team.picksBeforeYou > 0 && (
                    <span className="block text-xs text-muted-foreground">
                      {team.picksBeforeYou} pick{team.picksBeforeYou === 1 ? '' : 's'} before you
                    </span>
                  )}
                </th>
                {POSITIONS.map((position) => {
                  const players = team.positions.find((p) => p.position === position)?.players ?? [];
                  const slot = fill(team, position);
                  const gap = slot !== null && slot.filled < slot.required;
                  return (
                    <td
                      key={position}
                      data-testid={`depth-${team.teamId}-${position}`}
                      data-gap={gap ? 'true' : undefined}
                      className={`px-2 py-2 align-top ${gap ? 'bg-warning-50 ring-1 ring-inset ring-warning-300' : ''}`}
                    >
                      {slot !== null && (
                        <span className="block text-xs text-muted-foreground">
                          {position} {slot.filled}/{slot.required}
                        </span>
                      )}
                      {players.map((player) => (
                        <button
                          key={player.id}
                          type="button"
                          className="block text-left hover:underline"
                          onClick={() => onOpen(player)}
                        >
                          {player.name}
                        </button>
                      ))}
                    </td>
                  );
                })}
                <td className="px-2 py-2 align-top text-xs">
                  {flex.map((s) => (
                    <span key={s.slot} className="block">
                      {s.slot} {s.filled}/{s.required}
                    </span>
                  ))}
                  {team.gaps.length > 0 && (
                    <span className="block text-muted-foreground">Needs: {team.gaps.join(', ')}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
