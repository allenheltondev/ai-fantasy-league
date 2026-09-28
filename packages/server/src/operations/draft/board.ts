import {
  currentPick,
  likelyGoneBeforeYourPick,
  OFFENSE_POSITIONS,
  pickSlot,
  picksUntilTurn,
  positionScarcity,
  rosterLayout,
  teamPicks,
  unfilledStarterSlots,
  type LeagueSettings,
  type RecapEntry
} from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { draftable, draftPool, draftRecapOf, secondsLeft } from '../../league/draft.js';
import { leagueManagers, teamManager, TeamManagerSchema } from '../../league/managers.js';
import { SEAT_TYPES, DRAFT_STATUSES, type DraftRecord, type Team } from '../../repos/types.js';
import { matchPlayers } from '../../players/match.js';
import { loadResearch, type Research } from '../../players/research.js';
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

const ByeSchema = z
  .number()
  .int()
  .nullable()
  .describe("The player's NFL bye week this season; null when unknown (no schedule yet, or a free agent).");

/** Scarcity counts players among this many best available. */
export const SCARCITY_TOP = 100;
/** The likely-gone model looks this deep into the pool, plus the best few at every position (K, DEF). */
const LIKELY_POOL = 200;
const LIKELY_PER_POSITION = 5;

export const DraftBoardSchema = z.object({
  status: z.enum(DRAFT_STATUSES).describe('`in_progress`, `paused` (clock frozen), or `complete`.'),
  rounds: z.number().int(),
  pickSeconds: z.number().int().describe('Seconds each team gets per pick.'),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  order: z
    .array(
      z.object({
        teamId: z.string(),
        teamName: z.string(),
        seatType: z.enum(SEAT_TYPES),
        manager: TeamManagerSchema
      })
    )
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
      reason: z.string().nullable().describe('Why the team made the pick, in its own words.'),
      bye: ByeSchema
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
        rank: z.number().int().nullable().describe('Consensus overall rank (ADP stand-in); lower is better.'),
        lastSeason: z
          .object({
            points: z.number().describe('Fantasy points last season under this league’s scoring.'),
            ppg: z.number().describe('Points per game played.'),
            games: z.number().int().describe('Games played.')
          })
          .nullable()
          .optional()
          .describe('Last regular season under this league’s scoring; null with no stats (rookies).'),
        projection: z
          .object({ points: z.number().describe('Projected fantasy points for the season, league scoring.') })
          .nullable()
          .optional()
          .describe('Season projection; null when none is published yet.'),
        bye: ByeSchema,
        injuryStatus: z
          .string()
          .nullable()
          .describe('Injury designation such as "Questionable", "Out", or "IR"; null when healthy.')
      })
    )
    .describe(
      'Best undrafted players, filtered by `position` and `q` when given, ordered by `sort` (consensus rank by default).'
    ),
  yourRoster: z
    .object({
      starters: z
        .array(
          z.object({
            slot: z.string().describe('Starting slot, e.g. "RB" or the flex "W/R/T".'),
            player: PlayerRefSchema.nullable().describe('Who fills it; null while it is empty.')
          })
        )
        .describe('Every starting seat the league uses, filled or empty, most specific slot filled first.'),
      bench: z
        .array(PlayerRefSchema)
        .describe('Drafted players who fit no open starting slot, in pick order.'),
      benchSize: z.number().int().describe('Picks you get beyond the starting slots (your bench spots).')
    })
    .nullable()
    .optional()
    .describe('Your drafted roster laid out by slot; null with no team.'),
  likelyGone: z
    .array(PlayerRefSchema)
    .optional()
    .describe(
      'Players the other teams will likely take before your next pick, by consensus rank and their empty starting slots. A hint: real drafters reach. Empty with no team or no pick left.'
    ),
  scarcity: z
    .array(
      z.object({
        position: PositionSchema,
        left: z.number().int().describe(`Players at the position among the ${SCARCITY_TOP} best available.`),
        likelyGone: z.number().int().describe('Of those, how many will likely be gone before your next pick.')
      })
    )
    .optional()
    .describe(
      `How deep each position still runs: among the ${SCARCITY_TOP} best available players by consensus rank, how many play it (e.g. 5 TEs), and how many of them will likely be gone before your next pick.`
    )
});
export type DraftBoard = z.infer<typeof DraftBoardSchema>;

export const BOARD_SORTS = ['rank', 'lastSeasonPoints', 'ppg', 'projection'] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];

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
  detail: z.boolean().default(false).describe('Set true to list 50 available players instead of 15.'),
  sort: z
    .enum(BOARD_SORTS)
    .default('rank')
    .describe(
      'Order of available players: `rank` (consensus, default), `lastSeasonPoints`, `ppg` (last season per game), or `projection` (season projection), best first.'
    )
};

export interface BoardQuery {
  position?: Position | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  detail?: boolean | undefined;
  sort?: BoardSort | undefined;
}

