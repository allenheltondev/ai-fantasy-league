import { scheduleName, type AgentDispatch, type Services, type TriggerGate } from '@fantasy/server';
import { AgentActionRequestedSchema, type AgentActionRequested } from './events.js';

/**
 * The dispatch outbox (#207): how a task reaches the runner, from the router and from a finished
 * task's follow-ups alike.
 *
 * 1. Reserve: an `AgentDispatch` row per task id holds the request and, for a delayed task, the
 *    time it runs (`at`, fixed now, so a redelivered trigger neither moves nor doubles it). A
 *    router gate (the agent's cooldown slot) is taken in the same transaction, so admission and
 *    reservation succeed or fail together, and two deliveries racing for one gate cannot both pass.
 * 2. Send: publish the task (or schedule it by task id), then mark the row `dispatched`.
 * 3. A failed send leaves the row `reserved` with a backoff (`retryAt`); the recovery sweep
 *    (`recovery.ts`) resends it, and gives up after `DISPATCH_ATTEMPTS` failures. A reservation whose
 *    sender died before sending is resent once `DISPATCH_GRACE_MS` has passed.
 *
 * A send can happen twice (a redelivered trigger finds the row still `reserved`, or the relay
 * resends one whose `dispatched` mark was lost): the runner's claim on the task id makes a second
 * delivery a no-op, and a second schedule has the same name and time.
 */

/** How long a fresh reservation is left to its own sender before the relay may resend it. */
export const DISPATCH_GRACE_MS = 2 * 60_000;
/** Failed sends before a dispatch is abandoned (with a failed task record, see `recovery.ts`). */
export const DISPATCH_ATTEMPTS = 8;

/** Wait before resending after the `failures`-th failed send: 30 s, doubling, at most an hour. */
export function dispatchBackoffMs(failures: number): number {
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, failures - 1));
}

/**
 * What became of a dispatch: `dispatched` (sent, now or earlier), `pending` (reserved, but this
 * send failed: the relay retries), `abandoned` (every send failed earlier), or `gated` (the gate
 * was closed: nothing reserved).
 */
export type DispatchOutcome =
  { status: 'dispatched' | 'pending' | 'abandoned'; delayMs: number } | { status: 'gated' };

/**
 * Reserves a task's dispatch (taking `gate` with it) and sends it; see the module comment. With a
 * `delayMs` (even 0) the task is scheduled for then; without one it is published right away.
 */
export async function dispatchTask(
  services: Services,
  request: AgentActionRequested,
  options: { delayMs?: number; gate?: TriggerGate } = {}
): Promise<DispatchOutcome> {
  const now = services.clock.now();
  const delayMs = Math.max(0, options.delayMs ?? 0);
  const fresh: AgentDispatch = {
    taskId: request.taskId,
    leagueId: request.leagueId,
    request,
    at: options.delayMs === undefined ? null : new Date(now.getTime() + delayMs).toISOString(),
    delayMs,
    state: 'reserved',
    attempts: 0,
    reservedAt: now.toISOString(),
    retryAt: new Date(now.getTime() + DISPATCH_GRACE_MS).toISOString()
  };
  const reservation = await services.repos.agents.reserveDispatch(fresh, options.gate);
  if (reservation.status === 'gated') return { status: 'gated' };
  const dispatch = reservation.status === 'exists' ? reservation.dispatch : fresh;
  if (dispatch.state === 'dispatched') return { status: 'dispatched', delayMs: dispatch.delayMs };
  if (dispatch.state === 'abandoned') return { status: 'abandoned', delayMs: dispatch.delayMs };
  const sent = await sendDispatch(services, dispatch);
  return { status: sent ? 'dispatched' : 'pending', delayMs: dispatch.delayMs };
}

/**
 * Sends a reserved dispatch: publishes the task, or schedules it for its `at` (named by the task
 * id; a time already past is sent at once). True once sent and marked; false when the send failed
 * (counted, and held off for the relay).
 */
export async function sendDispatch(services: Services, dispatch: AgentDispatch): Promise<boolean> {
  const request = AgentActionRequestedSchema.parse(dispatch.request);
  try {
    if (dispatch.at === null) await services.events.publish('Agent Action Requested', request);
    else
      await services.events.scheduleAt({
        at: new Date(dispatch.at),
        name: scheduleName('agent-task', request.taskId),
        whenPast: 'send',
        event: { detailType: 'Agent Action Requested', detail: request }
      });
  } catch (error) {
    const retryAt = new Date(services.clock.now().getTime() + dispatchBackoffMs(dispatch.attempts + 1));
    const failures = await services.repos.agents.failDispatch(request.taskId, retryAt);
    // The request's payload stays out of the log: ids, kind, and the error's name only.
    services.log.warn('agent task dispatch failed; the relay will retry', {
      ...dispatchIds(request),
      failures,
      retryAt: retryAt.toISOString(),
      error: errorName(error)
    });
    return false;
  }
  await services.repos.agents.settleDispatch(request.taskId, 'dispatched');
  return true;
}

/** What identifies a task in logs, never its payload. */
export function dispatchIds(request: AgentActionRequested) {
  return { taskId: request.taskId, leagueId: request.leagueId, teamId: request.teamId, kind: request.kind };
}

/** An error's name (or code) for a log line: never its message, which may quote sealed details. */
export function errorName(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : error.name;
  }
  return typeof error;
}
