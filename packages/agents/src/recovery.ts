import { budgetWeek, type AgentDispatch, type AgentTaskRecord, type Services } from '@fantasy/server';
import { DISPATCH_ATTEMPTS, dispatchIds, errorName, sendDispatch } from './dispatch.js';
import { AgentActionRequestedSchema, type AgentActionRequested } from './events.js';
import { TASK_LOCK_MS, TASK_RECORD_TTL_MS } from './runner.js';

/**
 * The recovery sweep (#207): what brings agent work back when nothing else will. It runs on a
 * schedule (every two minutes: `AgentRecovery` on AgentTaskFunction in infra/template.yaml), so a
 * lost task never waits for a coincidental later event.
 *
 * 1. Expired leases: a task claimed by a worker that crashed or stalled past `TASK_LOCK_MS`, or one
 *    given back for a retry whose time has come. Each is marked for a retry (so a racing sweep
 *    skips it) and its stored request delivered again; the runner's next attempt fences the old
 *    worker off and reconciles what it did. A delivery that fails is tried again one lease later.
 * 2. The dispatch outbox: reservations never sent (the sender died) or whose send failed, resent
 *    from their `retryAt`. After `DISPATCH_ATTEMPTS` failed sends one is abandoned, and the task
 *    gets a failed record (`dispatch_exhausted`) so the commissioner's activity log shows it.
 *
 * Why a sweep rather than a recovery event scheduled at each lease's expiry: the sweep adds nothing
 * to the path of a healthy task (no extra schedule per claim, no cancel on completion); it cannot
 * be lost the way a per-task schedule can (the crash that loses the task can lose the schedule too);
 * and the same pass relays the outbox. Both lists are sparse GSI1 partitions of what is pending.
 */

/** Items each list is read up to, per sweep. */
export const RECOVERY_BATCH = 100;
/** How long a claim made before #207 (no stored request, so it cannot be delivered again) is set aside. */
const UNRECOVERABLE_HOLD_MS = 365 * 24 * 60 * 60 * 1000;

export interface RecoveryReport {
  /** Expired leases found, and delivered again. */
  leases: number;
  redelivered: number;
  /** Outbox rows found due, sent, still failing, and abandoned. */
  dispatches: number;
  sent: number;
  failed: number;
  abandoned: number;
}

export async function recoverAgentTasks(
  services: Services,
  options: { limit?: number } = {}
): Promise<RecoveryReport> {
  const { agents } = services.repos;
  const now = services.clock.now();
  const limit = options.limit ?? RECOVERY_BATCH;
  const report: RecoveryReport = {
    leases: 0,
    redelivered: 0,
    dispatches: 0,
    sent: 0,
    failed: 0,
    abandoned: 0
  };

  for (const lease of await agents.listExpiredTaskLeases(now, limit)) {
    report.leases++;
    const parsed = AgentActionRequestedSchema.safeParse(lease.request);
    if (!parsed.success) {
      await agents.requeueTaskLease(lease, new Date(now.getTime() + UNRECOVERABLE_HOLD_MS));
      services.log.warn('agent task lease cannot be recovered: no stored request', { taskId: lease.taskId });
      continue;
    }
    // Hold it for one lease while the delivery happens; if it is lost, the next sweep after that retries.
    if (!(await agents.requeueTaskLease(lease, new Date(now.getTime() + TASK_LOCK_MS)))) continue;
    try {
      await services.events.publish('Agent Action Requested', parsed.data);
      report.redelivered++;
      services.log.info('agent task lease recovered; delivered again', {
        ...dispatchIds(parsed.data),
        attempt: lease.attempt
      });
    } catch (error) {
      services.log.warn('agent task lease recovery could not deliver; will retry', {
        ...dispatchIds(parsed.data),
        error: errorName(error)
      });
    }
  }

  for (const dispatch of await agents.listDueDispatches(now, limit)) {
    report.dispatches++;
    if (dispatch.attempts >= DISPATCH_ATTEMPTS) {
      await abandon(services, dispatch);
      report.abandoned++;
    } else if (await sendDispatch(services, dispatch)) report.sent++;
    else report.failed++;
  }

  if (report.leases + report.dispatches > 0) services.log.info('agent recovery sweep', { ...report });
  return report;
}

/**
 * Gives up on a dispatch that never went out. If the task did reach a runner (its send worked but
 * was never marked), the dispatch is only marked sent; otherwise the task is claimed and recorded as
 * failed, so it shows in the activity log.
 */
async function abandon(services: Services, dispatch: AgentDispatch): Promise<void> {
  const { agents } = services.repos;
  const request = AgentActionRequestedSchema.parse(dispatch.request);
  const now = services.clock.now();
  const claim = await agents.claimTask({
    taskId: request.taskId,
    now,
    lockUntil: new Date(now.getTime() + TASK_LOCK_MS),
    request
  });
  if (claim.status !== 'started') {
    await agents.settleDispatch(request.taskId, 'dispatched');
    return;
  }
  const league = await services.repos.leagues.get(request.leagueId);
  await agents.completeTask(
    exhaustedRecord(request, league === null ? 0 : budgetWeek(league), now),
    new Date(now.getTime() + TASK_RECORD_TTL_MS),
    { taskId: request.taskId, attempt: claim.attempt }
  );
  await agents.settleDispatch(request.taskId, 'abandoned');
  services.log.warn('agent task dispatch abandoned: every send failed', {
    ...dispatchIds(request),
    failures: dispatch.attempts
  });
}

function exhaustedRecord(request: AgentActionRequested, week: number, now: Date): AgentTaskRecord {
  return {
    taskId: request.taskId,
    leagueId: request.leagueId,
    teamId: request.teamId,
    agentId: request.agentId,
    kind: request.kind,
    week,
    trigger: { detailType: request.trigger.detailType, eventId: request.trigger.eventId },
    status: 'failed',
    fallbackReason: 'dispatch_exhausted',
    toolsCalled: [],
    finalAction: 'none',
    reasoningSummary: `Never ran: the task could not be sent after ${DISPATCH_ATTEMPTS} tries.`,
    latencyMs: 0,
    usage: [],
    costUsd: 0,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString()
  };
}
