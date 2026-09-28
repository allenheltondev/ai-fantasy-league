import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import type { PutEventsSender } from '../events/eventbridge.js';
import type { Logger } from '../log.js';

/**
 * Alarm notifications (#130). CloudWatch emits `CloudWatch Alarm State Change` on the default bus;
 * the AlarmNotifierFunction rule in infra/template.yaml forwards this stack's alarms entering ALARM
 * here, and this turns each into rsc-core's `Send Email` event (rsc-core's SendEmailFunction
 * listens on the default bus for `{ to, subject, html?, text? }`).
 */

/** The parts of a `CloudWatch Alarm State Change` event this reads. */
export interface AlarmStateChangeEvent {
  'detail-type'?: string;
  region?: string;
  time?: string;
  detail?: {
    alarmName?: string;
    state?: { value?: string; reason?: string; timestamp?: string };
    previousState?: { value?: string };
    configuration?: { description?: string };
  };
}

export interface SendEmailDetail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface AlarmNotifierDeps {
  events: PutEventsSender;
  busName: string;
  /** Who gets the email (the template's AlarmEmail). */
  to: string;
  stackName: string;
  log: Logger;
}

export type NotifyResult = { status: 'sent'; alarmName: string } | { status: 'ignored'; reason: string };

export const SEND_EMAIL_SOURCE = 'fantasy.alarms';
export const SEND_EMAIL = 'Send Email';

/** Subjects stay short enough for a mail client's list view. */
const MAX_SUBJECT = 200;

export function consoleUrl(region: string, alarmName: string): string {
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(alarmName)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** The `Send Email` detail for an alarm that entered ALARM. */
export function alarmEmail(
  event: AlarmStateChangeEvent,
  options: { to: string; stackName: string }
): SendEmailDetail {
  const detail = event.detail ?? {};
  const alarmName = detail.alarmName ?? 'unknown alarm';
  const reason = detail.state?.reason ?? 'No reason given.';
  const description = detail.configuration?.description;
  const region = event.region ?? 'us-east-1';
  const at = detail.state?.timestamp ?? event.time ?? '';
  const url = consoleUrl(region, alarmName);
  const subject = `[${options.stackName}] ALARM: ${alarmName} - ${reason}`;
  const lines = [
    `${alarmName} is in ALARM${detail.previousState?.value ? ` (was ${detail.previousState.value})` : ''}.`,
    ...(description ? [description] : []),
    `Reason: ${reason}`,
    ...(at ? [`At: ${at}`] : []),
    `Stack: ${options.stackName}`,
    `Alarm: ${url}`
  ];
  const html = [
    `<p><strong>${escapeHtml(alarmName)}</strong> is in ALARM${
      detail.previousState?.value ? ` (was ${escapeHtml(detail.previousState.value)})` : ''
    }.</p>`,
    ...(description ? [`<p>${escapeHtml(description)}</p>`] : []),
    `<p>Reason: ${escapeHtml(reason)}</p>`,
    ...(at ? [`<p>At: ${escapeHtml(at)}</p>`] : []),
    `<p>Stack: ${escapeHtml(options.stackName)}</p>`,
    `<p><a href="${escapeHtml(url)}">Open the alarm in the CloudWatch console</a></p>`
  ].join('\n');
  return {
    to: options.to,
    subject: subject.length > MAX_SUBJECT ? `${subject.slice(0, MAX_SUBJECT - 3)}...` : subject,
    html,
    text: lines.join('\n')
  };
}

/**
 * Emails one alarm state change. The rule only forwards ALARM states of this stack's alarms; any
 * other event is ignored (logged, not thrown), so a widened rule never sends noise.
 */
export async function notifyAlarm(
  deps: AlarmNotifierDeps,
  event: AlarmStateChangeEvent
): Promise<NotifyResult> {
  if (event['detail-type'] !== 'CloudWatch Alarm State Change') {
    deps.log.warn('not an alarm state change', { detailType: event['detail-type'] });
    return { status: 'ignored', reason: 'not_an_alarm_state_change' };
  }
  const alarmName = event.detail?.alarmName;
  if (event.detail?.state?.value !== 'ALARM') {
    return { status: 'ignored', reason: 'not_in_alarm' };
  }
  if (alarmName === undefined || !alarmName.startsWith(`${deps.stackName}-`)) {
    deps.log.warn('alarm from another stack', { alarmName });
    return { status: 'ignored', reason: 'other_stack' };
  }
  const email = alarmEmail(event, { to: deps.to, stackName: deps.stackName });
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
    throw new Error(`EventBridge rejected the "${SEND_EMAIL}" event for ${alarmName}`);
  }
  deps.log.info('alarm email sent', { alarmName });
  return { status: 'sent', alarmName };
}
