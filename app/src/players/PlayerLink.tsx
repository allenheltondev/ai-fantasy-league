import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { apiFetch, type ApiFetch } from '../api';
import { PlayerCard } from '../draft/PlayerCard';

/**
 * Click a player anywhere in a league to see his card (this season so far, the week's projection
 * and matchup, last season, news). `PlayerCardProvider` mounts once per league (the league shell)
 * and owns the drawer; `PlayerLink` is the clickable name. Outside a provider (a page rendered on
 * its own, or outside a league) the name is plain text.
 */

/** What a card needs to open: the player's id, and his name and position for the header. */
export interface CardPlayer {
  id: string;
  name: string;
  team: string | null;
  position: string;
}

type OpenCard = (player: CardPlayer) => void;

const PlayerCardContext = createContext<OpenCard | null>(null);

/** Opens the player card, or null outside a provider. */
export function useOpenPlayerCard(): OpenCard | null {
  return useContext(PlayerCardContext);
}

export function PlayerCardProvider({
  leagueId,
  api = apiFetch,
  children
}: {
  leagueId: string;
  api?: ApiFetch;
  children: ReactNode;
}) {
  const [player, setPlayer] = useState<CardPlayer | null>(null);
  const open = useCallback<OpenCard>((p) => setPlayer(p), []);
  const close = useCallback(() => setPlayer(null), []);
  const value = useMemo(() => open, [open]);
  return (
    <PlayerCardContext.Provider value={value}>
      {children}
      {player !== null && <PlayerCard api={api} leagueId={leagueId} player={player} onClose={close} />}
    </PlayerCardContext.Provider>
  );
}

/**
 * A player's name that opens his card. It stops the click from reaching whatever row or chip it
 * sits in, so it can live inside clickable rows; `children` replaces the name (e.g. "J. Chase").
 */
export function PlayerLink({
  player,
  className = '',
  children
}: {
  player: CardPlayer;
  className?: string;
  children?: ReactNode;
}) {
  const open = useOpenPlayerCard();
  const label = children ?? player.name;
  if (open === null) return <span className={className}>{label}</span>;
  return (
    <button
      type="button"
      title={`${player.name}: stats and projections`}
      data-player-link=""
      className={`cursor-pointer text-left underline-offset-2 hover:underline focus-visible:underline ${className}`}
      onClick={(e) => {
        e.stopPropagation();
        open(player);
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {label}
    </button>
  );
}

/** Players as clickable names, comma-separated: "A, B, C", or `empty` when there are none. */
export function PlayerList({
  players,
  empty = 'nothing'
}: {
  players: readonly CardPlayer[];
  empty?: string;
}) {
  if (players.length === 0) return <>{empty}</>;
  return (
    <>
      {players.map((p, i) => (
        <span key={p.id}>
          {i > 0 && ', '}
          <PlayerLink player={p} />
        </span>
      ))}
    </>
  );
}
