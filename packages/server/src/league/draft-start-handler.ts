import type { Services } from '../context.js';
import { isApiError } from '../errors.js';
import type { SendEmailDetail } from '../events/publisher.js';
import { escapeHtml } from '../failures/notify.js';
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
  if (league === null || (league.phase !== 'setup' && !(league.phase === 'drafting' && league.draftStartup)))
    return 'ignored';
  const stored = league.settings.draft.scheduledAt;
  if (stored === null || Date.parse(stored) !== Date.parse(detail.scheduledAt)) return 'stale';
  return league;
}

/**
 * Handles `Draft Start Scheduled`: starts the draft through the same path as `start_draft`, with
 * the order the commissioner chose (`draft.orderMode`). When something blocks the start (open human
 * seats, a start week too late), the draft stays in setup and `Draft Start Blocked` tells the
 * commissioner, in chat and by email (`emailBlockedStart`), what to fix.
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
    if (again?.draftStartup) throw error;
    if (again !== null && again.phase !== 'setup') return 'ignored';
    const blocked = {
      leagueId: league.id,
      scheduledAt,
      commissionerId: league.commissionerId,
      code: error.code,
      reason: error.message,
      /* v8 ignore next -- every start_draft error carries a fix */
      fix: error.fix ?? 'Fix the problem, then start the draft with start_draft or set a new draft time.'
    };
    await services.events.publish('Draft Start Blocked', blocked);
    services.log.warn('scheduled draft start blocked', { leagueId: league.id, code: error.code });
    await emailBlockedStart(services, again ?? league, blocked);
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
  if (league.phase !== 'setup') return 'ignored';
  const scheduledAt = league.settings.draft.scheduledAt as string;
  const minutes = Math.max(
    1,
    Math.round((Date.parse(scheduledAt) - services.clock.now().getTime()) / 60_000)
  );
  await services.events.publish('Draft Starting Soon', { leagueId: league.id, scheduledAt, minutes });
  return 'reminded';
}

/** What `Draft Start Blocked` says, which the commissioner's email repeats. */
export interface BlockedStart {
  leagueId: string;
  scheduledAt: string;
  code: string;
  reason: string;
  fix: string;
}

export type BlockedStartEmailOutcome = 'sent' | 'no_email' | 'duplicate' | 'failed';

/** Scope of the claims that keep a blocked start to one email (in the idempotency table). */
export const BLOCKED_START_EMAIL_SCOPE = 'system#draft-start-blocked-email';
/** A claim left by a send that crashed may be taken over after this long. */
const EMAIL_LOCK_MS = 5 * 60_000;
/** Claims outlive any redelivery of the scheduled start. */
const EMAIL_CLAIM_TTL_MS = 30 * 24 * 3_600_000;

/** The `Send Email` detail telling the commissioner their scheduled draft did not start. */
export function blockedStartEmail(
  league: Pick<League, 'name'>,
  to: string,
  blocked: BlockedStart
): SendEmailDetail {
  const when = new Date(blocked.scheduledAt).toUTCString();
  const subject = `Your ${league.name} draft did not start`;
  const lines = [
    `The ${league.name} draft was scheduled for ${when}, but it could not start: ${blocked.reason}`,
    `To fix it: ${blocked.fix}`,
    'The league stays in setup until you start the draft or set a new draft time. The draft room chat says the same.'
  ];
  return {
    to,
    subject,
    text: lines.join('\n\n'),
    html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n')
  };
}

/**
 * Emails the commissioner that the scheduled start was blocked (#134), once per league and
 * scheduled time: the first delivery claims `<leagueId>#<scheduledAt>`, so a redelivered or retried
 * `Draft Start Scheduled` sends nothing more. Nothing here throws: a failed claim or send is logged
 * and returned as `failed`, and the claim's own bookkeeping is best effort, because retrying the
 * whole start would publish `Draft Start Blocked` again (a new event, a second chat line) when chat
 * already told the commissioner.
 */
export async function emailBlockedStart(
  services: Pick<Services, 'repos' | 'events' | 'clock' | 'log'>,
  league: Pick<League, 'name' | 'commissionerEmail'>,
  blocked: BlockedStart
): Promise<BlockedStartEmailOutcome> {
  const log = services.log.child({ leagueId: blocked.leagueId });
  const to = league.commissionerEmail ?? null;
  if (to === null) {
    log.info('no commissioner email for the blocked draft start');
    return 'no_email';
  }
  const key = `${blocked.leagueId}#${blocked.scheduledAt}`;
  const now = services.clock.now();
  const expiresAt = new Date(now.getTime() + EMAIL_CLAIM_TTL_MS);
  let claimed: boolean;
  try {
    const claim = await services.repos.idempotency.begin({
      scope: BLOCKED_START_EMAIL_SCOPE,
      key,
      operation: 'draft_start_blocked_email',
      requestHash: key,
      now,
      lockUntil: new Date(now.getTime() + EMAIL_LOCK_MS),
      expiresAt
    });
    claimed = claim.status === 'started';
  } catch (error) {
    log.error('blocked draft start email not claimed', { error });
    return 'failed';
  }
  if (!claimed) return 'duplicate';
  try {
    await services.events.sendEmail(blockedStartEmail(league, to, blocked));
  } catch (error) {
    log.error('blocked draft start email failed', { error });
    // Best effort: a claim left behind only keeps the lock until it lapses.
    await services.repos.idempotency
      .release(BLOCKED_START_EMAIL_SCOPE, key)
      .catch((releaseError: unknown) =>
        log.warn('blocked draft start email claim not released', { error: releaseError })
      );
    return 'failed';
  }
  // The email went out: a claim not completed is logged, never a reason to retry the start.
  await services.repos.idempotency
    .complete(BLOCKED_START_EMAIL_SCOPE, key, { status: 200, body: { sentAt: now.toISOString() } }, expiresAt)
    .catch((error: unknown) => log.warn('blocked draft start email claim not completed', { error }));
  log.info('blocked draft start emailed to the commissioner');
  return 'sent';
}
