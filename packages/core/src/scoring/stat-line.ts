import type { StatLine } from './engine.js';

/**
 * A one-line box score for a player's game (#193), for the matchup rows: `18/27 · 212 yds · 2 TD`
 * for a passer, `14 car · 71 yds · 3 rec · 22 yds · 1 TD` for a back. Only what happened is shown:
 * a line with nothing to say is null.
 */

function n(stats: StatLine, stat: string): number {
  const v = stats[stat];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

const round = (v: number) => String(Math.round(v));

function touchdowns(stats: StatLine, keys: readonly string[]): number {
  return keys.reduce((sum, k) => sum + n(stats, k), 0);
}

function passing(stats: StatLine): string[] {
  if (n(stats, 'pass_att') === 0 && n(stats, 'pass_yd') === 0) return [];
  const parts = [`${round(n(stats, 'pass_yd'))} yds`];
  // Completions and attempts when the feed has them.
  if (n(stats, 'pass_att') > 0)
    parts.unshift(`${round(n(stats, 'pass_cmp'))}/${round(n(stats, 'pass_att'))}`);
  if (n(stats, 'pass_td') > 0) parts.push(`${round(n(stats, 'pass_td'))} TD`);
  if (n(stats, 'pass_int') > 0) parts.push(`${round(n(stats, 'pass_int'))} INT`);
  return parts;
}

function rushing(stats: StatLine, label: string): string[] {
  if (n(stats, 'rush_att') === 0 && n(stats, 'rush_yd') === 0) return [];
  return [`${round(n(stats, 'rush_att'))} car`, `${round(n(stats, 'rush_yd'))} ${label}`];
}

function receiving(stats: StatLine, label: string): string[] {
  if (n(stats, 'rec') === 0 && n(stats, 'rec_tgt') === 0) return [];
  const targets = n(stats, 'rec_tgt');
  const catches =
    targets > 0 ? `${round(n(stats, 'rec'))}/${round(targets)} rec` : `${round(n(stats, 'rec'))} rec`;
  return [catches, `${round(n(stats, 'rec_yd'))} ${label}`];
}

function kicking(stats: StatLine): string[] {
  const parts: string[] = [];
  if (n(stats, 'fga') > 0 || n(stats, 'fgm') > 0)
    parts.push(`${round(n(stats, 'fgm'))}/${round(n(stats, 'fga'))} FG`);
  if (n(stats, 'xpa') > 0 || n(stats, 'xpm') > 0) {
    parts.push(
      n(stats, 'xpa') > 0
        ? `${round(n(stats, 'xpm'))}/${round(n(stats, 'xpa'))} XP`
        : `${round(n(stats, 'xpm'))} XP`
    );
  }
  return parts;
}

function defense(stats: StatLine): string[] {
  const parts: string[] = [];
  if ('pts_allow' in stats) parts.push(`${round(n(stats, 'pts_allow'))} pts allowed`);
  if (n(stats, 'sack') > 0) parts.push(`${round(n(stats, 'sack'))} sack${n(stats, 'sack') === 1 ? '' : 's'}`);
  const takeaways = n(stats, 'int') + n(stats, 'fum_rec');
  if (takeaways > 0) parts.push(`${round(takeaways)} TO`);
  const tds = touchdowns(stats, ['def_td', 'def_st_td']);
  if (tds > 0) parts.push(`${round(tds)} TD`);
  return parts;
}

/** The player's box score for the week, or null when there is nothing to show yet. */
export function statLine(position: string, stats: StatLine | undefined): string | null {
  if (stats === undefined) return null;
  let parts: string[];
  if (position === 'K') parts = kicking(stats);
  else if (position === 'DEF') parts = defense(stats);
  else if (position === 'QB') {
    parts = passing(stats);
    const rush = n(stats, 'rush_yd');
    if (rush !== 0) parts.push(`${round(rush)} rush yds`);
    if (n(stats, 'rush_td') > 0) parts.push(`${round(n(stats, 'rush_td'))} rush TD`);
  } else {
    // Backs lead with the run game; receivers and tight ends with catches.
    const runs = position === 'RB';
    const first = runs ? rushing(stats, 'yds') : receiving(stats, 'yds');
    const second = runs ? receiving(stats, 'rec yds') : rushing(stats, 'rush yds');
    parts = [...first, ...second];
    const tds = touchdowns(stats, ['rush_td', 'rec_td', 'pass_td', 'st_td', 'fum_rec_td']);
    if (tds > 0) parts.push(`${round(tds)} TD`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}
