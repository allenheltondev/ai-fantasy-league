import { FixedClock } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { game, seedRosteredLeague } from '../../test/support/jobs.js';
import type { BusEvent } from '../events/bus.js';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { silentLogger } from '../log.js';
import { createInMemoryRepos } from '../repos/memory.js';
import { createServices } from '../services.js';
import { writeNotifications } from './consumer.js';

const KICKOFF = '2025-09-07T17:00:00.000Z';
const NOW = '2025-09-07T15:30:00.000Z';

async function setup() {
  const repos = createInMemoryRepos();
  const clock = new FixedClock(new Date(NOW));
  const events = new InMemoryEventPublisher();
  const services = createServices({ repos, clock, events, log: silentLogger });
  await services.data.reference.schedule.putSeason(
    2025,
    [game({ gameId: '2025_01_SF_LAR', kickoff: KICKOFF, homeTeam: 'LAR', awayTeam: 'SF' })],
    {},
    new Date(NOW)
  );
  await seedRosteredLeague(repos, {
    leagueId: 'lg',
    week: 1,
    teams: [
      { id: 't1', owner: 'ann', roster: ['p1', 'p2'] },
      { id: 't2', owner: 'ben', roster: ['p1'] },
      { id: 't3', roster: ['p1'] },
      { id: 't4', owner: 'cat', roster: [] }
    ]
  });
  // Ann starts him; Ben has no lineup saved, so his players sit on the bench.
  await repos.lineups.put([
    {
      leagueId: 'lg',
      teamId: 't1',
      week: 1,
      entries: [
        { playerId: 'p1', slot: 'RB' },
        { playerId: 'p2', slot: 'BN' }
      ],
      updatedAt: NOW,
      updatedBy: 'user#ann'
    }
  ]);
  await repos.players.putMany([
    {
      id: 'p1',
      name: 'Christian McCaffrey',
      firstName: 'Christian',
      lastName: 'McCaffrey',
      team: 'SF',
      position: 'RB',
      status: 'active',
      injuryStatus: 'Out',
      aliases: [],
      rank: 1,
      updatedAt: NOW
    }
  ]);
  return { repos, clock, events, services };
}

let seq = 0;
const bus = (
  detailType: string,
  detail: Record<string, unknown>,
  extra: Partial<BusEvent> = {}
): BusEvent => ({
  id: `evt-${++seq}`,
  'detail-type': detailType,
  source: 'fantasy',
  time: NOW,
  detail,
  ...extra
});

const status = (changes: unknown[], extra: Record<string, unknown> = {}) =>
  bus('Player Status Changed', {
    playerId: 'p1',
    name: 'Christian McCaffrey',
    team: 'SF',
    position: 'RB',
    changes,
    changedAt: NOW,
    source: 'espn_gameday',
    ...extra
  });

const news = (playerIds: string[], at = NOW) =>
  bus(
    'Player News Alert',
    {
      newsId: `n-${seq}`,
      title: 'McCaffrey inactive vs. Rams',
      url: 'https://example.test/n',
      source: 'ESPN',
      publishedAt: at,
      playerIds,
      teams: ['SF']
    },
    { time: at }
  );

const OUT = [{ field: 'injuryStatus', from: 'Questionable', to: 'Out' }];

async function inbox(services: Awaited<ReturnType<typeof setup>>['services'], teamId: string) {
  const page = await services.repos.notifications.list('lg', teamId, {
    limit: 20,
    visibleFrom: '2025-01-01'
  });
  return page.notifications;
}

