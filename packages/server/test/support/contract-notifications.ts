import { notificationId, notificationLocalKey } from '../../src/notifications/model.js';
import type { Repos } from '../../src/repos/types.js';
import { START, type RequestOptions } from './harness.js';
import { signIdToken } from './tokens.js';

/**
 * Contract cases for the notification inbox (#165), against `lg-c` (seeded by contract-leagues.ts),
 * where the harness's default user (Allen) holds team-1.
 */

interface Case {
  label: string;
  path: string;
  init?: RequestOptions;
  status: number;
}

const outsider = signIdToken({ sub: 'notif-outsider', name: 'Olive' });
const ID = notificationId(notificationLocalKey(START, 'evt-contract-notif', ''));
const LIST = '/api/v1/leagues/lg-c/notifications';
const READ = '/api/v1/notifications/read';
const DELIVERED = '/api/v1/notifications/delivered';

export async function seedContractNotifications(repos: Repos): Promise<void> {
  await repos.notifications.put({
    id: ID,
    leagueId: 'lg-c',
    teamId: 'team-1',
    kind: 'trade_offer',
    title: "Trade offer from Bob's Team",
    body: "You'd get Bijan Robinson for Christian McCaffrey.",
    target: { section: 'trades', tradeId: 'trade-contract' },
    event: { detailType: 'Trade Proposed', eventId: 'evt-contract-notif' },
    createdAt: START,
    readAt: null,
    deliveredAt: null
  });
}

export const NOTIFICATION_CASES: Record<string, Case[]> = {
  list_notifications: [
    { label: 'inbox', path: LIST, status: 200 },
    { label: 'one per page', path: `${LIST}?limit=1`, status: 200 },
    { label: 'bad cursor', path: `${LIST}?after=nope`, status: 400 },
    { label: 'outsider', path: LIST, init: { token: outsider }, status: 403 }
  ],
  get_notification_summary: [
    { label: 'summary', path: '/api/v1/notifications', status: 200 },
    { label: 'anonymous', path: '/api/v1/notifications', init: { token: null }, status: 401 }
  ],
  mark_notifications_delivered: [
    {
      label: 'delivered',
      path: DELIVERED,
      init: { body: { leagueId: 'lg-c', notificationIds: [ID] }, idempotencyKey: 'contract-notif-1' },
      status: 200
    },
    {
      label: 'not an id',
      path: DELIVERED,
      init: { body: { leagueId: 'lg-c', notificationIds: ['x!'] }, idempotencyKey: 'contract-notif-2' },
      status: 400
    }
  ],
  mark_notifications_read: [
    {
      label: 'one',
      path: READ,
      init: { body: { leagueId: 'lg-c', notificationIds: [ID] }, idempotencyKey: 'contract-notif-3' },
      status: 200
    },
    {
      label: 'all',
      path: READ,
      init: { body: { leagueId: 'lg-c', all: true }, idempotencyKey: 'contract-notif-4' },
      status: 200
    },
    {
      label: 'neither',
      path: READ,
      init: { body: { leagueId: 'lg-c' }, idempotencyKey: 'contract-notif-5' },
      status: 400
    },
    {
      label: 'outsider',
      path: READ,
      init: { body: { leagueId: 'lg-c', all: true }, idempotencyKey: 'contract-notif-6', token: outsider },
      status: 403
    }
  ]
};
