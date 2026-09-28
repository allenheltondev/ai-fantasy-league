import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../log.js';
import { createFailureNotifierDeps, handler } from './lambda.js';
import {
  failureEmail,
  logsUrl,
  MAX_PAYLOAD,
  notifyFailure,
  parseFunctionArn,
  type InvocationFailureEvent
} from './notify.js';

const STACK = 'fantasy-staging';
const FUNCTION = 'fantasy-staging-DataJobsFunction-Ab12Cd34Ef56';
const ARN = `arn:aws:lambda:us-east-1:123456789012:function:${FUNCTION}:$LATEST`;

/** A `Lambda Function Invocation Result - Failure` event as Lambda puts it on the bus. */
function failureEvent(
  detail: Partial<NonNullable<InvocationFailureEvent['detail']>> = {}
): InvocationFailureEvent {
  return {
    version: '0',
    id: '3b0e4bd1-7a49-2c47-0fd6-5b7c4b0ab8a1',
    'detail-type': 'Lambda Function Invocation Result - Failure',
    source: 'lambda',
    account: '123456789012',
    time: '2026-09-28T08:03:12Z',
    region: 'us-east-1',
    resources: ['arn:aws:events:us-east-1:123456789012:event-bus/default', ARN],
    detail: {
      version: '1.0',
      timestamp: '2026-09-28T08:03:12.345Z',
      requestContext: {
        requestId: 'e4b46cbf-b738-500f-bb5a-4b1d7e8a3c01',
        functionArn: ARN,
        condition: 'RetriesExhausted',
        approximateInvokeCount: 3
      },
      requestPayload: { job: 'processWaivers' },
      responseContext: { statusCode: 200, executedVersion: '$LATEST', functionError: 'Unhandled' },
      responsePayload: {
        errorType: 'Error',
        errorMessage: 'Waiver processing failed for 1 of 3 leagues: lg-7',
        trace: [
          'Error: Waiver processing failed for 1 of 3 leagues: lg-7',
          '    at processWaivers (jobs.mjs:1:2)'
        ]
      },
      ...detail
    }
  } as InvocationFailureEvent;
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

describe('notifyFailure', () => {
  it("publishes rsc-core's Send Email naming the stack, function, error, and the failed event", async () => {
    const bus = fakeBus();
    expect(await notifyFailure(deps(bus), failureEvent())).toEqual({
      status: 'sent',
      functionName: FUNCTION
    });
    expect(bus.sent).toHaveLength(1);
    const [entry] = bus.sent[0]?.input.Entries ?? [];
    expect(entry).toMatchObject({
      EventBusName: 'default',
      Source: 'fantasy.failures',
      DetailType: 'Send Email'
    });
    const email = JSON.parse(entry?.Detail as string);
    expect(Object.keys(email).sort()).toEqual(['html', 'subject', 'text', 'to']);
    expect(email.to).toBe('ops@example.com');
    expect(email.subject).toBe(
      `[${STACK}] ${FUNCTION} failed: Waiver processing failed for 1 of 3 leagues: lg-7`
    );
    const url = `https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/$252Faws$252Flambda$252F${FUNCTION}`;
    expect(email.text).toContain(`${FUNCTION} failed after 3 invocation(s) (RetriesExhausted).`);
    expect(email.text).toContain('Error: Error: Waiver processing failed for 1 of 3 leagues: lg-7');
    expect(email.text).toContain('Invocations: 3');
    expect(email.text).toContain('Condition: RetriesExhausted');
    expect(email.text).toContain('Request id: e4b46cbf-b738-500f-bb5a-4b1d7e8a3c01');
    expect(email.text).toContain(`Logs: ${url}`);
    expect(email.text).toContain('"job": "processWaivers"');
    expect(email.html).toContain(`<a href="${url}">`);
    expect(email.html).toContain('<pre>{\n  &quot;job&quot;: &quot;processWaivers&quot;\n}</pre>');
  });

  it('ignores other events without sending', async () => {
    const bus = fakeBus();
    const log = { ...silentLogger, warn: vi.fn() };
    expect(
      await notifyFailure(deps(bus, log), {
        ...failureEvent(),
        'detail-type': 'Lambda Function Invocation Result - Success'
      })
    ).toEqual({ status: 'ignored', reason: 'not_an_invocation_failure' });
    expect(await notifyFailure(deps(bus, log), failureEvent({ requestContext: {} }))).toEqual({
      status: 'ignored',
      reason: 'no_function'
    });
    expect(bus.sent).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('fails when EventBridge rejects the email, so Lambda retries it', async () => {
    await expect(notifyFailure(deps(fakeBus(1)), failureEvent())).rejects.toThrow(
      'rejected the "Send Email" event'
    );
  });
});

describe('failureEmail', () => {
  const opts = { to: 'a@b.c', stackName: STACK };

  it('caps the subject and the failed event', () => {
    const email = failureEmail(
      failureEvent({
        requestPayload: { detail: 'x'.repeat(10_000) },
        responsePayload: { errorType: 'Error', errorMessage: 'y'.repeat(500) }
      }),
      opts
    );
    expect(email.subject).toHaveLength(200);
    expect(email.subject.endsWith('...')).toBe(true);
    const payload = email.text.slice(email.text.indexOf('{'));
    expect(payload.length).toBe(MAX_PAYLOAD);
    expect(payload.endsWith('\n... (truncated)')).toBe(true);
  });

  it('copes with an aged-out invocation that has no error payload, and escapes HTML', () => {
    const email = failureEmail(
      {
        'detail-type': 'Lambda Function Invocation Result - Failure',
        detail: {
          requestContext: { functionArn: ARN, condition: 'EventAgeExceeded', approximateInvokeCount: 1 },
          requestPayload: { detail: '<b>' }
        }
      },
      opts
    );
    expect(email.subject).toContain('No error message');
    expect(email.text).toContain('Error: Unknown: No error message');
    expect(email.text).not.toContain('At:');
    expect(email.text).not.toContain('Request id:');
    expect(email.html).toContain('&lt;b&gt;');
    expect(email.html).not.toContain('<b>');

    const odd = failureEmail({ detail: { responsePayload: 'boom' } }, opts);
    expect(odd.text).toContain('Error: Unknown: "boom"');
    expect(odd.text).toContain('failed after 0 invocation(s) (unknown)');
    expect(odd.text).toContain('null');
    expect(failureEmail({}, opts).subject).toContain('unknown function failed');
  });

  it('reads the region and name from a function ARN, with or without a qualifier', () => {
    expect(parseFunctionArn(ARN)).toEqual({ region: 'us-east-1', functionName: FUNCTION });
    expect(parseFunctionArn('arn:aws:lambda:eu-west-1:1:function:f')).toEqual({
      region: 'eu-west-1',
      functionName: 'f'
    });
    expect(parseFunctionArn('nonsense')).toEqual({ region: 'us-east-1', functionName: 'nonsense' });
    expect(logsUrl('eu-west-1', 'f')).toBe(
      'https://eu-west-1.console.aws.amazon.com/cloudwatch/home?region=eu-west-1#logsV2:log-groups/log-group/$252Faws$252Flambda$252Ff'
    );
  });
});

describe('failure notifier Lambda', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('reads its settings from the environment', () => {
    const bus = fakeBus();
    expect(
      createFailureNotifierDeps({ ALARM_EMAIL: 'ops@example.com', STACK_NAME: STACK }, bus.client)
    ).toMatchObject({
      busName: 'default',
      to: 'ops@example.com',
      stackName: STACK
    });
    expect(() => createFailureNotifierDeps({ STACK_NAME: STACK })).toThrow('ALARM_EMAIL');
  });

  it('sends through the SDK client', async () => {
    vi.stubEnv('ALARM_EMAIL', 'ops@example.com');
    vi.stubEnv('STACK_NAME', STACK);
    vi.stubEnv('AWS_REGION', 'us-east-1');
    vi.stubEnv('LOG_LEVEL', 'error');
    const send = vi
      .spyOn(EventBridgeClient.prototype, 'send')
      .mockResolvedValue({ FailedEntryCount: 0 } as never);
    expect(await handler(failureEvent())).toMatchObject({ status: 'sent' });
    expect(send).toHaveBeenCalledOnce();
  });
});
