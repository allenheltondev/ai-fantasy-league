import { NFL_TEAMS, POSITIONS, type Player, type Position } from './model.js';

/**
 * Name matching for player resolution and search. It runs in-process over the
 * player index (see docs/adr/001-table-design.md, "Player name search").
 */

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
const TEAM_TOKENS = new Map<string, string>(NFL_TEAMS.map((t) => [t.toLowerCase(), t]));
const POSITION_TOKENS = new Map<string, Position>([
  ...POSITIONS.map((p): [string, Position] => [p.toLowerCase(), p]),
  ['dst', 'DEF'],
  ['d/st', 'DEF']
]);

/** Lowercase, strip accents and punctuation, and drop generational suffixes. */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 0 && !SUFFIXES.has(token))
    .join(' ');
}

export interface MatchQuery {
  query?: string | undefined;
  position?: Position | undefined;
  team?: string | undefined;
}

export interface PlayerMatch {
  player: Player;
  score: number;
}

export const SCORE = {
  exact: 100,
  lastName: 70,
  prefix: 60,
  tokenPrefix: 50,
  fuzzy: 30
} as const;

interface ParsedQuery {
  text: string;
  position: Position | undefined;
  team: string | undefined;
}

/**
 * Pulls a team or position hint out of a multi-word query: "mccaffrey sf" searches
 * for "mccaffrey" on SF. A lone token is always treated as a name ("sf" finds the
 * 49ers defense by alias).
 */
export function parseQuery(input: MatchQuery): ParsedQuery {
  let position = input.position;
  let team = input.team?.toUpperCase();
  const tokens = normalizeName(input.query ?? '')
    .split(' ')
    .filter(Boolean);
  const nameTokens: string[] = [];
  for (const token of tokens) {
    const hintTeam = TEAM_TOKENS.get(token);
    const hintPosition = POSITION_TOKENS.get(token);
    if (tokens.length > 1 && hintTeam !== undefined && team === undefined) {
      team = hintTeam;
    } else if (tokens.length > 1 && hintPosition !== undefined && position === undefined) {
      position = hintPosition;
    } else {
      nameTokens.push(token);
    }
  }
  return { text: nameTokens.join(' '), position, team };
}

export function matchPlayers(players: readonly Player[], input: MatchQuery): PlayerMatch[] {
  const parsed = parseQuery(input);
  const results: PlayerMatch[] = [];
  for (const player of players) {
    if (parsed.position !== undefined && player.position !== parsed.position) continue;
    if (parsed.team !== undefined && player.team !== parsed.team) continue;
    const score = parsed.text.length === 0 ? 1 : scoreName(player, parsed.text);
    if (score > 0) results.push({ player, score });
  }
  return results.sort(compareMatches);
}

function compareMatches(a: PlayerMatch, b: PlayerMatch): number {
  if (a.score !== b.score) return b.score - a.score;
  const ra = a.player.rank ?? Number.MAX_SAFE_INTEGER;
  const rb = b.player.rank ?? Number.MAX_SAFE_INTEGER;
  if (ra !== rb) return ra - rb;
  return a.player.name.localeCompare(b.player.name);
}

export function scoreName(player: Player, query: string): number {
  const full = normalizeName(player.name);
  const last = normalizeName(player.lastName);
  const aliases = player.aliases.map(normalizeName).filter((a) => a.length > 0);
  const names = [full, ...aliases];

  if (names.includes(query)) return SCORE.exact;
  if (query === last) return SCORE.lastName;
  if (query.length >= 2 && names.some((n) => n.startsWith(query))) return SCORE.prefix;

  const queryTokens = query.split(' ');
  const nameTokens = full.split(' ');
  if (queryTokens.every((q) => nameTokens.some((n) => n.startsWith(q)))) return SCORE.tokenPrefix;

  const tolerance = query.length >= 8 ? 2 : query.length >= 5 ? 1 : 0;
  if (tolerance > 0) {
    const candidates = [full, last, ...aliases];
    if (candidates.some((n) => levenshtein(n, query) <= tolerance)) return SCORE.fuzzy;
  }
  return 0;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
