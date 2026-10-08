import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusEvent } from '../../src/events/bus.js';
import { silentLogger } from '../../src/log.js';
import { writeNotifications } from '../../src/notifications/consumer.js';
import { registry } from '../../src/operations/index.js';
import { InMemoryRealtime, seatTenureKey, teamChannel } from '../../src/realtime/realtime.js';
import { relayEvent } from '../../src/realtime/relay.js';
import { createHarness, START, type Harness } from '../support/harness.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE, BOB, CAROL } from '../support/leagues.js';
import { seedSeasonLeague } from '../support/waivers.js';

/**
 * The notification inbox (#165) end to end over the REST adapter and DynamoDB Local: a trade offer
 * becomes an item in the other person's inbox (never an AI manager's), the summary shows it and the
 * offer waiting, a redelivered event stores nothing, the relay pushes the new item to that team's
 * channel alone, and marking delivered, read one by one, and read all move the counts.
 */

const L = '/leagues/lg-n';
let h: Harness;
let alice: Caller;
let bob: Caller;
let carol: Caller;

interface Item {
  id: string;
  kind: string;
  title: string;
  body: string;
  read: boolean;
  readAt: string | null;
  deliveredAt: string | null;
  target: { section: string; tradeId: string | null };
}
interface Inbox {
  teamId: string | null;
  unreadCount: number;
  notifications: Item[];
  nextCursor: string | null;
}
const inbox = async (c: Caller, query = '') => data<Inbox>(await c.get(`${L}/notifications${query}`));

let seq = 0;
/** The last recorded event of a type, as EventBridge delivers it. */
function delivered(detailType: string, id = `evt-n-${++seq}`): BusEvent {
  const event = h.events.events.filter((e) => e.detailType === detailType).at(-1);
  if (event === undefined) throw new Error(`no ${detailType}`);
  return {
    id,
    'detail-type': detailType,
    source: 'fantasy',
    time: h.clock.now().toISOString(),
    detail: JSON.parse(JSON.stringify(event.detail)) as unknown
  };
}

beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo', registry });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  carol = as(h, CAROL);
  await seedSeasonLeague(h.repos, {
    id: 'lg-n',
    owners: [ALICE, BOB, null, null],
    rosters: {
      'team-1': ['fx-jallen', 'fx-cmc'],
      'team-2': ['fx-mahomes', 'fx-bijan'],
      'team-3': ['fx-hurts', 'fx-jtaylor']
    }
  });
});
afterAll(() => h.close());

