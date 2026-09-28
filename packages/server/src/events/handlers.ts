import { z } from 'zod';
import type { Services } from '../context.js';
import { handleDraftDeadline, type DeadlineOutcome } from '../league/draft.js';
import {
  handleDraftReminder,
  handleDraftStartScheduled,
  type DraftReminderOutcome,
  type DraftStartOutcome
} from '../league/draft-start-handler.js';
import { handleTradeTimer, TRADE_TIMER_EVENTS, type TradeTimerOutcome } from '../trades/handlers.js';

/**
 * League events the API function handles itself (EventBridge rule `LeagueEventRules` on
 * ApiFunction in infra/template.yaml), all published by the rsc-core deferred scheduler: the draft
 * pick clock (`Draft Pick Deadline`), the scheduled draft start and its reminder (`Draft Start
 * Scheduled`, `Draft Reminder Due`), and the trade timers (offer expiry, review end, and the trade
 * deadline; trades/handlers.ts).
 */

/** The scheduled draft's timers. */
export const DRAFT_SCHEDULE_EVENTS: readonly string[] = ['Draft Start Scheduled', 'Draft Reminder Due'];

const ScheduledDetailSchema = z.object({ leagueId: z.string().min(1), scheduledAt: z.string().min(1) });

export interface LeagueBusEvent {
  id: string;
  'detail-type': string;
  source: string;
  detail: unknown;
}

const DeadlineDetailSchema = z.object({ leagueId: z.string().min(1), pick: z.number().int().min(1) });

export function isBusEvent(event: unknown): event is LeagueBusEvent {
  return typeof event === 'object' && event !== null && 'detail-type' in event && 'source' in event;
}

export async function handleLeagueEvent(
  services: Services,
  event: LeagueBusEvent
): Promise<{
  handled: boolean;
  outcome?: DeadlineOutcome | TradeTimerOutcome | DraftStartOutcome | DraftReminderOutcome;
}> {
  const detailType = event['detail-type'];
  const log = services.log.child({ eventId: event.id, detailType });
  if (event.source === 'fantasy' && DRAFT_SCHEDULE_EVENTS.includes(detailType)) {
    const detail = ScheduledDetailSchema.safeParse(event.detail);
    if (!detail.success) {
      log.error('malformed draft schedule event', { detail: event.detail });
      return { handled: false };
    }
    const outcome =
      detailType === 'Draft Start Scheduled'
        ? await handleDraftStartScheduled({ ...services, log }, detail.data)
        : await handleDraftReminder({ ...services, log }, detail.data);
    log.info('draft schedule event handled', { leagueId: detail.data.leagueId, outcome });
    return { handled: outcome !== 'ignored', outcome };
  }
  if (event.source === 'fantasy' && TRADE_TIMER_EVENTS.includes(detailType)) {
    const outcome = await handleTradeTimer({ ...services, log }, detailType, event.detail);
    log.info('trade timer handled', { outcome });
    return { handled: outcome !== 'ignored', outcome };
  }
  if (event.source !== 'fantasy' || detailType !== 'Draft Pick Deadline') {
    log.warn('league event ignored', { source: event.source });
    return { handled: false };
  }
  const detail = DeadlineDetailSchema.safeParse(event.detail);
  if (!detail.success) {
    log.error('malformed draft deadline event', { detail: event.detail });
    return { handled: false };
  }
  const outcome = await handleDraftDeadline({ ...services, log }, detail.data);
  log.info('draft deadline handled', { leagueId: detail.data.leagueId, pick: detail.data.pick, outcome });
  return { handled: true, outcome };
}
