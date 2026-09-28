import { validateLineup } from '@fantasy/core';
import { z } from 'zod';
import { requireMember, requireTeam } from '../../league/access.js';
import { LeagueIdSchema, TeamIdSchema } from '../../league/views.js';
import { defineOperation, withWarnings } from '../../registry/operation.js';
import { resolveLineup, rosterPlayers, toRosterPlayer } from '../../season/lineups.js';
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

export const getRoster = defineOperation({
  name: 'get_roster',
  method: 'GET',
  path: '/leagues/{leagueId}/teams/{teamId}/roster',
  summary: "A team's roster and lineup for a week",
  description: [
    "Returns a team's players and where each sits in the week's lineup (a starting slot, BN for bench, or IR), with position, NFL team, bye week, injury status, projected and actual points, and whether he is locked.",
    "A player locks at his own game's kickoff: after that he cannot change slots until next week (set_lineup returns PLAYER_LOCKED).",
    'The week defaults to the current one. A week with no saved lineup shows the latest earlier lineup carried forward (`carriedFromWeek`); new players sit on the bench.',
    'Warnings flag starters on bye or ruled out and empty starting slots, so you can fix them with set_lineup before lock. `slots` lists how many of each slot the league uses.',
    'Any member can read any team. Use get_league_state for your own teamId.'
  ].join(' '),
  tags: ['season'],
  mutation: false,
  input: z.object({ leagueId: LeagueIdSchema, teamId: TeamIdSchema, week: LineupWeekSchema }),
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
    players: z.array(RosterEntrySchema)
  }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const { league } = access;
    const team = requireTeam(access, input.teamId);
    const week = leagueWeek(league, input.week);
    const now = ctx.clock.now();
    const [lineup, players, data] = await Promise.all([
      resolveLineup(ctx.repos, team, week),
      rosterPlayers(ctx.repos, team),
      loadWeekData(ctx, league, week, team.roster)
    ]);
    const check = validateLineup(
      league.settings,
      team.roster.map((id) => toRosterPlayer(id, players.get(id))),
      lineup.entries,
      { games: data.games }
    );
    const result = {
      teamId: team.id,
      teamName: team.name,
      season: league.season,
      week,
      lineupSaved: lineup.saved,
      carriedFromWeek: lineup.carriedFromWeek,
      slots: slotCounts(league),
      players: rosterEntries(lineup.entries, players, data, now)
    };
    return team.roster.length === 0 ? result : withWarnings(result, issueWarnings(check.warnings));
  }
});