describe('player status notifications (#200)', () => {
  it('alerts a starter’s manager urgently and a bench manager quietly; agents get nothing', async () => {
    const { services, events } = await setup();
    const outcome = await writeNotifications(services, status(OUT));
    expect(outcome).toMatchObject({ status: 'written', duplicates: 0 });
    const [ann] = await inbox(services, 't1');
    expect(ann).toMatchObject({
      kind: 'player_status',
      urgent: true,
      title: 'Starter out: Christian McCaffrey',
      body: "Your starter Christian McCaffrey (RB, SF) is OUT for today's game. Set your lineup.",
      target: { section: 'lineup', tradeId: null, playerId: 'p1' }
    });
    const [ben] = await inbox(services, 't2');
    expect(ben).toMatchObject({ title: 'Christian McCaffrey is out' });
    expect(ben?.urgent).toBeUndefined();
    expect(ben?.body).toContain('He is on your bench.');
    expect(await inbox(services, 't3')).toEqual([]);
    expect(events.events.map((e) => [e.detailType, e.detail.teamId])).toEqual([
      ['Notification Created', 't1'],
      ['Notification Created', 't2']
    ]);
  });

  it('is idempotent per event and quiet on depth-chart moves and repeats', async () => {
    const { services, events } = await setup();
    const event = status(OUT);
    await writeNotifications(services, event);
    events.events.length = 0;
    expect(await writeNotifications(services, event)).toMatchObject({ status: 'written', duplicates: 2 });
    expect(events.events).toEqual([]);
    expect(
      await writeNotifications(services, status([{ field: 'depthChartOrder', from: 1, to: 2 }]))
    ).toEqual({
      status: 'skipped',
      reason: 'not_notifiable'
    });
    expect(
      await writeNotifications(services, status([{ field: 'injuryStatus', from: 'Out', to: 'Out' }]))
    ).toEqual({
      status: 'skipped',
      reason: 'not_notifiable'
    });
  });

  it('is normal once the game kicked off, and names players the event leaves unnamed', async () => {
    const { services, clock } = await setup();
    clock.set(new Date('2025-09-07T17:05:00.000Z'));
    await writeNotifications(
      services,
      status(OUT, { name: undefined, position: undefined, team: undefined })
    );
    const [ann] = await inbox(services, 't1');
    expect(ann).toMatchObject({
      title: 'Christian McCaffrey is out',
      body: 'Christian McCaffrey (RB, SF) is OUT. He is in your lineup.'
    });
    expect(ann?.urgent).toBeUndefined();
  });

  it('reaches nobody for a player no person rosters', async () => {
    const { services } = await setup();
    expect(await writeNotifications(services, status(OUT, { playerId: 'p9' }))).toEqual({
      status: 'skipped',
      reason: 'nobody'
    });
    expect(
      await writeNotifications(
        services,
        status(OUT, { playerId: 'p9', name: undefined, position: undefined })
      )
    ).toMatchObject({ reason: 'nobody' });
  });
});

describe('player news notifications (#200)', () => {
  it('sends single-player news at most once an hour per player and team', async () => {
    const { services } = await setup();
    expect(await writeNotifications(services, news(['p1']))).toMatchObject({ status: 'written' });
    expect((await inbox(services, 't1'))[0]).toMatchObject({
      kind: 'player_news',
      title: 'News: Christian McCaffrey',
      body: 'McCaffrey inactive vs. Rams (ESPN)',
      target: { section: 'lineup', playerId: 'p1' }
    });
    expect(await writeNotifications(services, news(['p1'], '2025-09-07T16:00:00.000Z'))).toEqual({
      status: 'skipped',
      reason: 'nobody'
    });
    expect(await writeNotifications(services, news(['p1'], '2025-09-07T16:31:00.000Z'))).toMatchObject({
      status: 'written'
    });
    expect((await inbox(services, 't2')).map((n) => n.createdAt)).toEqual(['2025-09-07T16:31:00.000Z', NOW]);
  });

  it('skips roundups about several players, and managers who turned player news off', async () => {
    const { services } = await setup();
    expect(await writeNotifications(services, news(['p1', 'p2']))).toMatchObject({
      reason: 'not_notifiable'
    });
    await services.repos.notifications.putPreferences('ben', { playerNews: false });
    await writeNotifications(services, news(['p1']));
    expect(await inbox(services, 't1')).toHaveLength(1);
    expect(await inbox(services, 't2')).toEqual([]);
  });
});