describe('notification inbox', () => {
  let offerId = '';
  let itemId = '';

  it('puts a trade offer in the other person’s inbox, once, and pushes it to their team channel', async () => {
    const res = await alice.post(`${L}/trades`, {
      withTeamId: 'team-2',
      send: ['fx-cmc'],
      receive: ['fx-bijan']
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    offerId = data<{ trade: { id: string } }>(res).trade.id;
    const event = delivered('Trade Proposed');
    h.events.events.length = 0;

    const outcome = await writeNotifications(h.services, event);
    expect(outcome).toMatchObject({ status: 'written', duplicates: 0 });
    const created = h.events.events.filter((e) => e.detailType === 'Notification Created');
    expect(created).toHaveLength(1);
    expect(created[0]?.detail).toMatchObject({ leagueId: 'lg-n', teamId: 'team-2' });

    // A redelivery stores and announces nothing.
    expect(await writeNotifications(h.services, event)).toMatchObject({
      status: 'written',
      notifications: [],
      duplicates: 1
    });
    expect(h.events.events.filter((e) => e.detailType === 'Notification Created')).toHaveLength(1);

    // The relay sends the new item to Bob's team channel only (for his tenure of the seat).
    const realtime = new InMemoryRealtime();
    const relayed = await relayEvent(
      realtime,
      silentLogger,
      {
        id: 'evt-relay',
        'detail-type': 'Notification Created',
        source: 'fantasy',
        detail: JSON.parse(JSON.stringify(created[0]?.detail)) as unknown
      },
      h.repos.teams
    );
    expect(relayed.channels).toEqual([
      teamChannel('lg-n', 'team-2', seatTenureKey((await h.repos.teams.get('lg-n', 'team-2'))!))
    ]);

    const bobs = await inbox(bob);
    expect(bobs).toMatchObject({ teamId: 'team-2', unreadCount: 1, nextCursor: null });
    expect(bobs.notifications).toEqual([
      expect.objectContaining({
        kind: 'trade_offer',
        title: "Trade offer from Alice's Team",
        body: "You'd get Christian McCaffrey for Bijan Robinson.",
        read: false,
        readAt: null,
        deliveredAt: null,
        target: { section: 'trades', tradeId: offerId }
      })
    ]);
    itemId = bobs.notifications[0]?.id ?? '';
    expect(await inbox(alice)).toMatchObject({ teamId: 'team-1', unreadCount: 0, notifications: [] });
  });

  it('sums unread items and offers waiting across your leagues', async () => {
    const summary = data<{ unreadCount: number; leagues: unknown[] }>(await bob.get('/notifications'));
    expect(summary).toEqual({
      unreadCount: 1,
      leagues: [
        { leagueId: 'lg-n', name: 'Test League', teamId: 'team-2', unreadCount: 1, tradeOffersWaiting: 1 }
      ]
    });
    expect(data(await alice.get('/notifications'))).toMatchObject({
      unreadCount: 0,
      leagues: [{ leagueId: 'lg-n', tradeOffersWaiting: 0 }]
    });
    expect(data(await carol.get('/notifications'))).toEqual({ unreadCount: 0, leagues: [] });
  });

  it('records a live delivery without marking the item read, then marks it read', async () => {
    const delivered = await bob.post('/notifications/delivered', {
      leagueId: 'lg-n',
      notificationIds: [itemId]
    });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    const after = await inbox(bob);
    expect(after.unreadCount).toBe(1);
    expect(after.notifications[0]).toMatchObject({ read: false, deliveredAt: START });

    const read = await bob.post('/notifications/read', { leagueId: 'lg-n', notificationIds: [itemId] });
    expect(data(read)).toEqual({ leagueId: 'lg-n', unreadCount: 0 });
    expect((await inbox(bob)).notifications[0]).toMatchObject({ read: true, readAt: START });
  });

  it('tells the proposer when the offer is rejected, and "mark all" clears it', async () => {
    h.clock.advance(60_000);
    const res = await bob.post(`${L}/trades/${offerId}/respond`, { response: 'reject' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await writeNotifications(h.services, delivered('Trade Rejected'));
    const alices = await inbox(alice);
    expect(alices.unreadCount).toBe(1);
    expect(alices.notifications[0]).toMatchObject({
      kind: 'trade_rejected',
      title: "Bob's Team rejected your offer"
    });
    h.clock.advance(1_000);
    expect(data(await alice.post('/notifications/read', { leagueId: 'lg-n', all: true }))).toEqual({
      leagueId: 'lg-n',
      unreadCount: 0
    });
    expect((await inbox(alice)).notifications[0]).toMatchObject({ read: true, readAt: null });
    expect(data(await bob.get('/notifications'))).toMatchObject({ leagues: [{ tradeOffersWaiting: 0 }] });
  });

  it('writes nothing for an AI manager', async () => {
    const res = await alice.post(`${L}/trades`, {
      withTeamId: 'team-3',
      send: ['fx-cmc'],
      receive: ['fx-hurts']
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await writeNotifications(h.services, delivered('Trade Proposed'))).toEqual({
      status: 'skipped',
      reason: 'nobody'
    });
  });

  it('pages newest first with a cursor', async () => {
    for (let pick = 1; pick <= 3; pick++) {
      h.clock.advance(1_000);
      await writeNotifications(h.services, {
        id: `evt-turn-${pick}`,
        'detail-type': 'Draft Turn Started',
        source: 'fantasy',
        time: h.clock.now().toISOString(),
        detail: { leagueId: 'lg-n', teamId: 'team-2', pick, round: 1 }
      });
    }
    const first = await inbox(bob, '?limit=2');
    expect(first.unreadCount).toBe(3);
    expect(first.notifications.map((n) => n.body)).toEqual([
      'Pick 3 (round 1) is yours. Make it in the draft room.',
      'Pick 2 (round 1) is yours. Make it in the draft room.'
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await inbox(bob, `?limit=2&after=${first.nextCursor}`);
    expect(second.notifications.map((n) => n.kind)).toEqual(['draft_on_clock', 'trade_offer']);
    expect(second.nextCursor).toBeNull();
    expect(errorCode(await bob.get(`${L}/notifications?after=nope`))).toBe('INVALID_INPUT');
  });

  it('refuses bad requests with a fix', async () => {
    for (const body of [{ leagueId: 'lg-n' }, { leagueId: 'lg-n', all: true, notificationIds: [itemId] }]) {
      const res = await bob.post('/notifications/read', body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: 'INVALID_INPUT', fix: expect.any(String) } });
    }
    expect(
      errorCode(await bob.post('/notifications/read', { leagueId: 'lg-n', notificationIds: ['x!'] }))
    ).toBe('INVALID_INPUT');
    expect(
      errorCode(await bob.post('/notifications/delivered', { leagueId: 'lg-n', notificationIds: ['Zm9v'] }))
    ).toBe('INVALID_INPUT');
    expect((await carol.get(`${L}/notifications`)).status).toBe(403);
    expect((await carol.post('/notifications/read', { leagueId: 'lg-n', all: true })).status).toBe(403);
  });

  it('alerts a manager about their player, and keeps player news to those who want it (#200)', async () => {
    expect(data(await bob.get('/notifications/preferences'))).toEqual({ playerNews: true });
    const status: BusEvent = {
      id: `evt-n-${++seq}`,
      'detail-type': 'Player Status Changed',
      source: 'fantasy',
      time: h.clock.now().toISOString(),
      detail: {
        playerId: 'fx-cmc',
        name: 'Christian McCaffrey',
        team: 'SF',
        position: 'RB',
        changes: [{ field: 'injuryStatus', from: null, to: 'Out' }],
        changedAt: h.clock.now().toISOString(),
        source: 'espn_gameday'
      }
    };
    expect(await writeNotifications(h.services, status)).toMatchObject({ status: 'written' });
    const [alert] = (await inbox(alice)).notifications;
    expect(alert).toMatchObject({
      kind: 'player_status',
      title: 'Christian McCaffrey is out',
      target: { section: 'lineup', tradeId: null, playerId: 'fx-cmc' }
    });

    expect(data(await bob.put('/notifications/preferences', { playerNews: false }))).toEqual({
      playerNews: false
    });
    expect(data(await bob.get('/notifications/preferences'))).toEqual({ playerNews: false });
    expect(errorCode(await bob.put('/notifications/preferences', { playerNews: 'no' }))).toBe(
      'INVALID_INPUT'
    );
    const news: BusEvent = {
      ...status,
      id: `evt-n-${++seq}`,
      'detail-type': 'Player News Alert',
      detail: {
        newsId: 'n1',
        title: 'Mahomes limited in practice',
        url: 'https://example.test/n1',
        source: 'ESPN',
        publishedAt: h.clock.now().toISOString(),
        playerIds: ['fx-mahomes'],
        teams: ['KC']
      }
    };
    expect(await writeNotifications(h.services, news)).toEqual({ status: 'skipped', reason: 'nobody' });
  });

  it('gives a commissioner without a seat an empty inbox, and skips a seat someone else now holds', async () => {
    const nobody = as(h, { sub: 'nobody', name: 'Nobody', email: 'nobody@example.com' });
    await seedSeasonLeague(h.repos, { id: 'lg-n2', owners: [null, CAROL], rosters: {} });
    expect(data(await nobody.get('/leagues/lg-n2/notifications'))).toEqual({
      teamId: null,
      unreadCount: 0,
      notifications: [],
      nextCursor: null
    });
    expect(data(await nobody.post('/notifications/read', { leagueId: 'lg-n2', all: true }))).toEqual({
      leagueId: 'lg-n2',
      unreadCount: 0
    });
    const delivered = await nobody.post('/notifications/delivered', {
      leagueId: 'lg-n2',
      notificationIds: [itemId]
    });
    expect(data(delivered)).toEqual({ leagueId: 'lg-n2' });

    // Carol's membership still points at team-2, but the seat has changed hands.
    const team = await h.repos.teams.get('lg-n2', 'team-2');
    await h.repos.teams.update({ ...(team as NonNullable<typeof team>), ownerUserId: 'dave' });
    expect(data(await carol.get('/notifications'))).toEqual({ unreadCount: 0, leagues: [] });
  });
});
