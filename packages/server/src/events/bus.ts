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