export async function buildBoard(
  ctx: Ctx,
  input: {
    record: DraftRecord;
    teams: readonly Team[];
    settings: LeagueSettings;
    /** NFL season year, for bye weeks. */
    season: number;
    yourTeamId: string | null;
    query: BoardQuery;
  }
): Promise<DraftBoard> {
  const { record, teams, yourTeamId } = input;
  const state = record.state;
  const now = ctx.clock.now();
  const name = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  const pool = await draftPool(ctx);
  const managers = await leagueManagers(ctx, record.leagueId, teams);
  const players = new Map((await ctx.data.players.all()).map((p) => [p.id, p]));
  const byes = (await ctx.data.reference.schedule.getSeason(input.season))?.byes ?? {};
  const byeOf = (id: string) => {
    const team = players.get(id)?.team ?? null;
    return team === null ? null : (byes[team] ?? null);
  };
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
    reason: p.reason ?? null,
    bye: byeOf(p.playerId)
  }));
  const slot = currentPick(state);
  const drafted = new Set(state.picks.map((p) => p.playerId));
  const limit = input.query.limit ?? (input.query.detail === true ? 50 : 15);
  const sort = input.query.sort ?? 'rank';
  const matched = matchPlayers(
    pool.filter((p: Player) => !drafted.has(p.id)),
    { query: input.query.q, position: input.query.position }
  ).map((m) => m.player);
  // Rank order needs research only for the players shown; other sorts need it for every match.
  const research = await loadResearch(
    ctx,
    input.settings.scoring,
    sort === 'rank' ? matched.slice(0, limit).map((p) => p.id) : matched.map((p) => p.id)
  );
  const available = sortAvailable(matched, research, sort)
    .slice(0, limit)
    .map((p) => availableEntry(p, research, byeOf(p.id)));

  const undrafted = pool.filter((p: Player) => !drafted.has(p.id));
  const gone = yourTeamId === null ? [] : likelyGone(state, yourTeamId, undrafted, input.settings);
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
      seatType: teams.find((t) => t.id === teamId)?.seatType ?? 'agent',
      manager: teamManager(managers, teamId)
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
    bestAvailable: available,
    yourRoster: yourTeamId === null ? null : yourRosterView(state, yourTeamId, input.settings, ref),
    likelyGone: gone.map((id) => ref(id, [])),
    scarcity: positionScarcity(
      undrafted.map(draftable),
      gone,
      OFFENSE_POSITIONS,
      SCARCITY_TOP,
      // Sleeper ranks no team defense, so none is ever in the top 100: count every one still there.
      OFFENSE_POSITIONS.filter((pos) => !undrafted.some((p) => p.position === pos && p.rank !== null))
    )
  };
}

/** Who the other teams likely take before your next pick, from the top of the undrafted pool. */
function likelyGone(
  state: DraftRecord['state'],
  teamId: string,
  undrafted: readonly Player[],
  settings: LeagueSettings
): string[] {
  const deep = undrafted.slice(0, LIKELY_POOL);
  const seen = new Set(deep.map((p) => p.id));
  const extra = OFFENSE_POSITIONS.flatMap((position) =>
    undrafted.filter((p) => p.position === position && !seen.has(p.id)).slice(0, LIKELY_PER_POSITION)
  );
  // The pool is in consensus order, so its ids are the rankings.
  const candidates = [...deep, ...extra];
  return likelyGoneBeforeYourPick(
    state,
    teamId,
    candidates.map(draftable),
    undrafted.map((p) => p.id),
    settings
  );
}

function yourRosterView(
  state: DraftRecord['state'],
  teamId: string,
  settings: LeagueSettings,
  ref: (id: string, positions: readonly string[]) => DraftBoard['picks'][number]['player']
): NonNullable<DraftBoard['yourRoster']> {
  const picks = teamPicks(state, teamId);
  const positions = new Map(picks.map((p) => [p.playerId, p.positions]));
  const layout = rosterLayout(
    settings,
    picks.map((p) => ({ playerId: p.playerId, positions: p.positions }))
  );
  const player = (id: string) => ref(id, positions.get(id) ?? []);
  return {
    starters: layout.starters.map((s) => ({
      slot: s.slot,
      player: s.playerId === null ? null : player(s.playerId)
    })),
    bench: layout.bench.map(player),
    benchSize: Math.max(0, state.rounds - layout.starters.length)
  };
}

/** Sort value for a player, or null when he has none (sorted last). */
function sortValue(player: Player, research: Research, sort: Exclude<BoardSort, 'rank'>): number | null {
  if (sort === 'projection') return research.projection(player.id)?.points ?? null;
  const last = research.lastSeason(player.id);
  return last === null ? null : sort === 'ppg' ? last.ppg : last.points;
}

/** Best first by the chosen measure; ties and players without one keep their rank order. */
export function sortAvailable(players: readonly Player[], research: Research, sort: BoardSort): Player[] {
  if (sort === 'rank') return [...players];
  const keyed = players.map((player, index) => ({ player, index, value: sortValue(player, research, sort) }));
  keyed.sort((a, b) => {
    if (a.value === null || b.value === null) {
      return a.value === b.value ? a.index - b.index : a.value === null ? 1 : -1;
    }
    return b.value - a.value || a.index - b.index;
  });
  return keyed.map((k) => k.player);
}

function availableEntry(
  player: Player,
  research: Research,
  bye: number | null
): DraftBoard['bestAvailable'][number] {
  const last = research.lastSeason(player.id);
  const projection = research.projection(player.id);
  return {
    player: toPlayerRef(player),
    rank: player.rank,
    lastSeason: last === null ? null : { points: last.points, ppg: last.ppg, games: last.games },
    projection: projection === null ? null : { points: projection.points },
    bye,
    injuryStatus: player.injuryStatus
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
