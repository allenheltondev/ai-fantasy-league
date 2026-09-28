import {
  applySettingsPatch,
  checkSettingsChange,
  diffSettingPaths,
  hasErrors,
  LeagueSettingsSchema,
  parseLeagueSettings,
  type LeagueSettings,
  type LeagueSettingsPatch
} from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import { requireCommissioner } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { isOpenSeat, newTeam, nextTeamId } from '../../league/seats.js';
import {
  settingsError,
  SettingsPatchSchema,
  settingsPhase,
  settingsWarnings
} from '../../league/settings.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation, withWarnings } from '../../registry/operation.js';
import type { League, Team } from '../../repos/types.js';
import { scheduleTradeDeadline } from '../../trades/lifecycle.js';
import { syncDraftSchedule, utcDraftTime } from '../../league/draft-schedule.js';
import { tradeDeadlineAt } from '../../trades/world.js';

export const updateLeagueSettings = defineOperation({
  name: 'update_league_settings',
  method: 'PATCH',
  path: '/leagues/{leagueId}/settings',
  summary: 'Change league rules (commissioner only)',
  description: [
    'Changes league settings. Send only what changes in `changes`, shaped like `settings` from get_league: nested objects merge ({"scoring": {"perStat": {"rec": 1}}} switches to full PPR), arrays replace.',
    'Before the draft every setting can change, including teamCount (seats are added as agent seats, or open seats are removed). Once the draft starts only trade settings, waiver timing and tiebreaks, and IR-eligible statuses can change; anything else returns INVALID_SETTINGS with SETTING_LOCKED issues. The trade deadline cannot move once passed; in season, a new `trades.deadlineWeek` moves the deadline to that week’s first kickoff.',
    'Schedule the draft with `draft.scheduledAt` (ISO 8601 with a time zone, in the future, at most 60 days ahead; null to start it by hand) and `draft.orderMode` (`slots` or `random`): at that time the draft starts by itself, and a reminder goes out 10 minutes before. If a human seat is still open then, the draft waits and chat says why.',
    'Pass `expectedVersion` (the `version` from get_league) so you never overwrite a change you have not seen; a mismatch returns CONFLICT. Only the commissioner can call this.'
  ].join(' '),
  tags: ['leagues'],
  mutation: true,
  auth: 'user',
  input: z.object({
    leagueId: LeagueIdSchema,
    changes: SettingsPatchSchema,
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('The league `version` your changes are based on (from get_league).')
  }),
  output: z.object({
    version: z.number().int().describe('The new league version.'),
    changedPaths: z.array(z.string()).describe('Every setting that changed, as dotted paths.'),
    settings: LeagueSettingsSchema
  }),
  handler: async (ctx, input) => {
    const access = await requireCommissioner(ctx, input.leagueId);
    const { league } = access;
    assertAction('update_league_settings', league, access.actor, ctx.clock.now());
    if (input.expectedVersion !== undefined && input.expectedVersion !== league.version) {
      throw new ApiError(
        'CONFLICT',
        `The league is at version ${league.version}, not ${input.expectedVersion}.`,
        {
          fix: 'Someone changed the league since you read it. Call get_league, re-apply your changes to the current settings, and send its version.',
          details: { currentVersion: league.version }
        }
      );
    }

    const merged = applySettingsPatch(league.settings, input.changes as LeagueSettingsPatch);
    const parsed = parseLeagueSettings(merged);
    if (!parsed.ok) throw settingsError(parsed.issues);
    const next = utcDraftTime(parsed.settings);
    const issues = checkSettingsChange(league.settings, next, {
      phase: settingsPhase(league.phase),
      now: ctx.clock.now(),
      ...(league.week === null ? {} : { currentWeek: league.week })
    });
    if (hasErrors(issues)) throw settingsError(issues);
    const changedPaths = diffSettingPaths(league.settings, next);
    if (changedPaths.length === 0) {
      return { version: league.version, changedPaths, settings: league.settings };
    }

    const now = ctx.clock.now();
    const removals = seatsToRemove(access.teams, next.teamCount);
    // A new deadline week in season moves the deadline itself (the week's first kickoff).
    const deadlineMoved =
      league.phase === 'regular_season' && league.settings.trades.deadlineWeek !== next.trades.deadlineWeek;
    const deadlines = deadlineMoved
      ? {
          ...league.deadlines,
          tradeDeadlineAt: await tradeDeadlineAt(ctx.data.reference, { ...league, settings: next })
        }
      : league.deadlines;
    const updated = await ctx.repos.leagues.update({
      ...league,
      settings: next,
      deadlines,
      updatedAt: now.toISOString()
    });
    // Same schedule name, so the old deadline event is replaced rather than joined.
    if (deadlineMoved) await scheduleTradeDeadline({ events: ctx.events }, updated);
    // A new draft time moves the scheduled start (same schedule name); clearing it cancels it.
    if (changedPaths.includes('draft.scheduledAt')) await syncDraftSchedule(ctx, updated);
    await syncSeats(ctx, updated, access.teams, removals, league.settings, now);
    await ctx.events.publish('Settings Changed', {
      leagueId: league.id,
      changedPaths,
      changedBy: league.commissionerId,
      version: updated.version,
      phase: league.phase
    });
    return withWarnings({ version: updated.version, changedPaths, settings: next }, settingsWarnings(issues));
  }
});

/** The open seats (highest draft slot first) that go when the league shrinks; fails if too few are open. */
function seatsToRemove(teams: readonly Team[], teamCount: number): Team[] {
  const surplus = teams.length - teamCount;
  if (surplus <= 0) return [];
  const removable = teams.filter(isOpenSeat).sort((a, b) => b.draftSlot - a.draftSlot);
  if (removable.length < surplus) {
    throw new ApiError(
      'NO_OPEN_SEATS',
      `Only ${removable.length} seat(s) are open, so the league cannot shrink to ${teamCount} teams.`,
      {
        fix: `Remove ${surplus - removable.length} member(s) first with remove_member, or choose a teamCount of at least ${teams.length - removable.length}.`
      }
    );
  }
  return removable.slice(0, surplus);
}

/**
 * Keeps the seats in line with pre-draft changes: add agent seats or remove open ones for a new
 * teamCount, renumber draft slots, and reset FAAB to a new budget.
 */
async function syncSeats(
  ctx: Ctx,
  league: League,
  teams: readonly Team[],
  removals: readonly Team[],
  before: LeagueSettings,
  now: Date
): Promise<void> {
  const settings = league.settings;
  const removed = new Set<string>();
  for (const team of removals) {
    if (await ctx.repos.teams.deleteUnowned(league.id, team.id)) removed.add(team.id);
  }
  const kept = teams.filter((t) => !removed.has(t.id));
  const added: Team[] = [];
  while (kept.length + added.length < settings.teamCount) {
    const all = [...kept, ...added];
    added.push(
      newTeam({ leagueId: league.id, id: nextTeamId(all), draftSlot: all.length + 1, settings, now })
    );
  }
  await ctx.repos.teams.create(added);
  const budgetChanged = before.waivers.faabBudget !== settings.waivers.faabBudget;
  for (const [index, team] of kept.entries()) {
    const slot = index + 1;
    if (team.draftSlot === slot && !budgetChanged) continue;
    await ctx.repos.teams.update({
      ...team,
      draftSlot: slot,
      waiverPriority: slot,
      faabRemaining: settings.waivers.faabBudget,
      updatedAt: now.toISOString()
    });
  }
}
