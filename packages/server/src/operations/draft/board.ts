import {
  currentPick,
  pickSlot,
  picksUntilTurn,
  teamPicks,
  unfilledStarterSlots,
  type LeagueSettings,
  type RecapEntry
} from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { draftPool, draftRecapOf, secondsLeft } from '../../league/draft.js';
import { SEAT_TYPES, DRAFT_STATUSES, type DraftRecord, type Team } from '../../repos/types.js';
import { matchPlayers } from '../../players/match.js';
import {
  PlayerRefSchema,
  PositionSchema,
  toPlayerRef,
  type Player,
  type Position
} from '../../players/model.js';

/** The draft board: order, picks, the clock, rosters, and the best players still available. */

const SlotSchema = z.object({
  overall: z.number().int().describe('Pick number across the whole draft, from 1.'),
  round: z.number().int(),
  pick: z.number().int().describe('Pick number within the round, from 1.')
});

export const OnTheClockSchema = SlotSchema.extend({
  teamId: z.string(),
  teamName: z.string(),
  deadline: z
    .string()
    .nullable()
    .describe('When autopick picks for this team; null while the draft is paused.'),
  secondsLeft: z.number().int().nullable().describe('Seconds left on the clock.')
}).describe('The pick being made now.');

const RecapEntrySchema = SlotSchema.omit({ pick: true }).extend({
  teamId: z.string(),
  teamName: z.string(),
  player: PlayerRefSchema,
  adp: z.number().nullable(),
  value: z.number().nullable().describe('Picks after ADP: positive for a steal, negative for a reach.'),
  reason: z.string().nullable()
});

export const DraftBoardSchema = z.object({
  status: z.enum(DRAFT_STATUSES).describe('`in_progress`, `paused` (clock frozen), or `complete`.'),
  rounds: z.number().int(),
  pickSeconds: z.number().int().describe('Seconds each team gets per pick.'),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  order: z
    .array(z.object({ teamId: z.string(), teamName: z.string(), seatType: z.enum(SEAT_TYPES) }))
    .describe('Round-1 order. Even rounds run in reverse (snake).'),
  onTheClock: OnTheClockSchema.nullable().describe('Null once the draft is complete.'),
  yourTeamId: z.string().nullable(),
  yourNextPick: SlotSchema.extend({
    picksAway: z.number().int().describe('0 means you are on the clock now.')
  })
    .nullable()
    .describe('Your next pick, or null when you have none left (or no team).'),
  yourNeeds: z
    .array(z.string())
    .describe('Starting slots your team has not filled yet (e.g. "K", "W/R/T"). Empty with no team.'),
  picks: z.array(
    SlotSchema.extend({
      teamId: z.string(),
      player: PlayerRefSchema,
      auto: z.boolean().describe('True when autopick made it (clock expired).'),
      madeAt: z.string().nullable(),
      adp: z.number().nullable().describe("The player's consensus rank when he was picked."),
      reason: z.string().nullable().describe('Why the team made the pick, in its own words.')
    })
  ),
  recap: z
    .object({
      steals: z.array(RecapEntrySchema).describe('The biggest steals by ADP, best first.'),
      reaches: z.array(RecapEntrySchema).describe('The biggest reaches by ADP, biggest first.'),
      agentPicks: z.array(RecapEntrySchema).describe("Each agent team's first pick, with its reasoning.")
    })
    .nullable()
    .describe(
      "Once the draft is complete: its steals, reaches, and the agents' first picks. Null until then."
    ),
  rosters: z
    .array(z.object({ teamId: z.string(), teamName: z.string(), players: z.array(PlayerRefSchema) }))
    .describe('Each team’s drafted players, in pick order.'),
  bestAvailable: z
    .array(
      z.object({
        player: PlayerRefSchema,
        rank: z.number().int().nullable().describe('Consensus overall rank (ADP stand-in); lower is better.')
      })
    )
    .describe('Best-ranked undrafted players, filtered by `position` and `q` when given.')
});
export type DraftBoard = z.infer<typeof DraftBoardSchema>;

