import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalTable, type LocalTable } from '../../src/dev/dynalite.js';
import {
  notificationId,
  notificationLocalKey,
  NOTIFICATION_UNREAD_CAP,
  type StoredNotification
} from '../../src/notifications/model.js';
import { createDynamoRepos } from '../../src/repos/dynamo/index.js';
import { createInMemoryRepos } from '../../src/repos/memory.js';
import type { Repos } from '../../src/repos/types.js';

let table: LocalTable;
beforeAll(async () => {
  table = await startLocalTable();
});
afterAll(() => table.close());

/** The notification repository's contract (#165), run against both implementations. */
const backends: [string, () => Repos][] = [
  ['in-memory', () => createInMemoryRepos()],
  ['DynamoDB (dynalite)', () => createDynamoRepos(table)]
];

let counter = 0;
const unique = () => `lg-notifrepo-${++counter}`;
const at = (second: number) =>
  `2026-10-04T15:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.000Z`;

function item(
  leagueId: string,
  second: number,
  overrides: Partial<StoredNotification> = {}
): StoredNotification {
  const createdAt = at(second);
  const teamId = overrides.teamId ?? 'team-1';
  return {
    id: notificationId(notificationLocalKey(createdAt, `evt-${second}`, '')),
    leagueId,
    teamId,
    kind: 'trade_offer',
    title: `Offer ${second}`,
    body: 'body',
    target: { section: 'trades', tradeId: `t-${second}` },
    event: { detailType: 'Trade Proposed', eventId: `evt-${second}` },
    createdAt,
    readAt: null,
    deliveredAt: null,
    ...overrides
  };
}

for (const [name, make] of backends) {
  describe(`notification repository (${name})`, () => {
    it('keeps each team apart, newest first, and stores an item once', async () => {
      const repos = make();
      const lg = unique();
      for (let s = 1; s <= 3; s++) await repos.notifications.put(item(lg, s));
      await repos.notifications.put(item(lg, 4, { teamId: 'team-2' }));
      expect(await repos.notifications.put(item(lg, 2, { title: 'again' }))).toBe(false);

      const page = await repos.notifications.list(lg, 'team-1', { limit: 2, visibleFrom: at(0) });
      expect(page.notifications.map((n) => n.title)).toEqual(['Offer 3', 'Offer 2']);
      expect(page.notifications[0]).toEqual({ ...item(lg, 3), read: false });
      const rest = await repos.notifications.list(lg, 'team-1', {
        limit: 2,
        visibleFrom: at(0),
        cursor: page.nextCursor as string
      });
      expect(rest).toEqual({ notifications: [{ ...item(lg, 1), read: false }], nextCursor: null });
      expect(await repos.notifications.unreadCount(lg, 'team-1', at(0))).toBe(3);
      expect(await repos.notifications.unreadCount(lg, 'team-2', at(0))).toBe(1);
    });

    it('hides items from before the seat’s current occupant', async () => {
      const repos = make();
      const lg = unique();
      for (let s = 1; s <= 3; s++) await repos.notifications.put(item(lg, s));
      const page = await repos.notifications.list(lg, 'team-1', { limit: 10, visibleFrom: at(2) });
      expect(page.notifications.map((n) => n.title)).toEqual(['Offer 3', 'Offer 2']);
      expect(await repos.notifications.unreadCount(lg, 'team-1', at(3))).toBe(1);
    });

    it('marks one read, all read (forward only), and delivered, ignoring unknown ids', async () => {
      const repos = make();
      const lg = unique();
      for (let s = 1; s <= 4; s++) await repos.notifications.put(item(lg, s));
      const id = (s: number) => item(lg, s).id;
      const missing = notificationId(notificationLocalKey(at(9), 'evt-none', ''));
      await repos.notifications.markRead(lg, 'team-1', [id(4), missing], at(10));
      await repos.notifications.markRead(lg, 'team-1', [id(4)], at(11));
      await repos.notifications.markDelivered(lg, 'team-1', [id(3), missing], at(12));
      await repos.notifications.markDelivered(lg, 'team-1', [id(3)], at(13));
      expect(await repos.notifications.unreadCount(lg, 'team-1', at(0))).toBe(3);

      await repos.notifications.markAllRead(lg, 'team-1', at(2));
      await repos.notifications.markAllRead(lg, 'team-1', at(1));
      expect(await repos.notifications.unreadCount(lg, 'team-1', at(0))).toBe(1);
      const page = await repos.notifications.list(lg, 'team-1', { limit: 10, visibleFrom: at(0) });
      expect(page.notifications.map((n) => [n.title, n.read, n.readAt, n.deliveredAt])).toEqual([
        ['Offer 4', true, at(10), null],
        ['Offer 3', false, null, at(12)],
        ['Offer 2', true, null, null],
        ['Offer 1', true, null, null]
      ]);
      // The unknown id created nothing.
      expect(page.notifications).toHaveLength(4);
    });

    it('stops counting unread items at the cap', async () => {
      const repos = make();
      const lg = unique();
      for (let s = 0; s < NOTIFICATION_UNREAD_CAP + 2; s++) await repos.notifications.put(item(lg, s));
      expect(await repos.notifications.unreadCount(lg, 'team-1', at(0))).toBe(NOTIFICATION_UNREAD_CAP);
    });
  });
}
