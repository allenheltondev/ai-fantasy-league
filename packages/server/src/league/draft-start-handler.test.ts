import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../../test/support/harness.js';
import { createLogger } from '../log.js';
import { registry } from '../operations/index.js';
import {
  BLOCKED_START_EMAIL_SCOPE,
  blockedStartEmail,
  emailBlockedStart,
  type BlockedStart
} from './draft-start-handler.js';

/**
 * The commissioner's email when a scheduled draft start is blocked (#134): one per league and
 * scheduled time, however often the start is redelivered or retried. The flow from the scheduled
 * fire is in test/integration/draft-schedule-flows.test.ts.
 */

const BLOCKED: BlockedStart = {
  leagueId: 'lg-1',
  scheduledAt: '2026-09-10T23:00:00.000Z',
  code: 'SEATS_NOT_FILLED',
  reason: '1 human seat is still open: Team <3>.',
  fix: 'Invite someone, or make the seat an agent with set_seat_type.'
};
const LEAGUE = { name: 'Sunday & Funday', commissionerEmail: 'alice@example.com' };

let h: Harness;
beforeEach(async () => {
  h = await createHarness({ registry });
});
afterEach(() => h.close());

describe('blockedStartEmail', () => {
  it('says what blocked the start and how to fix it, with the HTML escaped', () => {
    const email = blockedStartEmail(LEAGUE, 'alice@example.com', BLOCKED);
    expect(email.to).toBe('alice@example.com');
    expect(email.subject).toBe('Your Sunday & Funday draft did not start');
    expect(email.text).toContain('scheduled for Thu, 10 Sep 2026 23:00:00 GMT');
    expect(email.text).toContain(BLOCKED.reason);
    expect(email.text).toContain(`To fix it: ${BLOCKED.fix}`);
    expect(email.html).toContain('Sunday &amp; Funday');
    expect(email.html).toContain('Team &lt;3&gt;.');
    expect(email.html).not.toContain('<3>');
  });
});

describe('emailBlockedStart', () => {
  it('emails the commissioner once per blocked start, however often it is retried', async () => {
    expect(await emailBlockedStart(h.services, LEAGUE, BLOCKED)).toBe('sent');
    expect(await emailBlockedStart(h.services, LEAGUE, BLOCKED)).toBe('duplicate');
    h.clock.advance(60 * 60_000);
    expect(await emailBlockedStart(h.services, LEAGUE, BLOCKED)).toBe('duplicate');
    expect(h.events.emails).toEqual([blockedStartEmail(LEAGUE, 'alice@example.com', BLOCKED)]);
    // A new draft time that is blocked again is a new email.
    const later = { ...BLOCKED, scheduledAt: '2026-09-11T23:00:00.000Z' };
    expect(await emailBlockedStart(h.services, LEAGUE, later)).toBe('sent');
    expect(h.events.emails).toHaveLength(2);
  });

  it('sends nothing without a commissioner email', async () => {
    expect(await emailBlockedStart(h.services, { name: 'L', commissionerEmail: null }, BLOCKED)).toBe(
      'no_email'
    );
    expect(await emailBlockedStart(h.services, { name: 'L' }, BLOCKED)).toBe('no_email');
    expect(h.events.emails).toEqual([]);
  });

  it('releases the claim when the send fails, so a later delivery sends it', async () => {
    const send = vi.spyOn(h.events, 'sendEmail').mockRejectedValueOnce(new Error('bus down'));
    const lines: string[] = [];
    const log = createLogger({ sink: (line) => lines.push(line) });
    expect(await emailBlockedStart({ ...h.services, log }, LEAGUE, BLOCKED)).toBe('failed');
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'blocked draft start email failed',
        leagueId: 'lg-1',
        error: expect.objectContaining({ message: 'bus down' })
      })
    );
    expect(h.events.emails).toEqual([]);
    expect(await emailBlockedStart(h.services, LEAGUE, BLOCKED)).toBe('sent');
    expect(send).toHaveBeenCalledTimes(2);
    expect(h.events.emails).toHaveLength(1);
  });

  it('never throws when its claim bookkeeping fails, so the start is not retried', async () => {
    const messages = (lines: string[]) => lines.map((l) => (JSON.parse(l) as { message: string }).message);
    const logged = () => {
      const lines: string[] = [];
      return { lines, log: createLogger({ sink: (line) => lines.push(line) }) };
    };
    // The claim cannot be taken: nothing is sent.
    const begin = vi.spyOn(h.repos.idempotency, 'begin').mockRejectedValueOnce(new Error('throttled'));
    const a = logged();
    expect(await emailBlockedStart({ ...h.services, log: a.log }, LEAGUE, BLOCKED)).toBe('failed');
    expect(messages(a.lines)).toContain('blocked draft start email not claimed');
    expect(h.events.emails).toEqual([]);
    begin.mockRestore();

    // The send and the release both fail.
    vi.spyOn(h.events, 'sendEmail').mockRejectedValueOnce(new Error('bus down'));
    vi.spyOn(h.repos.idempotency, 'release').mockRejectedValueOnce(new Error('throttled'));
    const b = logged();
    expect(await emailBlockedStart({ ...h.services, log: b.log }, LEAGUE, BLOCKED)).toBe('failed');
    expect(messages(b.lines)).toContain('blocked draft start email claim not released');

    // The email goes out, but its claim is not completed: still sent.
    vi.spyOn(h.repos.idempotency, 'complete').mockRejectedValueOnce(new Error('throttled'));
    const later = { ...BLOCKED, scheduledAt: '2026-09-11T23:00:00.000Z' };
    const c = logged();
    expect(await emailBlockedStart({ ...h.services, log: c.log }, LEAGUE, later)).toBe('sent');
    expect(messages(c.lines)).toContain('blocked draft start email claim not completed');
    expect(h.events.emails).toHaveLength(1);
  });

  it('records a sent email as a completed claim on the league and time', async () => {
    await emailBlockedStart(h.services, LEAGUE, BLOCKED);
    const again = await h.repos.idempotency.begin({
      scope: BLOCKED_START_EMAIL_SCOPE,
      key: `${BLOCKED.leagueId}#${BLOCKED.scheduledAt}`,
      operation: 'draft_start_blocked_email',
      requestHash: `${BLOCKED.leagueId}#${BLOCKED.scheduledAt}`,
      now: h.clock.now(),
      lockUntil: h.clock.now(),
      expiresAt: h.clock.now()
    });
    expect(again).toMatchObject({ status: 'replay' });
  });
});
