import { FixedClock, yahooDefaultSettings } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import type { BusEvent } from '../events/bus.js';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { newTeam } from '../league/seats.js';
import { silentLogger } from '../log.js';
import { createInMemoryRepos } from '../repos/memory.js';
import type { League } from '../repos/types.js';
import { writeNotifications } from './consumer.js';
import { isRead, notificationId, notificationLocalKeyOf } from './model.js';

const START = '2026-10-04T15:00:00.000Z';

async function setup() {
  const repos = createInMemoryRepos();
  const clock = new FixedClock(new Date(START));
  const events = new InMemoryEventPublisher();
  const settings = yahooDefaultSettings(4);
  const league: League = {
    id: 'lg',
    name: 'L',
    season: 2026,
    phase: 'regular_season',
    week: 5,
    settings,
    commissionerId: 'ann',
    commissionerName: 'Ann',
    createdBy: 'ann',
    scheduleSeed: 's',
    deadlines: { draftStartsAt: null, nextLineupLockAt: null, nextWaiverRunAt: null, tradeDeadlineAt: null },
    createdAt: START,
    updatedAt: START,
    version: 1
  };
  await repos.leagues.create(league);
  const now = new Date('2026-09-01T00:00:00.000Z');
  await repos.teams.create([
    newTeam({
      leagueId: 'lg',
      id: 'team-1',
      draftSlot: 1,
      settings,
      now,
      owner: { userId: 'ann', name: 'Ann', teamName: 'Aces' }
    }),
    newTeam({
      leagueId: 'lg',
      id: 'team-2',
      draftSlot: 2,
      settings,
      now,
      owner: { userId: 'ben', name: 'Ben', teamName: 'Bombers' }
    }),
    newTeam({ leagueId: 'lg', id: 'team-3', draftSlot: 3, settings, now })
  ]);
  const services = { repos, clock, events, log: silentLogger };
  return { repos, clock, events, services };
}

const bus = (detailType: string, detail: unknown, extra: Partial<BusEvent> = {}): BusEvent => ({
  id: 'evt-1',
  'detail-type': detailType,
  source: 'fantasy',
  time: START,
  detail,
  ...extra
});

describe('writeNotifications', () => {
  it('skips events that are not ours, not notifying, or have no league', async () => {
    const { services } = await setup();
    expect(await writeNotifications(services, bus('Trade Proposed', {}, { source: 'other' }))).toEqual({
      status: 'skipped',
      reason: 'not_ours'
    });
    expect(await writeNotifications(services, bus('League Created', {}))).toMatchObject({
      reason: 'not_notifiable'
    });
    expect(await writeNotifications(services, bus('Draft Turn Started', { teamId: 'team-1' }))).toMatchObject(
      {
        reason: 'no_league'
      }
    );
    expect(
      await writeNotifications(services, bus('Draft Turn Started', { leagueId: 'nope', teamId: 'team-1' }))
    ).toMatchObject({ reason: 'no_league' });
  });

  it('notifies only people, and only for events from their time on the seat', async () => {
    const { services, repos, events } = await setup();
    expect(
      await writeNotifications(services, bus('Draft Turn Started', { leagueId: 'lg', teamId: 'team-3' }))
    ).toEqual({ status: 'skipped', reason: 'nobody' });
    const team = await repos.teams.get('lg', 'team-2');
    await repos.teams.update({
      ...(team as NonNullable<typeof team>),
      occupiedSince: '2026-10-05T00:00:00.000Z'
    });
    expect(
      await writeNotifications(
        services,
        bus('Draft Turn Started', { leagueId: 'lg', teamId: 'team-2', pick: 2 })
      )
    ).toMatchObject({ reason: 'nobody' });
    expect(events.events).toEqual([]);
  });

  it('writes each team its waiver results, stamped with the event time (or now without one)', async () => {
    const { services, repos, events, clock } = await setup();
    const detail = {
      leagueId: 'lg',
      awarded: [{ teamId: 'team-1', playerId: 'p1', player: { name: 'Pat' }, cost: 4 }],
      lost: [
        { teamId: 'team-1', playerId: 'p2', player: null, reason: 'Outbid.' },
        { teamId: 'team-3', playerId: 'p3', player: null, reason: 'Roster full.' }
      ]
    };
    clock.advance(5_000);
    const outcome = await writeNotifications(services, bus('Waivers Processed', detail, { time: undefined }));
    expect(outcome).toMatchObject({ status: 'written', duplicates: 0 });
    const page = await repos.notifications.list('lg', 'team-1', { limit: 10, visibleFrom: START });
    expect(page.notifications.map((n) => [n.kind, n.body, n.createdAt])).toEqual([
      ['waiver_won', 'Added to your roster: Pat ($4).', '2026-10-04T15:00:05.000Z'],
      ['waiver_lost', 'Outbid.', '2026-10-04T15:00:05.000Z']
    ]);
    expect(events.events.map((e) => e.detailType)).toEqual(['Notification Created', 'Notification Created']);
    expect(await repos.notifications.list('lg', 'team-3', { limit: 10, visibleFrom: START })).toMatchObject({
      notifications: []
    });
  });
});

describe('notification ids', () => {
  it('round-trip their local key and reject anything else', () => {
    const local = `${START}#evt-9-won`;
    const id = notificationId(local);
    expect(notificationLocalKeyOf(id)).toBe(local);
    for (const bad of ['', 'x!', notificationId('nope'), notificationId(`${START}#a#b`), 'a'.repeat(401)]) {
      expect(notificationLocalKeyOf(bad), bad).toBeNull();
    }
  });

  it('are read when marked, or when "mark all" came after them', () => {
    const n = { readAt: null, createdAt: START } as Parameters<typeof isRead>[0];
    expect(isRead(n, null)).toBe(false);
    expect(isRead(n, START)).toBe(true);
    expect(isRead(n, '2026-10-04T14:00:00.000Z')).toBe(false);
    expect(isRead({ ...n, readAt: START }, null)).toBe(true);
  });
});

describe('in-memory notifications', () => {
  it('drops only the deleted league’s inboxes', async () => {
    const { repos } = await setup();
    const item = (leagueId: string) => ({
      id: notificationId(`${START}#evt-${leagueId}`),
      leagueId,
      teamId: 'team-1',
      kind: 'trade_offer' as const,
      title: 't',
      body: 'b',
      target: { section: 'trades' as const, tradeId: null },
      event: { detailType: 'Trade Proposed', eventId: `evt-${leagueId}` },
      createdAt: START,
      readAt: null,
      deliveredAt: null
    });
    await repos.notifications.put(item('lg'));
    await repos.notifications.put(item('other'));
    await repos.notifications.markAllRead('lg', 'team-1', START);
    await repos.notifications.markAllRead('other', 'team-1', START);
    await repos.leagues.delete('lg');
    expect(await repos.notifications.list('lg', 'team-1', { limit: 5, visibleFrom: START })).toEqual({
      notifications: [],
      nextCursor: null
    });
    expect(await repos.notifications.list('other', 'team-1', { limit: 5, visibleFrom: START })).toMatchObject(
      {
        notifications: [{ leagueId: 'other', read: true }]
      }
    );
  });
});
