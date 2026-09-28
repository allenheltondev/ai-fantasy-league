import type { StatChange } from './log.js';

/**
 * Play descriptions for the scoring log (#164). ESPN's game summary lists each scoring play with a
 * description ("Travis Kelce 18 Yd pass from Patrick Mahomes (Harrison Butker Kick)"), the scoring
 * team, and, once stored, the time we first saw it. A scoring log entry for a touchdown or a made
 * field goal gets the description of the one play that fits it:
 *
 * - the play is the right kind for a stat that went up (a touchdown for `*_td`, a field goal for
 *   `fgm*`), and the player has the right role in it: the receiver before "pass from" and the
 *   passer after it, a rusher in a play without a pass, the kicker of a field goal, and a team
 *   defense on a defensive or return touchdown,
 * - the play's team is the player's team,
 * - his name is in the description (the part before the parenthesised extra point), in full or as
 *   his first initial and last name,
 * - and the play was first seen within `PLAY_MATCH_WINDOW_MS` of the entry.
 *
 * Exactly one play must fit. None, or more than one, means no description: a missing line is fine,
 * a wrong one is not.
 */

export type ScoringPlayKind = 'touchdown' | 'field_goal' | 'extra_point' | 'two_point' | 'safety' | 'other';

export interface ScoringPlayCandidate {
  /** ESPN's play id, unique within a game. */
  id: string;
  kind: ScoringPlayKind;
  /** ESPN's play type, e.g. "Passing Touchdown" or "Interception Return Touchdown", or null. */
  typeText: string | null;
  /** The description, e.g. "Saquon Barkley 3 Yd Run (Jake Elliott Kick)". */
  text: string;
  /** The scoring team (Sleeper's code), or null when unknown. */
  team: string | null;
  /** When the play was first seen (the poll that stored it), ISO time. */
  seenAt: string;
}

export interface PlayMatchPlayer {
  /** Full name, e.g. "Amon-Ra St. Brown" or "Marvin Harrison Jr.". */
  name: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  /** NFL team code, or null for a free agent (who never matches). */
  team: string | null;
  position: string;
}

export interface PlayMatchEntry {
  /** When the scoring change was seen, ISO time. */
  at: string;
  changes: readonly StatChange[];
  player: PlayMatchPlayer;
}

/** How far apart the entry and the play's first sighting may be (both are polled every 2 minutes). */
export const PLAY_MATCH_WINDOW_MS = 10 * 60_000;

type Role = 'passer' | 'receiver' | 'rusher' | 'returner' | 'kicker' | 'defense';

const isFieldGoalMake = (stat: string) => stat.startsWith('fgm') && !stat.startsWith('fgmiss');

/**
 * The roles a player's changes give him in a scoring play. A team defense scores defensive and
 * return touchdowns; a player passes (`pass_td`), catches (`rec_td`) or runs (`rush_td`) one in, scores
 * any other touchdown (a return, a recovery), or kicks a field goal. Extra points and two-point
 * conversions get no description.
 */
export function playRoles(changes: readonly StatChange[], position: string): Role[] {
  const roles = new Set<Role>();
  for (const { stat, delta } of changes) {
    if (delta <= 0) continue;
    if (position === 'DEF') {
      if (stat.endsWith('_td')) roles.add('defense');
      continue;
    }
    if (stat === 'pass_td') roles.add('passer');
    else if (stat === 'rec_td') roles.add('receiver');
    else if (stat === 'rush_td') roles.add('rusher');
    else if (stat.endsWith('_td')) roles.add('returner');
    else if (isFieldGoalMake(stat)) roles.add('kicker');
  }
  return [...roles];
}

/** A scoring log entry that could carry a description: a touchdown or a made field goal. */
export function wantsPlay(changes: readonly StatChange[], position: string): boolean {
  return playRoles(changes, position).length > 0;
}

const DEFENSIVE_TYPE =
  /\b(interception return|fumble return|kickoff return|kick return|punt return|blocked (punt|field goal|fg|kick)|missed field goal return|defensive)\b/i;
const OFFENSIVE_TYPE = /\b(passing|rushing|receiving|own)\b/i;

/**
 * A touchdown scored by the defense or on a return (the team defense's kind). Read from ESPN's play
 * type, else from the description; anything unrecognised is not defensive, so a team defense never
 * gets a description it is unsure of.
 */
