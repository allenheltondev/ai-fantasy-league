import type { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { describe, expect, it } from 'vitest';
import { EventBridgePublisher, type PutEventsSender } from './eventbridge.js';
import { InMemoryEventPublisher, scheduleEventDetail } from './publisher.js';

const AT = new Date('2026-10-01T08:00:00.000Z');

describe('scheduleEventDetail', () => {
  it("matches rsc-core's Schedule Event contract", () => {
    expect(
      scheduleEventDetail({
        at: AT,
        name: 'waivers-lg-1-w5',
        whenPast: 'send',
        event: { detailType: 'Trade Expired', detail: { leagueId: 'lg-1', week: 5 } }
      })
    ).toEqual({
      at: '2026-10-01T08:00:00.000Z',
      name: 'waivers-lg-1-w5',
      whenPast: 'send',
      event: { source: 'fantasy', detailType: 'Trade Expired', detail: { leagueId: 'lg-1', week: 5 } }
    });
    expect(scheduleEventDetail({ at: AT, event: { detailType: 'Trade Expired', detail: {} } })).toEqual({
      at: '2026-10-01T08:00:00.000Z',
      event: { source: 'fantasy', detailType: 'Trade Expired', detail: {} }
    });
  });
});

describe('InMemoryEventPublisher', () => {
  it('records publishes, schedules, and cancels', async () => {
    const events = new InMemoryEventPublisher();
    await events.publish('Trade Proposed', { leagueId: 'lg-1' });
    await events.scheduleAt({
      at: AT,
      name: 'n',
      event: { detailType: 'Trade Expired', detail: { tradeId: 't' } }
    });
    await events.cancelScheduled('n');
    expect(events.events.map((e) => [e.source, e.detailType])).toEqual([
      ['fantasy', 'Trade Proposed'],
      ['fantasy', 'Schedule Event'],
      ['fantasy', 'Cancel Scheduled Event']
    ]);
    expect(events.events[2]?.detail).toEqual({ name: 'n' });
  });
});

class FakeSender implements PutEventsSender {
  readonly commands: PutEventsCommand[] = [];
  constructor(private readonly failed = 0) {}
  async send(command: PutEventsCommand) {
    this.commands.push(command);
    return { FailedEntryCount: this.failed };
  }
}

describe('EventBridgePublisher', () => {
  it('puts events on the configured bus with source fantasy', async () => {
    const client = new FakeSender();
    const publisher = new EventBridgePublisher({ client, busName: 'default' });
    await publisher.publish('Trade Accepted', { pick: 1 });
    await publisher.scheduleAt({
      at: AT,
      event: { detailType: 'Trade Countered', detail: { week: 5 } }
    });
    await publisher.cancelScheduled('lock-5');
    const entries = client.commands.map((c) => c.input.Entries?.[0]);
    expect(entries[0]).toEqual({
      EventBusName: 'default',
      Source: 'fantasy',
      DetailType: 'Trade Accepted',
      Detail: '{"pick":1}'
    });
    expect(entries[1]?.DetailType).toBe('Schedule Event');
    expect(JSON.parse(entries[1]?.Detail ?? '')).toEqual({
      at: AT.toISOString(),
      event: { source: 'fantasy', detailType: 'Trade Countered', detail: { week: 5 } }
    });
    expect(entries[2]).toMatchObject({ DetailType: 'Cancel Scheduled Event', Detail: '{"name":"lock-5"}' });
  });

  it('throws when EventBridge rejects the entry', async () => {
    const publisher = new EventBridgePublisher({ client: new FakeSender(1) });
    await expect(publisher.publish('Trade Vetoed', {})).rejects.toThrow(/rejected/);
  });

  it('builds a real client by default', () => {
    expect(new EventBridgePublisher()).toBeInstanceOf(EventBridgePublisher);
  });
});
