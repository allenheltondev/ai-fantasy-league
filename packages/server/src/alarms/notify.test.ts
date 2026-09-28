import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../log.js';
import { createAlarmNotifierDeps, handler } from './lambda.js';
import { alarmEmail, consoleUrl, notifyAlarm, type AlarmStateChangeEvent } from './notify.js';

const STACK = 'fantasy-staging';

function alarmEvent(
  overrides: Partial<NonNullable<AlarmStateChangeEvent['detail']>> = {}
): AlarmStateChangeEvent {
  return {
    'detail-type': 'CloudWatch Alarm State Change',
    region: 'us-east-1',
    time: '2026-09-28T08:05:00Z',
    detail: {
      alarmName: `${STACK}-DataJobsErrors`,
      state: {
        value: 'ALARM',
        reason: 'Threshold Crossed: 1 datapoint [2.0] was >= the threshold (1.0).',
        timestamp: '2026-09-28T08:05:00.000+0000'
      },
      previousState: { value: 'OK' },
      configuration: { description: 'An invocation of the scheduled data jobs failed.' },
      ...overrides
    }
  };
}

function fakeBus(failed = 0) {
  const sent: PutEventsCommand[] = [];
  return {
    sent,
    client: {
      send: async (command: PutEventsCommand) => {
        sent.push(command);
        return { FailedEntryCount: failed };
      }
    }
  };
}

const deps = (bus: ReturnType<typeof fakeBus>, log = silentLogger) => ({
  events: bus.client,
  busName: 'default',
  to: 'ops@example.com',
  stackName: STACK,
  log
});

describe('notifyAlarm', () => {
  it("publishes rsc-core's Send Email with the stack, alarm, reason, and a console link", async () => {
    const bus = fakeBus();
    expect(await notifyAlarm(deps(bus), alarmEvent())).toEqual({
      status: 'sent',
      alarmName: `${STACK}-DataJobsErrors`
    });
    expect(bus.sent).toHaveLength(1);
    const [entry] = bus.sent[0]?.input.Entries ?? [];
    expect(entry).toMatchObject({
      EventBusName: 'default',
      Source: 'fantasy.alarms',
      DetailType: 'Send Email'
    });
    const email = JSON.parse(entry?.Detail as string);
    expect(Object.keys(email).sort()).toEqual(['html', 'subject', 'text', 'to']);
    expect(email.to).toBe('ops@example.com');
    expect(email.subject).toBe(
      `[${STACK}] ALARM: ${STACK}-DataJobsErrors - Threshold Crossed: 1 datapoint [2.0] was >= the threshold (1.0).`
    );
    const url = `https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:alarm/${STACK}-DataJobsErrors`;
    expect(email.text).toContain(`Alarm: ${url}`);
    expect(email.text).toContain('(was OK)');
    expect(email.text).toContain('An invocation of the scheduled data jobs failed.');
    expect(email.html).toContain(`<a href="${url}">`);
    expect(email.html).toContain('was &gt;= the threshold');
  });

  it('ignores states other than ALARM, other events, and other stacks without sending', async () => {
    const bus = fakeBus();
    const log = { ...silentLogger, warn: vi.fn() };
    for (const value of ['OK', 'INSUFFICIENT_DATA', undefined]) {
      expect(await notifyAlarm(deps(bus, log), alarmEvent({ state: { value } }))).toEqual({
        status: 'ignored',
        reason: 'not_in_alarm'
      });
    }
    expect(await notifyAlarm(deps(bus, log), { ...alarmEvent(), 'detail-type': 'Scores Updated' })).toEqual({
      status: 'ignored',
      reason: 'not_an_alarm_state_change'
    });
    expect(await notifyAlarm(deps(bus, log), alarmEvent({ alarmName: 'other-stack-Errors' }))).toEqual({
      status: 'ignored',
      reason: 'other_stack'
    });
    expect(await notifyAlarm(deps(bus, log), alarmEvent({ alarmName: undefined }))).toMatchObject({
      reason: 'other_stack'
    });
    expect(bus.sent).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledTimes(3);
  });

  it('fails when EventBridge rejects the email, so Lambda retries it', async () => {
    await expect(notifyAlarm(deps(fakeBus(1)), alarmEvent())).rejects.toThrow(
      'rejected the "Send Email" event'
    );
  });
});

describe('alarmEmail', () => {
  it('fills in missing fields and escapes HTML', () => {
    const email = alarmEmail(
      { detail: { state: { value: 'ALARM', reason: '<script>' } } },
      { to: 'a@b.c', stackName: 's' }
    );
    expect(email.subject).toBe('[s] ALARM: unknown alarm - <script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).not.toContain('<script>');
    expect(email.text).not.toContain('At:');
    expect(email.text).not.toContain('(was');
    expect(email.text).toContain(consoleUrl('us-east-1', 'unknown alarm'));
    const bare = alarmEmail({}, { to: 'a@b.c', stackName: 's' });
    expect(bare.text).toContain('Reason: No reason given.');
  });

  it('keeps the subject short', () => {
    const email = alarmEmail(alarmEvent({ state: { value: 'ALARM', reason: 'x'.repeat(500) } }), {
      to: 'a@b.c',
      stackName: STACK
    });
    expect(email.subject).toHaveLength(200);
    expect(email.subject.endsWith('...')).toBe(true);
  });
});

describe('alarm notifier Lambda', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads its settings from the environment', () => {
    const bus = fakeBus();
    expect(
      createAlarmNotifierDeps({ ALARM_EMAIL: 'ops@example.com', STACK_NAME: STACK }, bus.client)
    ).toMatchObject({ busName: 'default', to: 'ops@example.com', stackName: STACK });
    expect(() => createAlarmNotifierDeps({ STACK_NAME: STACK })).toThrow('ALARM_EMAIL');
  });

  it('sends through the SDK client', async () => {
    vi.stubEnv('ALARM_EMAIL', 'ops@example.com');
    vi.stubEnv('STACK_NAME', STACK);
    vi.stubEnv('AWS_REGION', 'us-east-1');
    vi.stubEnv('LOG_LEVEL', 'error');
    const send = vi
      .spyOn(EventBridgeClient.prototype, 'send')
      .mockResolvedValue({ FailedEntryCount: 0 } as never);
    expect(await handler(alarmEvent())).toMatchObject({ status: 'sent' });
    expect(send).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });
});
