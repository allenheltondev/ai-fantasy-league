import { z } from 'zod';
import type { Services } from '../context.js';
import { handleDraftDeadline, type DeadlineOutcome } from '../league/draft.js';

/**
 * League events the API function handles itself (EventBridge rule `LeagueEventRules` on
 * ApiFunction in infra/template.yaml). Today that is the draft pick clock: the rsc-core scheduler
 * publishes `Draft Pick Deadline` at each pick's deadline.
 */

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
): Promise<{ handled: boolean; outcome?: DeadlineOutcome }> {
  const log = services.log.child({ eventId: event.id, detailType: event['detail-type'] });
  if (event.source !== 'fantasy' || event['detail-type'] !== 'Draft Pick Deadline') {
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
