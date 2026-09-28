import { LEAGUE_PRESETS, LAST_NFL_WEEK, MAX_TEAMS, MIN_TEAMS, type LeaguePreset } from '@fantasy/core';
import { z } from 'zod';
import { newId, type Ctx } from '../../context.js';
import { ApiError, isApiError } from '../../errors.js';
import { nextUnlockedWeek } from '../../league/calendar.js';
import { newTeam } from '../../league/seats.js';
import { buildLeagueSettings, SettingsPatchSchema } from '../../league/settings.js';
import { leagueDetail, LeagueDetailSchema, TeamNameSchema } from '../../league/views.js';
import { defineOperation, withWarnings } from '../../registry/operation.js';
import type { League, Team } from '../../repos/types.js';

export const createLeague = defineOperation({
  name: 'create_league',
  method: 'POST',
  path: '/leagues',
  summary: 'Create a new league and become its commissioner',
  description: [
    'Creates a league with Yahoo default rules for the chosen `preset` (yahoo_standard is half-PPR, full_ppr, or standard with no PPR). You become the commissioner and hold seat 1; every other seat starts as an open agent seat that an AI plays until someone joins with an invite (create_invite).',
    '`teamCount` must be even, 4-12. `startWeek` defaults to the next NFL week that has not kicked off, so a league created mid-season plays the remaining weeks; it must be before the trade deadline (week 11 by default).',
    '`settings` overrides any default, shaped like `settings` from get_league. Invalid settings return INVALID_SETTINGS with one fix per problem.',
    'Each person can have a limited number of active leagues (LEAGUE_QUOTA_EXCEEDED): delete a league still in setup, or finish one, to free a slot. Agents cannot create leagues.'
  ].join(' '),
  tags: ['leagues'],
  mutation: true,
  auth: 'user',
  input: z.object({
    name: z.string().trim().min(1).max(60).describe('League name, 1-60 characters.'),
    teamCount: z
      .number()
      .int()
      .min(MIN_TEAMS)
      .max(MAX_TEAMS)
      .default(8)
      .describe('Number of teams, an even number from 4 to 12 (default 8).'),
    preset: z
      .enum(LEAGUE_PRESETS)
      .default('yahoo_standard')
      .describe('Scoring preset (default yahoo_standard, half-PPR).'),
    startWeek: z
      .number()
      .int()
      .min(1)
      .max(LAST_NFL_WEEK)
      .optional()
      .describe('First NFL week the league plays. Default: the next week that has not kicked off.'),
    teamName: TeamNameSchema.optional().describe('Your team\'s name (default "<your name>\'s Team").'),
    settings: SettingsPatchSchema.optional()
  }),
  output: LeagueDetailSchema,
  handler: async (ctx, input) => {
    const principal = ctx.principal;
    /* v8 ignore next -- auth: 'user' guarantees a user principal */
    if (principal.type !== 'user') throw new Error('create_league needs a user principal');
    await enforceQuota(ctx, principal.sub, principal.email);

    const now = ctx.clock.now();
    const next = await nextUnlockedWeek(ctx.data.nflState, now, ctx.log);
    const startWeek = input.startWeek ?? Math.min(next.week, LAST_NFL_WEEK);
    if (input.startWeek !== undefined && input.startWeek < next.week) {
      throw new ApiError('INVALID_INPUT', `Week ${input.startWeek} has already kicked off.`, {
        fix: `Set startWeek to ${Math.min(next.week, LAST_NFL_WEEK)} or later, or leave it out to start with the next unlocked week.`,
        details: { nextUnlockedWeek: next.week, season: next.season }
      });
    }
    const { settings, warnings } = buildSettingsForSeason(input, startWeek, next.season);
    if (settings.teamCount !== input.teamCount) {
      throw new ApiError('INVALID_INPUT', 'Set the team count with `teamCount`, not inside `settings`.', {
        fix: `Remove teamCount from settings and pass teamCount: ${settings.teamCount} instead.`
      });
    }

    const at = now.toISOString();
    const leagueId = newId(ctx);
    const league: League = {
      id: leagueId,
      name: input.name,
      season: next.season,
      phase: 'setup',
      week: null,
      settings,
      commissionerId: principal.sub,
      commissionerName: principal.name,
      createdBy: principal.sub,
      scheduleSeed: leagueId,
      deadlines: {
        draftStartsAt: null,
        nextLineupLockAt: null,
        nextWaiverRunAt: null,
        tradeDeadlineAt: null
      },
      createdAt: at,
      updatedAt: at,
      version: 1
    };
    const teams: Team[] = [];
    for (let slot = 1; slot <= settings.teamCount; slot++) {
      teams.push(
        newTeam({
          leagueId,
          id: `team-${slot}`,
          draftSlot: slot,
          settings,
          now,
          ...(slot === 1
            ? {
                owner: {
                  userId: principal.sub,
                  name: principal.name,
                  teamName: input.teamName ?? `${principal.name}'s Team`
                }
              }
            : {})
        })
      );
    }
    // Teams and membership first, the league item last: until it exists, nothing else is visible.
    await ctx.repos.teams.create(teams);
    await ctx.repos.members.add({ leagueId, userId: principal.sub, teamId: 'team-1', joinedAt: at });
    await ctx.repos.leagues.create(league);
    await ctx.events.publish('League Created', {
      leagueId,
      name: league.name,
      season: league.season,
      commissionerId: principal.sub,
      teamCount: settings.teamCount,
      startWeek: settings.schedule.startWeek,
      midSeasonStart: settings.schedule.startWeek > 1
    });
    return withWarnings(leagueDetail(league, teams), warnings);
  }
});

/** Settings for a start week, with a clearer error when it is simply too late in the season. */
function buildSettingsForSeason(
  input: {
    teamCount: number;
    preset: LeaguePreset;
    startWeek?: number | undefined;
    settings?: Record<string, unknown> | undefined;
  },
  startWeek: number,
  season: number
): ReturnType<typeof buildLeagueSettings> {
  try {
    return buildLeagueSettings({
      teamCount: input.teamCount,
      preset: input.preset,
      startWeek,
      overrides: input.settings
    });
  } catch (error) {
    const late =
      input.startWeek === undefined &&
      isApiError(error) &&
      String(JSON.stringify(error.details)).includes('START_AFTER_TRADE_DEADLINE');
    if (!late) throw error;
    throw new ApiError('INVALID_SETTINGS', `It is too late in the ${season} season to start a league.`, {
      fix: `The next open NFL week is ${startWeek}, which is not before the trade deadline. Pass settings.trades.deadlineWeek later than ${startWeek} (and at most the last regular-season week), or create the league for next season once its preseason begins.`,
      details: error.details
    });
  }
}

async function enforceQuota(ctx: Ctx, userId: string, email: string | null): Promise<void> {
  const { leaguesPerUser, unlimitedUsers } = ctx.limits;
  const exempt =
    unlimitedUsers.includes(userId.toLowerCase()) ||
    (email !== null && unlimitedUsers.includes(email.toLowerCase()));
  if (exempt) return;
  const active = (await ctx.repos.leagues.listByCreator(userId)).filter((l) => l.phase !== 'complete');
  if (active.length >= leaguesPerUser) {
    throw new ApiError(
      'LEAGUE_QUOTA_EXCEEDED',
      `You already have ${active.length} active league(s); the limit is ${leaguesPerUser}.`,
      {
        fix: 'Delete a league that is still in setup (delete_league), or wait for one to finish, then try again.',
        details: { limit: leaguesPerUser, activeLeagueIds: active.map((l) => l.id) }
      }
    );
  }
}
