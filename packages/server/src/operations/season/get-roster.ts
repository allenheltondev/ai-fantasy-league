import {
  lineupDiff,
  startersProjection,
  optimizeLineup,
  RosterSlotSchema,
  seasonPoints,
  validateLineup
} from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { requireMember, requireTeam } from '../../league/access.js';
import { LeagueIdSchema, TeamIdSchema } from '../../league/views.js';
import { defineOperation, withWarnings } from '../../registry/operation.js';
import type { League } from '../../repos/types.js';
import { detailFlag } from '../players.js';
import { lineupValues, resolveLineup, rosterPlayers, toRosterPlayer } from '../../season/lineups.js';
import {
  issueWarnings,
  leagueWeek,
  LineupWeekSchema,
  loadWeekData,
  RosterEntrySchema,
  rosterEntries,
  SlotCountSchema,
  slotCounts
} from './views.js';

/** How many NFL weeks before this one `recentPoints` averages. */
const RECENT_WEEKS = 3;

export const getRoster = defineOperation({
  name: 'get_roster',
  method: 'GET',
  path: '/leagues/{leagueId}/teams/{teamId}/roster',
  summary: "A team's roster and lineup for a week",
  description: [
    "Returns a team's players and where each sits in the week's lineup (a starting slot, BN for bench, or IR), with position, NFL team, opponent, kickoff, bye week, injury status, projected and actual points, the average of his last 3 weeks, and whether he is locked.",
    "A player locks at his own game's kickoff: after that he cannot change slots until next week (set_lineup returns PLAYER_LOCKED).",
    'The week defaults to the current one. A week with no saved lineup shows the latest earlier lineup carried forward (`carriedFromWeek`); new players sit on the bench.',
    '`projectedPoints` is the starters’ projection under league scoring (starters on bye or ruled out count 0). `optimal` is the best legal lineup (locked players stay put; Out, IR, and bye players never start) and the set_lineup `moves` that reach it: pass them to set_lineup as they are to apply it. It ranks players by projection, or by consensus rank when no projections are stored for the week (`optimal.basis: rank`).',
    'Warnings flag starters on bye or ruled out and empty starting slots, so you can fix them with set_lineup before lock. `slots` lists how many of each slot the league uses.',
    'Any member can read any team. Use get_league_state for your own teamId.',
    '`detail: true` adds each player’s full record (status, injury designation, rank) and the starting slots he can fill.'
  ].join(' '),
  tags: ['season'],
  mutation: false,
  input: z.object({
    leagueId: LeagueIdSchema,
    teamId: TeamIdSchema,
    week: LineupWeekSchema,
    detail: detailFlag
  }),
  output: z.object({
    teamId: z.string(),
    teamName: z.string(),
    season: z.number().int(),
    week: z.number().int(),
    lineupSaved: z.boolean().describe('True when the team saved a lineup for exactly this week.'),
    carriedFromWeek: z
      .number()
      .int()
      .nullable()
      .describe('When no lineup was saved for this week: the week it was carried forward from.'),
    slots: z.array(SlotCountSchema),
    players: z.array(RosterEntrySchema),
    projectedPoints: z
      .number()
      .describe("The starters' projected points this week; starters on bye or ruled out count 0."),
    optimal: z
      .object({
        basis: z
          .enum(['projections', 'rank'])
          .describe(
            'What it ranks players by: league-scored projections, or consensus rank when none are stored for the week.'
          ),
        projectedPoints: z
          .number()
          .describe('Projected points of that lineup (0 when the week has no projections).'),
        moves: z
          .array(z.object({ playerId: z.string(), slot: RosterSlotSchema }))
          .describe('The set_lineup moves from the current lineup to it; empty when it is already the best.')
      })
      .nullable()
      .describe(
        'The best legal lineup, keeping locked players where they are and never starting Out, IR, or bye players. Null only when no legal lineup can be built.'
      )
  }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const { league } = access;
    const team = requireTeam(access, input.teamId);
    const week = leagueWeek(league, input.week);
    const now = ctx.clock.now();
    const [lineup, players, data, recent] = await Promise.all([
      resolveLineup(ctx.repos, team, week),
      rosterPlayers(ctx.repos, team),
      loadWeekData(ctx, league, week, team.roster),
      recentPoints(ctx, league, week, team.roster)
    ]);
    const roster = team.roster.map((id) => toRosterPlayer(id, players.get(id)));
    const check = validateLineup(league.settings, roster, lineup.entries, { games: data.games });
    const projections = Object.fromEntries(data.projected);
    const { basis, values } = lineupValues(data.projected, players, team.roster);
    const best = optimizeLineup(
      league.settings,
      roster,
      values,
      {
        games: data.games,
        now,
        previousLineup: lineup.entries
      },
      { keepSlots: true }
    );
    const result = {
      teamId: team.id,
      teamName: team.name,
      season: league.season,
      week,
      lineupSaved: lineup.saved,
      carriedFromWeek: lineup.carriedFromWeek,
      slots: slotCounts(league),
      players: rosterEntries(lineup.entries, players, data, now, input.detail ? league.settings : null).map(
        (e) => ({ ...e, recentPoints: recent.get(e.player.id) ?? null })
      ),
      projectedPoints: startersProjection(roster, lineup.entries, projections, data.games),
      optimal: !best.validation.valid
        ? null
        : {
            basis,
            projectedPoints: startersProjection(roster, best.lineup, projections, data.games),
            moves: lineupDiff(lineup.entries, best.lineup)
          }
    };
    return team.roster.length === 0 ? result : withWarnings(result, issueWarnings(check.warnings));
  }
});

/**
 * Each player's points per game over the last `RECENT_WEEKS` NFL weeks before `week`, under league
 * scoring (one small history query per player). Players without a game in that window are left out.
 */
async function recentPoints(
  ctx: Ctx,
  league: League,
  week: number,
  playerIds: readonly string[]
): Promise<Map<string, { average: number; games: number }>> {
  const out = new Map<string, { average: number; games: number }>();
  if (week <= 1) return out;
  const histories = await Promise.all(
    playerIds.map((id) => ctx.data.reference.stats.getPlayerHistory(id, league.season))
  );
  for (const [i, history] of histories.entries()) {
    const lines = history.filter((l) => l.week < week && l.week >= week - RECENT_WEEKS);
    const season = seasonPoints(league.settings, lines);
    if (season.games > 0) out.set(playerIds[i] as string, { average: season.ppg, games: season.games });
  }
  return out;
}
