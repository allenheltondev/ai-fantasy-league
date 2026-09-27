import type { Clock } from '@fantasy/core';
import { ApiError } from '../errors.js';
import type { PlayerRepository } from '../repos/types.js';
import { matchPlayers, type MatchQuery } from './match.js';
import { toPlayerRef, type Player } from './model.js';

export const DEFAULT_INDEX_TTL_MS = 10 * 60 * 1000;
export const MAX_CANDIDATES = 10;

export interface PlayerSelector {
  playerId?: string | undefined;
  player?: string | undefined;
}

/**
 * Player search and name resolution over the player repository. The name index
 * is cached per container (Lambda keeps it warm) and refreshed after `ttlMs`.
 */
export class PlayerDirectory {
  readonly #repo: PlayerRepository;
  readonly #clock: Clock;
  readonly #ttlMs: number;
  #index: { players: Player[]; loadedAt: number } | null = null;

  constructor(options: { repo: PlayerRepository; clock: Clock; ttlMs?: number }) {
    this.#repo = options.repo;
    this.#clock = options.clock;
    this.#ttlMs = options.ttlMs ?? DEFAULT_INDEX_TTL_MS;
  }

  get(id: string): Promise<Player | null> {
    return this.#repo.get(id);
  }

  /** Ranked matches; with no query, the best-ranked players matching the filters. */
  async search(query: MatchQuery & { limit: number }): Promise<Player[]> {
    const players = await this.#loadIndex();
    return matchPlayers(players, query)
      .slice(0, query.limit)
      .map((m) => m.player);
  }

  /**
   * Resolves `playerId` or a `player` name to exactly one player. Throws
   * PLAYER_NOT_FOUND or AMBIGUOUS_PLAYER (with candidates) otherwise.
   */
  async resolve(selector: PlayerSelector): Promise<Player> {
    if (selector.playerId !== undefined) {
      const player = await this.#repo.get(selector.playerId);
      if (player === null) {
        throw new ApiError('PLAYER_NOT_FOUND', `No player has id "${selector.playerId}".`, {
          fix: 'Call search_players with the player name to find the right id, or pass `player` with the name instead.',
          details: { playerId: selector.playerId }
        });
      }
      return player;
    }
    const name = selector.player?.trim() ?? '';
    if (name.length === 0) {
      throw new ApiError('INVALID_INPUT', 'No player was given.', {
        fix: 'Pass `playerId` (preferred) or `player` with the player name.'
      });
    }
    const matches = matchPlayers(await this.#loadIndex(), { query: name });
    const best = matches[0];
    if (best === undefined) {
      throw new ApiError('PLAYER_NOT_FOUND', `No player matches "${name}".`, {
        fix: 'Check the spelling, or call search_players with just the last name and pick an id from the results.',
        details: { player: name }
      });
    }
    const top = matches.filter((m) => m.score === best.score);
    if (top.length === 1) return best.player;
    const candidates = top.slice(0, MAX_CANDIDATES).map((m) => toPlayerRef(m.player));
    throw new ApiError('AMBIGUOUS_PLAYER', `"${name}" matches ${top.length} players.`, {
      fix: 'Retry with `playerId` set to one of the candidate ids, or add the team or position to the name (for example "josh allen buf").',
      details: { player: name, candidates }
    });
  }

  /** Drops the cached index, e.g. after a player sync. */
  invalidate(): void {
    this.#index = null;
  }

  async #loadIndex(): Promise<Player[]> {
    const now = this.#clock.now().getTime();
    if (this.#index !== null && now - this.#index.loadedAt < this.#ttlMs) return this.#index.players;
    const players = await this.#repo.listIndex();
    this.#index = { players, loadedAt: now };
    return players;
  }
}
