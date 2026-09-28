import { DRAFT_REMINDER_MINUTES, type LeagueSettings } from '@fantasy/core';
import type { Ctx } from '../context.js';
import { scheduleName } from '../events/schedule-name.js';
import type { League } from '../repos/types.js';

/**
 * The scheduled draft start (#134): `settings.draft.scheduledAt` puts a `Draft Start Scheduled`
 * event on the rsc-core scheduler at that time, and a `Draft Reminder Due` a few minutes before.
 * Both use one schedule name per league, so a new time moves them, and clearing the time (or
 * starting the draft by hand) cancels them. The handlers (`draft-start-handler.ts`) also check the
 * stored time, so a fire left over from an older time does nothing.
 */

export type DraftScheduleDeps = Pick<Ctx, 'events' | 'clock'>;

export function draftStartScheduleName(leagueId: string): string {
  return scheduleName('draft-start', leagueId);
}

export function draftReminderScheduleName(leagueId: string): string {
  return scheduleName('draft-reminder', leagueId);
}

/** Cancels the league's scheduled draft start and its reminder. */
export async function cancelDraftSchedule(deps: Pick<Ctx, 'events'>, leagueId: string): Promise<void> {
  await deps.events.cancelScheduled(draftStartScheduleName(leagueId));
  await deps.events.cancelScheduled(draftReminderScheduleName(leagueId));
}

/**
 * Puts the league's scheduled draft on the scheduler, moving it if it was there already, or cancels
 * it when the league has no draft time (or is past setup). The reminder is scheduled only while it
 * is still ahead.
 */
export async function syncDraftSchedule(deps: DraftScheduleDeps, league: League): Promise<void> {
  const scheduledAt = league.settings.draft.scheduledAt;
  if (league.phase !== 'setup' || scheduledAt === null) {
    await cancelDraftSchedule(deps, league.id);
    return;
  }
  const at = new Date(scheduledAt);
  await deps.events.scheduleAt({
    at,
    name: draftStartScheduleName(league.id),
    whenPast: 'send',
    event: { detailType: 'Draft Start Scheduled', detail: { leagueId: league.id, scheduledAt } }
  });
  const remindAt = new Date(at.getTime() - DRAFT_REMINDER_MINUTES * 60_000);
  if (remindAt.getTime() > deps.clock.now().getTime()) {
    await deps.events.scheduleAt({
      at: remindAt,
      name: draftReminderScheduleName(league.id),
      whenPast: 'skip',
      event: { detailType: 'Draft Reminder Due', detail: { leagueId: league.id, scheduledAt } }
    });
  } else {
    await deps.events.cancelScheduled(draftReminderScheduleName(league.id));
  }
}

/** The settings with `draft.scheduledAt` as a UTC instant (`...Z`), however its zone was written. */
export function utcDraftTime(settings: LeagueSettings): LeagueSettings {
  const at = settings.draft.scheduledAt;
  if (at === null) return settings;
  return { ...settings, draft: { ...settings.draft, scheduledAt: new Date(at).toISOString() } };
}