export const BoardQueryShape = {
  position: PositionSchema.optional().describe('Only list available players at this position.'),
  q: z.string().trim().min(1).max(60).optional().describe('Filter available players by name.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('How many available players to list (default 15, or 50 with detail).'),
  detail: z.boolean().default(false).describe('Set true to list 50 available players instead of 15.')
};

export interface BoardQuery {
  position?: Position | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  detail?: boolean | undefined;
}

export async function buildBoard(
  ctx: Ctx,
  input: {
    record: DraftRecord;
    teams: readonly Team[];
    settings: LeagueSettings;
    yourTeamId: string | null;
    query: BoardQuery;
  }
): Promise<DraftBoard> {
  const { record, teams, yourTeamId } = input;
  const state = record.state;
  const now = ctx.clock.now();
  const name = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  const pool = await draftPool(ctx);
  const players = new Map((await ctx.data.players.all()).map((p) => [p.id, p]));
  // A drafted player who has since left the player index still shows, by id.
  const ref = (id: string, positions: readonly string[]) => {
    const p = players.get(id);
    return p === undefined
      ? { id, name: id, team: null, position: positions[0] as Position }
      : toPlayerRef(p);
  };
  const picks = state.picks.map((p) => ({
    overall: p.overall,
    round: p.round,
    pick: p.pick,
    teamId: p.teamId,
    player: ref(p.playerId, p.positions),
    auto: p.auto,
    madeAt: p.madeAt,
    adp: p.adp ?? null,
    reason: p.reason ?? null
  }));
  const slot = currentPick(state);
  const drafted = new Set(state.picks.map((p) => p.playerId));
  const limit = input.query.limit ?? (input.query.detail === true ? 50 : 15);
  const available = matchPlayers(
    pool.filter((p: Player) => !drafted.has(p.id)),
    { query: input.query.q, position: input.query.position }
  )
    .slice(0, limit)
    .map((m) => ({ player: toPlayerRef(m.player), rank: m.player.rank }));

  const away = yourTeamId === null ? null : picksUntilTurn(state, yourTeamId);
  const next = away === null ? null : pickSlot(state, state.picks.length + 1 + away);
  return {
    status: record.status,
    rounds: state.rounds,
    pickSeconds: state.pickSeconds,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    order: state.teamIds.map((teamId) => ({
      teamId,
      teamName: name(teamId),
      seatType: teams.find((t) => t.id === teamId)?.seatType ?? 'agent'
    })),
    onTheClock:
      slot === null
        ? null
        : {
            overall: slot.overall,
            round: slot.round,
            pick: slot.pick,
            teamId: slot.teamId,
            teamName: name(slot.teamId),
            deadline: record.deadline,
            secondsLeft: secondsLeft(record, now)
          },
    yourTeamId,
    yourNextPick:
      next === null || away === null
        ? null
        : { overall: next.overall, round: next.round, pick: next.pick, picksAway: away },
    yourNeeds:
      yourTeamId === null
        ? []
        : unfilledStarterSlots(
            input.settings,
            teamPicks(state, yourTeamId).map((p) => p.positions)
          ),
    picks,
    recap: record.status === 'complete' ? boardRecap(state, teams, players, ref) : null,
    rosters: state.teamIds.map((teamId) => ({
      teamId,
      teamName: name(teamId),
      players: teamPicks(state, teamId).map((p) => ref(p.playerId, p.positions))
    })),
    bestAvailable: available
  };
}

function boardRecap(
  state: DraftRecord['state'],
  teams: readonly Team[],
  players: ReadonlyMap<string, Player>,
  ref: (id: string, positions: readonly string[]) => DraftBoard['picks'][number]['player']
): DraftBoard['recap'] {
  const recap = draftRecapOf(state, teams, players);
  const positions = new Map(state.picks.map((p) => [p.playerId, p.positions]));
  const view = (e: RecapEntry) => ({
    overall: e.overall,
    round: e.round,
    teamId: e.teamId,
    teamName: teams.find((t) => t.id === e.teamId)?.name ?? e.teamId,
    player: ref(e.playerId, positions.get(e.playerId) ?? []),
    adp: e.adp,
    value: e.value,
    reason: e.reason
  });
  return {
    steals: recap.steals.map(view),
    reaches: recap.reaches.map(view),
    agentPicks: recap.agentPicks.map(view)
  };
}
