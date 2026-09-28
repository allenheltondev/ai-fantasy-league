import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SYSTEM_MESSAGE_EVENTS } from '../src/chat/system-messages.js';
import { createLogger } from '../src/log.js';
import { RELAYED_EVENTS, TEAM_ONLY_EVENTS } from '../src/realtime/relay.js';

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
  it('sends every templated league event to the system-message handler', () => {
    const chat = section('  ChatEventsFunction:', '  RealtimePublisherFunction:');
    expect(chat).toContain('Handler: chat-events.handler');
    expect(detailTypes(chat).sort()).toEqual([...SYSTEM_MESSAGE_EVENTS].sort());
  });

  it('sends every relayed and team-only event to the realtime publisher, which may read the Momento secret', () => {
    const realtime = section('  RealtimePublisherFunction:', 'End of group chat and realtime section');
    expect(realtime).toContain('Handler: realtime.handler');
    expect(detailTypes(realtime).sort()).toEqual([...RELAYED_EVENTS, ...TEAM_ONLY_EVENTS].sort());
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
  const alarms = all.filter((r) => r.type === 'AWS::CloudWatch::Alarm');
  const lambdaAlarms = (metric: string) =>
    alarms
      .filter((a) => a.body.includes('Namespace: AWS/Lambda') && a.body.includes(`MetricName: ${metric}\n`))
      .map((a) => /Value: !Ref (\w+)/.exec(a.body)?.[1]);

  it('finds the functions it alarms on', () => {
    expect(functions.map((f) => f.id)).toEqual([
      'ApiFunction',
      'DataJobsFunction',
      'AgentRouterFunction',
      'AgentTaskFunction',
      'ChatEventsFunction',
      'RealtimePublisherFunction',
      'AlarmNotifierFunction'
    ]);
  });

  it('gives every EventBridge rule and schedule target the dead-letter queue', () => {
    const targets = functions.flatMap((f) => events(f.body).map((e) => ({ ...e, fn: f.id })));
    expect(targets.filter((t) => t.type === 'EventBridgeRule')).toHaveLength(6);
    expect(targets.filter((t) => t.type === 'ScheduleV2')).toHaveLength(11);
    const policy = all.find((r) => r.id === 'EventsDeadLetterQueuePolicy')?.body ?? '';
    expect(policy).toContain('Service: events.amazonaws.com');
    for (const t of targets) {
      expect(t.body, `${t.fn}.${t.id}`).toMatch(
        /\n {12}DeadLetterConfig:\n {14}Arn: !GetAtt EventsDeadLetterQueue\.Arn\n/
      );
      // SAM names a rule <Function><Event>; the queue policy admits exactly those rules.
      if (t.type === 'EventBridgeRule') expect(policy).toContain(`- !GetAtt ${t.fn}${t.id}.Arn\n`);
    }
    // The six rules, plus the queue itself as the Resource.
    expect([...policy.matchAll(/!GetAtt (\w+)\.Arn/g)]).toHaveLength(7);
    const dlqAlarm = all.find((r) => r.id === 'EventsDeadLetterAlarm')?.body ?? '';
    expect(dlqAlarm).toContain('MetricName: ApproximateNumberOfMessagesVisible');
    expect(dlqAlarm).toContain('Value: !GetAtt EventsDeadLetterQueue.QueueName');
    expect(dlqAlarm).toContain('ComparisonOperator: GreaterThanThreshold');
    expect(dlqAlarm).toContain('Threshold: 0\n');
  });

  it('dead-letters failed asynchronous invocations of every event-driven function', () => {
    for (const f of functions) {
      const eventDriven = events(f.body).some((e) => e.type === 'EventBridgeRule');
      expect(f.body.includes('TargetArn: !GetAtt EventsDeadLetterQueue.Arn'), f.id).toBe(eventDriven);
    }
  });

  it('alarms on Errors and Throttles for every function', () => {
    const ids = functions.map((f) => f.id).sort();
    expect(lambdaAlarms('Errors').sort()).toEqual(ids);
    expect(lambdaAlarms('Throttles').sort()).toEqual(ids);
  });

  it('alarms on error logs from every function, in the shape the logger writes', () => {
    const lines: string[] = [];
    createLogger({ sink: (l) => lines.push(l) }).error('job failed', { job: 'processWaivers' });
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: 'error', message: 'job failed' });

    for (const f of functions) {
      const group = /LoggingConfig:\n {8}LogGroup: !Ref (\w+)/.exec(f.body)?.[1];
      expect(group, f.id).toBeDefined();
      expect(all.find((r) => r.id === group)?.type, f.id).toBe('AWS::Logs::LogGroup');
      const filter = all.find(
        (r) => r.type === 'AWS::Logs::MetricFilter' && r.body.includes(`LogGroupName: !Ref ${group}\n`)
      );
      expect(filter?.body, f.id).toContain(`FilterPattern: '{ $.level = "error" }'`);
      const metric = /MetricName: (\w+)/.exec(filter?.body ?? '')?.[1];
      expect(
        alarms.some((a) => a.body.includes(`MetricName: ${metric}\n`)),
        `${f.id} error-log alarm`
      ).toBe(true);
    }
  });

  it('names every alarm with the stack prefix, and uses no SNS', () => {
    // Three per function, plus the dead-letter queue.
    expect(alarms).toHaveLength(functions.length * 3 + 1);
    for (const a of alarms) {
      expect(a.body, a.id).toContain(`AlarmName: !Sub \${AWS::StackName}-${a.id}\n`);
      expect(a.body, a.id).not.toMatch(/AlarmActions|OKActions/);
    }
    expect(template).not.toMatch(/AWS::SNS::|\bsns:\w/i);
  });

  it("emails this stack's alarms entering ALARM through rsc-core's Send Email, with PutEvents only", () => {
    const notifier = functions.find((f) => f.id === 'AlarmNotifierFunction')?.body ?? '';
    expect(notifier).toContain('Handler: alarm-notifier.handler');
    expect(notifier).toContain('ALARM_EMAIL: !Ref AlarmEmail\n');
    expect(notifier).toContain('STACK_NAME: !Ref AWS::StackName\n');
    const rule = events(notifier).find((e) => e.id === 'AlarmStateChange')?.body ?? '';
    expect(rule).toContain('EventBusName: default\n');
    expect(rule).toMatch(/source:\n\s+- aws\.cloudwatch\n/);
    expect(rule).toMatch(/detail-type:\n\s+- CloudWatch Alarm State Change\n/);
    // The same prefix every AlarmName starts with.
    expect(rule).toMatch(/alarmName:\n\s+- prefix: !Sub \$\{AWS::StackName\}-\n/);
    expect(rule).toMatch(/state:\n\s+value:\n\s+- ALARM\n/);
    const policies = notifier.slice(
      notifier.indexOf('      Policies:\n'),
      notifier.indexOf('      Events:\n')
    );
    expect([...policies.matchAll(/Action: (\S+)/g)].map((m) => m[1])).toEqual(['events:PutEvents']);
    expect(policies).toContain('event-bus/default\n');
    expect(template).toMatch(/AlarmEmail:\n {4}Type: String\n {4}Default: allenheltondev@gmail\.com\n/);
  });
});
