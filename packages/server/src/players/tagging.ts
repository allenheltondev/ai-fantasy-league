import { normalizeName } from './match.js';
import type { Player } from './model.js';
import { TEAM_NAMES } from './teams.js';

export interface Tags {
  playerIds: string[];
  teams: string[];
}

/** Longest phrase we look up: "amon ra st brown", "kansas city chiefs". */
const MAX_PHRASE_TOKENS = 5;

/**
 * Tags free text (news headlines and descriptions) with the players and teams it names. It uses
 * the same name normalization as player resolution (`players/match.ts`), over the player index the
 * `PlayerDirectory` already caches.
 *
 * - Players match on their full normalized name (at least two words), never a last name alone.
 *   Team defenses are tagged as teams, not players.
 * - A full name shared by several players is tagged only when exactly one of them plays for a team
 *   the text also names; otherwise it is skipped rather than guessed.
 * - Teams match on the nickname ("Chiefs"), a known alias ("Niners"), or city plus nickname.
 *   A tagged player's team is tagged too.
 */
export class NewsTagger {
  readonly #players = new Map<string, Player[]>();
  readonly #teams = new Map<string, string>();

  constructor(players: readonly Player[]) {
    for (const player of players) {
      if (player.position === 'DEF') continue;
      const key = normalizeName(player.name);
      if (!key.includes(' ')) continue;
      const list = this.#players.get(key) ?? [];
      list.push(player);
      this.#players.set(key, list);
    }
    for (const [code, names] of Object.entries(TEAM_NAMES)) {
      for (const phrase of [names.nickname, `${names.city} ${names.nickname}`, ...(names.aliases ?? [])]) {
        this.#teams.set(normalizeName(phrase), code);
      }
    }
  }

  /** `hintTeams` are teams already known from context (a team's own feed). */
  tag(text: string, hintTeams: readonly string[] = []): Tags {
    const tokens = normalizeName(text).split(' ').filter(Boolean);
    const teams = new Set<string>(hintTeams);
    const named: Player[][] = [];
    for (let i = 0; i < tokens.length; i++) {
      for (let n = 1; n <= MAX_PHRASE_TOKENS && i + n <= tokens.length; n++) {
        const phrase = tokens.slice(i, i + n).join(' ');
        const team = this.#teams.get(phrase);
        if (team !== undefined) teams.add(team);
        const players = this.#players.get(phrase);
        if (players !== undefined) named.push(players);
      }
    }
    const playerIds = new Set<string>();
    for (const candidates of named) {
      const pick =
        candidates.length === 1 ? candidates : candidates.filter((p) => p.team !== null && teams.has(p.team));
      if (pick.length !== 1) continue;
      const player = pick[0] as Player;
      playerIds.add(player.id);
      if (player.team !== null) teams.add(player.team);
    }
    return { playerIds: [...playerIds].sort(), teams: [...teams].sort() };
  }
}
