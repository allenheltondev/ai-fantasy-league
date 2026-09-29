import { useState } from 'react';
import { positionTone } from '../draft/board';
import { headshotUrl, teamLogoUrl, type AssetPlayer } from './sleeperAssets';

/**
 * A player's picture from Sleeper's CDN (#222): his headshot, or his team's logo for a team
 * defense. It sits in a box of a fixed size so nothing shifts as images arrive, loads lazily
 * (`eager` for what is always on screen), and falls back once, without retrying, to his initials
 * (or the team, for a defense) in his position's color. Decorative: the name is always beside it.
 */

export interface HeadshotPlayer extends AssetPlayer {
  name: string;
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter((w) => /[\p{L}\p{N}]/u.test(w))
      .slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase())
      .join('') || '?'
  );
}

export function PlayerHeadshot({
  player,
  size = 32,
  eager = false,
  className = ''
}: {
  player: HeadshotPlayer;
  /** Pixels, square. Lists use 32; the card uses 64. */
  size?: number;
  eager?: boolean;
  className?: string;
}) {
  const url = headshotUrl(player, size > 48 ? 'full' : 'thumb');
  const [failed, setFailed] = useState<string | null>(null);
  const isDefense = player.position === 'DEF';
  const shown = url !== null && failed !== url;
  return (
    <span
      aria-hidden="true"
      data-headshot=""
      style={{ width: size, height: size }}
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ${
        shown && !isDefense ? 'bg-muted' : positionTone(player.position).chip
      } ${className}`}
    >
      {shown ? (
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          className={isDefense ? 'h-3/4 w-3/4 object-contain' : 'h-full w-full object-cover'}
          onError={() => setFailed(url)}
        />
      ) : (
        <span className="text-[0.625rem] font-semibold leading-none">
          {isDefense ? (player.team ?? 'DEF') : initials(player.name)}
        </span>
      )}
    </span>
  );
}

/**
 * An NFL team's logo (#222): lazy, a fixed size, and nothing at all for a free agent or a logo
 * that will not load. `label` gives it a name for when it stands in for the team's text.
 */
export function TeamLogo({
  team,
  size = 16,
  label = false,
  eager = false,
  className = ''
}: {
  team: string | null | undefined;
  size?: number;
  label?: boolean;
  eager?: boolean;
  className?: string;
}) {
  const url = teamLogoUrl(team);
  const [failed, setFailed] = useState<string | null>(null);
  if (url === null || failed === url) return null;
  return (
    <img
      src={url}
      alt={label ? String(team) : ''}
      width={size}
      height={size}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      data-team-logo=""
      className={`inline-block shrink-0 object-contain ${className}`}
      onError={() => setFailed(url)}
    />
  );
}