export function isDefensivePlay(play: Pick<ScoringPlayCandidate, 'kind' | 'typeText' | 'text'>): boolean {
  if (play.kind !== 'touchdown') return false;
  const source = play.typeText?.trim() || mainPart(play.text);
  return DEFENSIVE_TYPE.test(source) && !OFFENSIVE_TYPE.test(source);
}

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/**
 * Name tokens: accents, apostrophes, and periods dropped ("A.J." is "aj", "St. Brown" is "st brown"),
 * a glued initial split ("P.Mahomes" is "p mahomes"), hyphens joined ("Amon-Ra" is "amonra", so
 * "Ray-Ray" never reads as "Ray").
 */
export function nameTokens(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\b([A-Z])\.(?=[A-Z][a-z])/g, '$1 ')
    .toLowerCase()
    .replace(/['’.-]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 0);
}

/** Tokens of a name without a generational suffix ("Marvin Harrison Jr." is "marvin harrison"). */
function personTokens(value: string): string[] {
  const tokens = nameTokens(value);
  while (tokens.length > 1 && SUFFIXES.has(tokens.at(-1) as string)) tokens.pop();
  return tokens;
}

function indexesOf(haystack: readonly string[], needle: readonly string[]): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((t, j) => haystack[i + j] === t)) out.push(i);
  }
  return out;
}

/**
 * Whether the text names the player: his full name (without a suffix), or his first initial right
 * before his last name ("P. Mahomes"). A one-word name never matches: it is too loose.
 */
export function namesPlayer(
  text: string,
  player: Pick<PlayMatchPlayer, 'name' | 'firstName' | 'lastName'>
): boolean {
  const words = nameTokens(text);
  const full = personTokens(player.name);
  if (full.length >= 2 && indexesOf(words, full).length > 0) return true;
  const last = player.lastName === undefined ? [] : personTokens(player.lastName);
  const initial = player.firstName === undefined ? undefined : nameTokens(player.firstName)[0]?.charAt(0);
  if (last.length === 0 || initial === undefined) return false;
  return indexesOf(words, last).some((i) => i > 0 && words[i - 1] === initial);
}

/** The description before the extra point or two-point try: "(Harrison Butker Kick)" is left out. */
function mainPart(text: string): string {
  const paren = text.indexOf('(');
  return paren === -1 ? text : text.slice(0, paren);
}

/** The scorer's and the passer's parts of the description: before and after "pass from". */
function parts(text: string): { scorer: string; passer: string | null } {
  const main = mainPart(text);
  const match = /\bpass from\b/i.exec(main);
  if (match === null) return { scorer: main, passer: null };
  return { scorer: main.slice(0, match.index), passer: main.slice(match.index + match[0].length) };
}

function fitsRole(role: Role, play: ScoringPlayCandidate, player: PlayMatchPlayer): boolean {
  const { scorer, passer } = parts(play.text);
  switch (role) {
    case 'defense':
      return isDefensivePlay(play);
    case 'passer':
      return play.kind === 'touchdown' && passer !== null && namesPlayer(passer, player);
    case 'receiver':
      return play.kind === 'touchdown' && passer !== null && namesPlayer(scorer, player);
    case 'rusher':
      return (
        play.kind === 'touchdown' && passer === null && !isDefensivePlay(play) && namesPlayer(scorer, player)
      );
    case 'returner':
      return play.kind === 'touchdown' && namesPlayer(scorer, player);
    case 'kicker':
      return play.kind === 'field_goal' && namesPlayer(scorer, player);
  }
}

/**
 * The one scoring play that fits a log entry, or null when none or several do (see the module
 * comment). `plays` are the scoring plays of the player's game, or of the whole week: the team and
 * time checks narrow them.
 */
export function matchScoringPlay(
  entry: PlayMatchEntry,
  plays: readonly ScoringPlayCandidate[],
  windowMs: number = PLAY_MATCH_WINDOW_MS
): ScoringPlayCandidate | null {
  const { player } = entry;
  if (player.team === null) return null;
  const roles = playRoles(entry.changes, player.position);
  if (roles.length === 0) return null;
  const at = Date.parse(entry.at);
  if (Number.isNaN(at)) return null;
  const fits = new Map<string, ScoringPlayCandidate>();
  for (const play of plays) {
    if (play.team !== player.team) continue;
    const seen = Date.parse(play.seenAt);
    if (Number.isNaN(seen) || Math.abs(seen - at) > windowMs) continue;
    if (roles.some((role) => fitsRole(role, play, player))) fits.set(`${play.team}#${play.id}`, play);
  }
  return fits.size === 1 ? ([...fits.values()][0] as ScoringPlayCandidate) : null;
}
