import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SYSTEM_MESSAGE_EVENTS } from '../src/chat/system-messages.js';
import { RELAYED_EVENTS } from '../src/realtime/relay.js';

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

  it('sends every relayed event to the realtime publisher, which may read the Momento secret', () => {
    const realtime = section('  RealtimePublisherFunction:', 'End of group chat and realtime section');
    expect(realtime).toContain('Handler: realtime.handler');
    expect(detailTypes(realtime).sort()).toEqual([...RELAYED_EVENTS].sort());
    expect(realtime).toContain('Action: secretsmanager:GetSecretValue');
    expect(realtime).toContain('MOMENTO_CACHE_PARAMETER: !Ref MomentoCacheParameterName');
    const api = section('  ApiFunction:', '  DataJobsFunction:');
    expect(api).toContain('MOMENTO_CACHE_PARAMETER: !Ref MomentoCacheParameterName');
  });
});
