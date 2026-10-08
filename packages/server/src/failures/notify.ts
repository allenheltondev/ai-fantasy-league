import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import type { PutEventsSender } from '../events/eventbridge.js';
import { SEND_EMAIL, type SendEmailDetail } from '../events/publisher.js';
import type { Logger } from '../log.js';

/**
 * Failure emails (#130). Every asynchronously invoked function in infra/template.yaml has an
 * OnFailure destination on the default bus: when an invocation still fails after Lambda's retries
 * (or ages out), Lambda puts `Lambda Function Invocation Result - Failure` on the bus with the
 * failed event. The FailureNotifierFunction rule forwards this stack's to `notifyFailure`, which
 * turns each into rsc-core's `Send Email` event (rsc-core's SendEmailFunction listens on the
 * default bus for `{ to, subject, html?, text? }`).
 */

export const INVOCATION_FAILURE = 'Lambda Function Invocation Result - Failure';

/** The parts of a `Lambda Function Invocation Result - Failure` event this reads. */
export interface InvocationFailureEvent {
  'detail-type'?: string;
  time?: string;
  detail?: {
    timestamp?: string;
    requestContext?: {
      requestId?: string;
      functionArn?: string;
      condition?: string;
      approximateInvokeCount?: number;
    };
    requestPayload?: unknown;
    responseContext?: { functionError?: string };
    responsePayload?: unknown;
  };
}

export interface FailureNotifierDeps {
  events: PutEventsSender;
  busName: string;
  /** Who gets the email (the template's AlarmEmail). */
  to: string;
  stackName: string;
  log: Logger;
}

export type NotifyResult = { status: 'sent'; functionName: string } | { status: 'ignored'; reason: string };

export const SEND_EMAIL_SOURCE = 'fantasy.failures';
export { SEND_EMAIL, type SendEmailDetail };

/** Subjects stay short enough for a mail client's list view. */
export const MAX_SUBJECT = 200;
/** The failed event is included for replaying by hand, up to this many characters. */
export const MAX_PAYLOAD = 4096;

function truncate(value: string, max: number, marker = '...'): string {
  return value.length > max ? `${value.slice(0, max - marker.length)}${marker}` : value;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** `arn:aws:lambda:<region>:<account>:function:<name>[:<qualifier>]` */
export function parseFunctionArn(arn: string): { region: string; functionName: string } {
  const parts = arn.split(':');
  return { region: parts[3] || 'us-east-1', functionName: parts[6] || arn };
}

/** The function's log group in the CloudWatch Logs console (the console double-encodes, with `$`). */
export function logsUrl(region: string, functionName: string): string {
  const group = encodeURIComponent(encodeURIComponent(`/aws/lambda/${functionName}`)).replaceAll('%', '$');
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${group}`;
}

function errorOf(payload: unknown): { errorType: string; errorMessage: string } {
  const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  return {
    errorType: typeof p.errorType === 'string' ? p.errorType : 'Unknown',
    errorMessage:
      typeof p.errorMessage === 'string'
        ? p.errorMessage
        : payload === undefined
          ? 'No error message (the invocation may have aged out or been throttled).'
          : JSON.stringify(payload)
  };
}

/** The `Send Email` detail for one failed invocation. */
export function failureEmail(
  event: InvocationFailureEvent,
  options: { to: string; stackName: string }
): SendEmailDetail {
  const detail = event.detail ?? {};
  const context = detail.requestContext ?? {};
  const { region, functionName } = parseFunctionArn(context.functionArn ?? 'unknown function');
  const { errorType, errorMessage } = errorOf(detail.responsePayload);
  const condition = context.condition ?? 'unknown';
  const invokes = context.approximateInvokeCount ?? 0;
  const at = detail.timestamp ?? event.time ?? '';
  const payload = truncate(
    JSON.stringify(detail.requestPayload ?? null, null, 2),
    MAX_PAYLOAD,
    '\n... (truncated)'
  );
  const url = logsUrl(region, functionName);
  const subject = truncate(`[${options.stackName}] ${functionName} failed: ${errorMessage}`, MAX_SUBJECT);
  const facts: [string, string][] = [
    ['Stack', options.stackName],
    ['Function', functionName],
    ['Error', `${errorType}: ${errorMessage}`],
    ['Condition', condition],
    ['Invocations', String(invokes)],
    ...(at ? [['At', at] as [string, string]] : []),
    ...(context.requestId ? [['Request id', context.requestId] as [string, string]] : [])
  ];
  const text = [
    `${functionName} failed after ${invokes} invocation(s) (${condition}).`,
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
    `Logs: ${url}`,
    '',
    'The failed event (replay it by hand if it still matters):',
    payload
  ].join('\n');
  const html = [
    `<p><strong>${escapeHtml(functionName)}</strong> failed after ${invokes} invocation(s) (${escapeHtml(condition)}).</p>`,
    `<ul>${facts.map(([k, v]) => `<li>${escapeHtml(k)}: ${escapeHtml(v)}</li>`).join('')}</ul>`,
    `<p><a href="${escapeHtml(url)}">Open the function's logs in CloudWatch</a></p>`,
    '<p>The failed event (replay it by hand if it still matters):</p>',
    `<pre>${escapeHtml(payload)}</pre>`
  ].join('\n');
  return { to: options.to, subject, html, text };
}

/**
 * Emails one failed invocation. The rule forwards only this stack's functions' failures; any other
 * event is ignored (logged, not thrown), so a widened rule never sends noise.
 */
export async function notifyFailure(
  deps: FailureNotifierDeps,
  event: InvocationFailureEvent
): Promise<NotifyResult> {
  if (event['detail-type'] !== INVOCATION_FAILURE) {
    deps.log.warn('not an invocation failure', { detailType: event['detail-type'] });
    return { status: 'ignored', reason: 'not_an_invocation_failure' };
  }
  const arn = event.detail?.requestContext?.functionArn;
  if (arn === undefined) {
    deps.log.warn('invocation failure without a function', {});
    return { status: 'ignored', reason: 'no_function' };
  }
  const { functionName } = parseFunctionArn(arn);
  const email = failureEmail(event, { to: deps.to, stackName: deps.stackName });
  const result = await deps.events.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: deps.busName,
          Source: SEND_EMAIL_SOURCE,
          DetailType: SEND_EMAIL,
          Detail: JSON.stringify(email)
        }
      ]
    })
  );
  if ((result.FailedEntryCount ?? 0) > 0) {
    throw new Error(`EventBridge rejected the "${SEND_EMAIL}" event for ${functionName}`);
  }
  deps.log.info('failure email sent', { functionName });
  return { status: 'sent', functionName };
}
