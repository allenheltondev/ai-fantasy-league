import { createHash } from 'node:crypto';

/**
 * Names for rsc-core deferred events (`scheduleAt` / `cancelScheduled`). rsc-core's
 * ScheduleEventFunction uses the name as the EventBridge Scheduler schedule name, which allows
 * `[0-9a-zA-Z-_.]` and at most 64 characters: it replaces any other character with `-` and cuts the
 * name at 64 (functions/schedule-event.mjs, `getScheduleName`). A cut name is still accepted, but
 * two names that share their first 64 characters become the same schedule, so re-scheduling one
 * moves (or cancelling one removes) the other. `trade-expiry-<league uuid>-<trade uuid>` is 86.
 *
 * `scheduleName` builds a name that always fits and stays stable for the same parts: the parts
 * joined with `-` and cleaned, and when that is too long, a readable prefix of it plus a hash of
 * the whole. Every `scheduleAt` and `cancelScheduled` name goes through it.
 */

export const SCHEDULE_NAME_MAX = 64;
export const SCHEDULE_NAME_PATTERN = /^[0-9A-Za-z_.-]{1,64}$/;
const HASH_LENGTH = 16;

export function scheduleName(...parts: readonly (string | number)[]): string {
  const joined = parts
    .map(String)
    .join('-')
    .replace(/[^0-9A-Za-z_.-]/g, '-');
  if (joined.length === 0) throw new Error('A schedule name needs at least one non-empty part.');
  if (joined.length <= SCHEDULE_NAME_MAX) return joined;
  const hash = createHash('sha256').update(joined).digest('hex').slice(0, HASH_LENGTH);
  return `${joined.slice(0, SCHEDULE_NAME_MAX - HASH_LENGTH - 1)}-${hash}`;
}

/** Whether EventBridge Scheduler would take `name` unchanged. */
export function isValidScheduleName(name: string): boolean {
  return SCHEDULE_NAME_PATTERN.test(name);
}
