import { z } from 'zod';
import { NFL_TEAMS, PlayerRefSchema, toPlayerRef, type Player } from '../../players/model.js';
import { TEAM_NAMES } from '../../players/teams.js';
import { defineOperation } from '../../registry/operation.js';
import type { SyncedPlayer } from '../../repos/reference.js';

/** More than any NFL roster carries at the fantasy positions, so the search never truncates one. */
const TEAM_ROSTER_LIMIT = 500;

/**
 * Sleeper's depth chart slots in the order a depth chart reads: the offense's skill positions,
 * receivers left, right, then slot, and the kicker. Slots not listed sort after these by name.
 */
const SLOT_ORDER = ['QB', 'RB', 'FB', 'WR', 'LWR', 'RWR', 'SWR', 'TE', 'K', 'PK'];

const SLOT_LABELS: Readonly<Record<string, string>> = {
  LWR: 'WR (left)',
  RWR: 'WR (right)',
  SWR: 'WR (slot)',
  PK: 'K'
};

const DepthPlayerSchema = PlayerRefSchema.extend({
  depth: z
    .number()
    .int()
    .nullable()
    .describe('Place on the depth chart at his slot: 1 is the starter. Null when he is not on it.'),
  number: z.number().int().nullable().describe('Jersey number, or null when unknown.'),
  injuryStatus: z.string().nullable().describe('Injury designation such as "Questionable", or null.')
});

export const getNflDepthChart = defineOperation({
  name: 'get_nfl_depth_chart',
  method: 'GET',
  path: '/nfl-teams/{team}/depth-chart',
  summary: 'An NFL team’s depth chart at the fantasy positions',
  description: [
    'Returns one NFL team’s depth chart for QB, RB, FB, WR (left, right, and slot), TE, and K, as Sleeper publishes it and the player sync stores it twice a day.',
    'Each slot lists its players starter first (`depth: 1`), with jersey number and injury designation.',
    '`others` lists the team’s remaining players at those positions who are not on the depth chart (injured reserve, practice squad, or new signings), best-ranked first.',
    'Use it to see who starts and who backs him up: a handcuff, the next man up after an injury, or a receiver’s role.'
  ].join(' '),
  tags: ['research', 'players'],
  mutation: false,
  input: z.object({
    team: z.enum(NFL_TEAMS).describe('NFL team abbreviation, e.g. "KC".')
  }),
  output: z.object({
    team: z.object({
      code: z.enum(NFL_TEAMS),
      city: z.string(),
      nickname: z.string()
    }),
    slots: z
      .array(
        z.object({
          slot: z.string().describe('Sleeper’s depth chart slot, e.g. "QB" or "LWR".'),
          label: z.string().describe('The slot’s display name, e.g. "WR (left)".'),
          players: z.array(DepthPlayerSchema)
        })
      )
      .describe('Depth chart slots in reading order: QB, RB, FB, WR, TE, then K.'),
    others: z.array(DepthPlayerSchema).describe('Players on the team not on the depth chart.')
  }),
  handler: async (ctx, input) => {
    const roster = (await ctx.data.players.search({ team: input.team, limit: TEAM_ROSTER_LIMIT })).filter(
      (p) => p.team === input.team && p.position !== 'DEF'
    );
    const sources = new Map(
      (await ctx.data.reference.playerSync.getMany(roster.map((p) => p.id))).map((r) => [
        r.player.id,
        r.source
      ])
    );
    const bySlot = new Map<string, DepthEntry[]>();
    const others: DepthEntry[] = [];
    roster.forEach((player, rank) => {
      const source = sources.get(player.id);
      const entry = { player, source, rank };
      const slot = source?.depthChartPosition ?? null;
      if (slot === null) others.push(entry);
      else bySlot.set(slot, [...(bySlot.get(slot) ?? []), entry]);
    });
    const { city, nickname } = TEAM_NAMES[input.team];
    return {
      team: { code: input.team, city, nickname },
      slots: [...bySlot.entries()]
        .sort(([a], [b]) => compareSlots(a, b))
        .map(([slot, entries]) => ({
          slot,
          label: SLOT_LABELS[slot] ?? slot,
          players: entries.sort(byDepth).map(toDepthPlayer)
        })),
      others: others.map(toDepthPlayer)
    };
  }
});

interface DepthEntry {
  player: Player;
  source: SyncedPlayer['source'] | undefined;
  /** Position in the directory's best-ranked-first order: the tiebreak. */
  rank: number;
}

function compareSlots(a: string, b: string): number {
  const ia = SLOT_ORDER.indexOf(a);
  const ib = SLOT_ORDER.indexOf(b);
  if (ia !== ib) return (ia === -1 ? SLOT_ORDER.length : ia) - (ib === -1 ? SLOT_ORDER.length : ib);
  return a.localeCompare(b);
}

/** Depth order first (players without one last), then rank. */
function byDepth(a: DepthEntry, b: DepthEntry): number {
  const da = a.source?.depthChartOrder ?? Number.POSITIVE_INFINITY;
  const db = b.source?.depthChartOrder ?? Number.POSITIVE_INFINITY;
  return da === db ? a.rank - b.rank : da - db;
}

function toDepthPlayer({ player, source }: DepthEntry): z.infer<typeof DepthPlayerSchema> {
  return {
    ...toPlayerRef(player),
    depth: source?.depthChartOrder ?? null,
    number: source?.number ?? null,
    injuryStatus: player.injuryStatus
  };
}
