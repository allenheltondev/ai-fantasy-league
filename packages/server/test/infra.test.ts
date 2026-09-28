import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SYSTEM_MESSAGE_EVENTS } from '../src/chat/system-messages.js';
import { NOTIFICATION_EVENT_TYPES } from '../src/notifications/consumer.js';
import { RELAYED_EVENTS, TEAM_INBOX_EVENTS, TEAM_ONLY_EVENTS } from '../src/realtime/relay.js';

/** infra/template.yaml must route exactly the events the chat and realtime handlers understand. */
const template = readFileSync(
  fileURLToPath(new URL('../../../infra/template.yaml', import.meta.url)),
  'utf8'
);

function section(start: string, end: string): string {
  const from = template.indexOf(start);
  expect(from, start).toBeGreaterThan(-1);
  return template.slice(from, template.indexOf(end, from));
}

function detailTypes(block: string): string[] {
  const list = block.slice(block.indexOf('detail-type:'), block.indexOf('RetryPolicy:'));
  return [...list.matchAll(/^\s+- (.+)$/gm)].map((m) => (m[1] as string).trim());
}

describe('chat and realtime infrastructure', () => {
  it('sends every templated or notifying league event to the chat events handler', () => {
    const chat = section('  ChatEventsFunction:', '  RealtimePublisherFunction:');
    expect(chat).toContain('Handler: chat-events.handler');
    expect(detailTypes(chat).sort()).toEqual(
      [...new Set([...SYSTEM_MESSAGE_EVENTS, ...NOTIFICATION_EVENT_TYPES])].sort()
    );
  });

  it('sends every relayed and team-only event to the realtime publisher, which may read the Momento secret', () => {
    const realtime = section('  RealtimePublisherFunction:', 'End of group chat and realtime section');
    expect(realtime).toContain('Handler: realtime.handler');
    expect(detailTypes(realtime).sort()).toEqual(
      [...RELAYED_EVENTS, ...TEAM_ONLY_EVENTS, ...TEAM_INBOX_EVENTS].sort()
    );
    expect(realtime).toContain('Action: secretsmanager:GetSecretValue');
    expect(realtime).toContain('MOMENTO_CACHE_PARAMETER: !Ref MomentoCacheParameterName');
    const api = section('  ApiFunction:', '  DataJobsFunction:');
    expect(api).toContain('MOMENTO_CACHE_PARAMETER: !Ref MomentoCacheParameterName');
  });
});

describe('CloudFront-only API (#104)', () => {
  it('has CloudFront send the origin-verify secret the API requires', () => {
    const origin = section('          - Id: api', '        DefaultCacheBehavior:');
    expect(origin).toContain('- HeaderName: X-Origin-Verify');
    expect(origin).toContain('HeaderValue: !Ref OriginVerifySecret');
    const api = section('  ApiFunction:', '  DataJobsFunction:');
    expect(api).toContain('ORIGIN_VERIFY_SECRET: !Ref OriginVerifySecret');
    expect(api).toContain('ORIGIN_VERIFY_SECRET_PREVIOUS: !Ref OriginVerifySecretPrevious');
  });
});

/** The template's top-level resources: logical id, type, and the block's text. */
function resources(): { id: string; type: string; body: string }[] {
  const body = template.slice(template.indexOf('\nResources:\n'), template.indexOf('\nOutputs:\n'));
  const starts = [...body.matchAll(/^ {2}(\w+):\n {4}Type: (\S+)/gm)];
  return starts.map((m, i) => ({
    id: m[1] as string,
    type: m[2] as string,
    body: body.slice(m.index, starts[i + 1]?.index ?? body.length)
  }));
}

/** A function's events: event id, event type, and the event's text. */
function events(fn: string): { id: string; type: string; body: string }[] {
  const block = fn.slice(fn.indexOf('\n      Events:\n'));
  const starts = [...block.matchAll(/^ {8}(\w+):\n {10}Type: (\w+)/gm)];
  return starts.map((m, i) => ({
    id: m[1] as string,
    type: m[2] as string,
    body: block.slice(m.index, starts[i + 1]?.index ?? block.length)
  }));
}

describe('operations (#130)', () => {
  const all = resources();
  const functions = all.filter((r) => r.type === 'AWS::Serverless::Function');
  const notifier = functions.find((f) => f.id === 'FailureNotifierFunction')?.body ?? '';
  const asyncFunctions = functions.filter((f) => f.id !== 'FailureNotifierFunction');

  it('uses only resource types the deploy role can create', () => {
    expect(template).not.toMatch(/AWS::(CloudWatch|Logs|SQS|SNS)::/);
    expect(template).not.toMatch(/DeadLetterConfig|DeadLetterQueue|LoggingConfig|AlarmActions/);
  });

  it("sends every asynchronously invoked function's failures to the default bus, except the notifier", () => {
    expect(asyncFunctions.map((f) => f.id)).toEqual([
      'ApiFunction',
      'DataJobsFunction',
      'AgentRouterFunction',
      'AgentTaskFunction',
      'ChatEventsFunction',
      'RealtimePublisherFunction'
    ]);
    for (const f of asyncFunctions) {
      // Invoked asynchronously: an EventBridge rule or a Scheduler schedule.
      expect(
        events(f.body).some((e) => e.type === 'EventBridgeRule' || e.type === 'ScheduleV2'),
        f.id
      ).toBe(true);
      expect(f.body, f.id).toContain(
        [
          '      EventInvokeConfig:',
          '        MaximumRetryAttempts: 2',
          '        DestinationConfig:',
          '          OnFailure:',
          '            Type: EventBridge',
          '            Destination: !Sub arn:${AWS::Partition}:events:${AWS::Region}:${AWS::AccountId}:event-bus/default\n'
        ].join('\n')
      );
    }
    // Never its own failure destination: no loop.
    expect(notifier).not.toContain('EventInvokeConfig');
  });

  it("emails this stack's failed invocations through rsc-core's Send Email, with PutEvents only", () => {
    expect(notifier).toContain('Handler: failure-notifier.handler');
    expect(notifier).toContain('ALARM_EMAIL: !Ref AlarmEmail\n');
    expect(notifier).toContain('STACK_NAME: !Ref AWS::StackName\n');
    expect(template).toMatch(/AlarmEmail:\n {4}Type: String\n {4}Default: allenheltondev@gmail\.com\n/);
    const rule = events(notifier).find((e) => e.id === 'InvocationFailed')?.body ?? '';
    expect(rule).toContain('EventBusName: default\n');
    expect(rule).toMatch(/source:\n\s+- lambda\n/);
    expect(rule).toMatch(/detail-type:\n\s+- Lambda Function Invocation Result - Failure\n/);
    // Exactly the functions above (functionArn is qualified: <function ARN>:$LATEST), not itself.
    const prefixes = [...rule.matchAll(/- prefix: !Sub '\$\{(\w+)\.Arn\}:'/g)].map((m) => m[1]);
    expect(prefixes).toEqual(asyncFunctions.map((f) => f.id));
    const policies = notifier.slice(
      notifier.indexOf('      Policies:\n'),
      notifier.indexOf('      Events:\n')
    );
    expect([...policies.matchAll(/Action: (\S+)/g)].map((m) => m[1])).toEqual(['events:PutEvents']);
    expect(policies).toContain('event-bus/default\n');
  });
});
