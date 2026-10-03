import { z } from 'zod';

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'] as const;
export type Position = (typeof POSITIONS)[number];
export const PositionSchema = z
  .enum(POSITIONS)
  .describe('Fantasy position: QB, RB, WR, TE, K, or DEF (team defense).');

export const PLAYER_STATUSES = ['active', 'inactive', 'injured_reserve'] as const;
export type PlayerStatus = (typeof PLAYER_STATUSES)[number];

// prettier-ignore
export const NFL_TEAMS = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC',
  'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS'
] as const;

/** The stored player record (the `PLAYER#` partition). */
export interface Player {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  /** NFL team abbreviation, or null for a free agent. */
  team: string | null;
  position: Position;
  status: PlayerStatus;
  injuryStatus: string | null;
  /** Nicknames and alternate spellings used for name resolution, e.g. "CMC". */
  aliases: string[];
  /** Consensus overall rank (lower is better), or null when unranked. */
  rank: number | null;
  updatedAt: string;
  /**
   * Where `injuryStatus` came from (#200): Sleeper's sync (the default when absent), or ESPN's
   * game-day report, which is fresher on game day. A game-day status holds until
   * `statusHeldUntil` (the end of that NFL week), so a later Sleeper sync with a stale value does
   * not revert it.
   */
  statusSource?: StatusSource;
  /** When the game-day status was read. */
  statusAsOf?: string;
  statusHeldUntil?: string;
  /**
   * ESPN's note on the injury behind `injuryStatus`, from its injury report (the game-day sync):
   * "McCaffrey (Achilles) is inactive for Sunday's game." Kept while the designation it explains
   * stands, and dropped when the designation changes or clears.
   */
  injuryNote?: InjuryNote;
}

export interface InjuryNote {
  text: string;
  /** When ESPN posted it (ISO 8601), or null when ESPN left the date out. */
  reportedAt: string | null;
}

export const STATUS_SOURCES = ['sleeper', 'espn_gameday'] as const;
export type StatusSource = (typeof STATUS_SOURCES)[number];

/**
 * A player's roster status for drafting and lineups. Sleeper leaves a team defense's status empty,
 * which older syncs stored as inactive; a defense on an NFL team is always active.
 */
export function rosterStatus(player: Pick<Player, 'position' | 'team' | 'status'>): PlayerStatus {
  return player.position === 'DEF' && player.team !== null ? 'active' : player.status;
}

/** How every player appears in every response. */
export const PlayerRefSchema = z
  .object({
    id: z.string().describe('Stable player id. Pass it back as `playerId` to avoid name ambiguity.'),
    name: z.string().describe('Full display name.'),
    team: z.string().nullable().describe('NFL team abbreviation (e.g. "SF"), or null for a free agent.'),
    position: PositionSchema
  })
  .describe('A player reference: always id, name, team, and position.');
export type PlayerRef = z.infer<typeof PlayerRefSchema>;

export const PlayerDetailSchema = PlayerRefSchema.extend({
  status: z.enum(PLAYER_STATUSES).optional().describe('Roster status. Present when `detail` is true.'),
  injuryStatus: z
    .string()
    .nullable()
    .optional()
    .describe('Injury designation such as "Questionable" or "Out", or null. Present when `detail` is true.'),
  aliases: z.array(z.string()).optional().describe('Nicknames accepted by name resolution.'),
  rank: z.number().int().nullable().optional().describe('Consensus overall rank, lower is better.'),
  injuryNote: z
    .object({ text: z.string(), reportedAt: z.string().nullable() })
    .optional()
    .describe('ESPN’s injury report note on his designation, when it has one. Present when `detail` is true.')
}).describe(
  'A player. Compact responses include only id, name, team, and position; `detail: true` adds the rest.'
);
export type PlayerDetail = z.infer<typeof PlayerDetailSchema>;

export function toPlayerRef(player: Player): PlayerRef {
  return { id: player.id, name: player.name, team: player.team, position: player.position };
}

export function toPlayerDetail(player: Player, detail: boolean): PlayerDetail {
  if (!detail) return toPlayerRef(player);
  return {
    ...toPlayerRef(player),
    status: rosterStatus(player),
    injuryStatus: player.injuryStatus,
    aliases: player.aliases,
    rank: player.rank,
    ...(player.injuryNote === undefined ? {} : { injuryNote: player.injuryNote })
  };
}

/**
 * Spread into any operation input that takes a player, so every such operation
 * accepts either an id or a name.
 */
export const playerSelectorShape = {
  playerId: z
    .string()
    .min(1)
    .optional()
    .describe('The player id. Preferred when you have it; wins if `player` is also given.'),
  player: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The player name when you do not have an id. Nicknames ("CMC") and team or position hints ("mccaffrey sf") work. Ambiguous names return AMBIGUOUS_PLAYER with candidates.'
    )
};
