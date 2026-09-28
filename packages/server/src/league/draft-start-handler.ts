import type { Services } from '../context.js';
import { isApiError } from '../errors.js';
import { startLeagueDraft } from '../operations/draft/start-draft.js';
import type { League } from '../repos/types.js';
import { syncDraftSchedule } from './draft-schedule.js';

/**
 * The scheduled draft's timers (#134), run by the API function's league event handler. Each fire
 * first checks the league is still in setup with the same `draft.scheduledAt`; a fire left over
 * from a time the commissioner has since moved or cleared does nothing.
 */

export type DraftStartOutcome = 'started' | 'blocked' | 'stale' | 'early' | 'ignored';
export type DraftReminderOutcome = 'reminded' | 'stale' | 'ignored';

type ScheduleDetail = { leagueId: string; scheduledAt: string };

/** The league, when it is in setup and still scheduled for `scheduledAt`; else why not. */
async function scheduledLeague(
  services: Services,
  detail: ScheduleDetail
): Promise<League | 'ignored' | 'stale'> {
  const league = await services.repos.leagues.get(detail.leagueId);
  if (league === null || league.phase !== 'setup') return 'ignored';
  const stored = league.settings.draft.scheduledAt;
  if (stored === null || Date.parse(stored) !== Date.parse(detail.scheduledAt)) return 'stale';
  return league;
}

/**
 * Handles `Draft Start Scheduled`: starts the draft through the same path as `start_draft`, with
 * the order the commissioner chose (`draft.orderMode`). When something blocks the start (open human
 * seats, a start week too late), the draft stays in setup and `Draft Start Blocked` tells the
 * commissioner, in chat, what to fix.
 */
export async function handleDraftStartScheduled(
  services: Services,
  detail: ScheduleDetail
): Promise<DraftStartOutcome> {
  const league = await scheduledLeague(services, detail);
  if (typeof league === 'string') return league;
  const scheduledAt = league.settings.draft.scheduledAt as string;
  if (services.clock.now().getTime() < Date.parse(scheduledAt)) {
    await syncDraftSchedule(services, league);
    return 'early';
  }
  const teams = await services.repos.teams.list(league.id);
  try {
    await startLeagueDraft(services, {
      league,
      teams,
      randomize: league.settings.draft.orderMode === 'random',
      by: 'system'
    });
  } catch (error) {
    if (!isApiError(error)) throw error;
    // Someone started it by hand at the same moment: nothing to do.
    const again = await services.repos.leagues.get(league.id);
    if (again !== null && again.phase !== 'setup') return 'ignored';
    await services.events.publish('Draft Start Blocked', {
      leagueId: league.id,
      scheduledAt,
      commissionerId: league.commissionerId,
      code: error.code,
      reason: error.message,
      /* v8 ignore next -- every start_draft error carries a fix */
      fix: error.fix ?? 'Fix the problem, then start the draft with start_draft or set a new draft time.'
    });
    services.log.warn('scheduled draft start blocked', { leagueId: league.id, code: error.code });
    return 'blocked';
  }
  services.log.info('scheduled draft started', { leagueId: league.id, scheduledAt });
  return 'started';
}

/** Handles `Draft Reminder Due`: announces `Draft Starting Soon` (chat, and pushed to lobbies). */
export async function handleDraftReminder(
  services: Services,
  detail: ScheduleDetail
): Promise<DraftReminderOutcome> {
  const league = await scheduledLeague(services, detail);
  if (typeof league === 'string') return league;
  const scheduledAt = league.settings.draft.scheduledAt as string;
  const minutes = Math.max(
    1,
    Math.round((Date.parse(scheduledAt) - services.clock.now().getTime()) / 60_000)
  );
  await services.events.publish('Draft Starting Soon', { leagueId: league.id, scheduledAt, minutes });
  return 'reminded';
}
