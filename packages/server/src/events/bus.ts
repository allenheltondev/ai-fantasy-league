import { createHash } from 'node:crypto';

/** The EventBridge envelope fields our event handlers read. */
export interface BusEvent {
  id: string;
  'detail-type': string;
  source: string;
  time?: string;
  detail: unknown;
}

export function eventDetail(event: BusEvent): Record<string, unknown> {
  const detail = event.detail;
  return detail !== null && typeof detail === 'object' && !Array.isArray(detail)
    ? (detail as Record<string, unknown>)
    : {};
}

/** The league ids an event is about: `detail.leagueId`, or `detail.leagueIds`. */
export function eventLeagueIds(detail: Record<string, unknown>): string[] {
  if (typeof detail.leagueId === 'string' && detail.leagueId.length > 0) return [detail.leagueId];
  if (Array.isArray(detail.leagueIds)) {
    return [
      ...new Set(detail.leagueIds.filter((id): id is string => typeof id === 'string' && id.length > 0))
    ];
  }
  return [];
}

/** A republished recovery event keeps its logical identity and original storage timestamp. */
export function canonicalEvent<T extends BusEvent>(event: T): T {
  const detail = eventDetail(event);
  if (
    event.source !== 'fantasy' ||
    typeof detail.eventKey !== 'string' ||
    !detail.eventKey ||
    typeof detail.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(detail.occurredAt))
  )
    return event;
  const id = createHash('sha256')
    .update(JSON.stringify([detail.leagueId, event['detail-type'], detail.eventKey]))
    .digest('hex');
  return { ...event, id: `logical-${id}`, time: new Date(detail.occurredAt).toISOString() };
}
