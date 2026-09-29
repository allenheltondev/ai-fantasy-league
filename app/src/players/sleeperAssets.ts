/**
 * Sleeper's public asset CDN (#222). Our player ids are Sleeper `player_id`s, so a headshot needs
 * nothing but the id; a team logo needs the NFL team's abbreviation. A team defense (`DEF`) has no
 * headshot: its logo stands in.
 */

export const SLEEPER_CDN = 'https://sleepercdn.com';

export type HeadshotSize = 'thumb' | 'full';

/** Just what an asset URL needs from a player. */
export interface AssetPlayer {
  id: string;
  position: string;
  team: string | null;
}

/** The NFL team's logo, or null for a free agent (no team) or a blank abbreviation. */
export function teamLogoUrl(team: string | null | undefined): string | null {
  const code = team?.trim().toLowerCase() ?? '';
  return /^[a-z]{2,4}$/.test(code) ? `${SLEEPER_CDN}/images/team_logos/nfl/${code}.png` : null;
}

/**
 * The picture of a player: his headshot (`thumb` for lists, `full` for the card), or his team's
 * logo when he is a team defense. Null when there is nothing to show.
 */
export function headshotUrl(player: AssetPlayer, size: HeadshotSize = 'thumb'): string | null {
  if (player.position === 'DEF') return teamLogoUrl(player.team ?? player.id);
  if (!/^[A-Za-z0-9_-]+$/.test(player.id)) return null;
  return `${SLEEPER_CDN}/content/nfl/players/${size === 'thumb' ? 'thumb/' : ''}${player.id}.jpg`;
}
