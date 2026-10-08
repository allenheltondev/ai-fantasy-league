import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { yahooDefaultSettings } from '@fantasy/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalTable, type LocalTable } from '../../src/dev/local-table.js';
import { newTeam } from '../../src/league/seats.js';
import { createDynamoRepos } from '../../src/repos/dynamo/index.js';
import { TABLE_KEYS } from '../../src/repos/dynamo/table.js';
import { createInMemoryRepos } from '../../src/repos/memory.js';
import { listInSeason } from '../../src/season/lineups.js';
import type { DraftReportCard, Invite, Matchup, Repos, StandingsSnapshot } from '../../src/repos/types.js';
import { league, START } from '../support/harness.js';

let table: LocalTable;
beforeAll(async () => {
  table = await startLocalTable();
});
afterAll(() => table.close());

/** The league repositories' behavioral contract, run against both implementations. */
const backends: [string, () => Repos][] = [
  ['in-memory', () => createInMemoryRepos()],
  ['DynamoDB (DynamoDB Local)', () => createDynamoRepos(table)]
];

let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}`;
const settings = yahooDefaultSettings(8);
const NOW = new Date(START);
const team = (leagueId: string, id: string, slot: number, owner?: string) =>
  newTeam({
    leagueId,
    id,
    draftSlot: slot,
    settings,
    now: NOW,
    ...(owner === undefined ? {} : { owner: { userId: owner, name: owner, teamName: `${owner} FC` } })
  });

function invite(leagueId: string, overrides: Partial<Invite> = {}): Invite {
  return {
    id: unique('inv'),
    leagueId,
    tokenHash: unique('hash'),
    code: null,
    email: null,
    teamId: null,
    maxUses: 1,
    uses: 0,
    expiresAt: '2026-09-17T12:00:00.000Z',
    revokedAt: null,
    createdBy: 'u',
    createdAt: START,
    version: 1,
    ...overrides
  };
}

function matchup(leagueId: string, week: number, n: number): Matchup {
  return {
    id: `W${String(week).padStart(2, '0')}-${n}`,
    leagueId,
    week,
    kind: 'regular',
    homeTeamId: 'team-1',
    awayTeamId: 'team-2',
    homeScore: null,
    awayScore: null,
    status: 'scheduled'
  };
}

describe.each(backends)('%s league repositories', (_name, make) => {
  it("stores the commissioner's email without a new version, only for the current commissioner", async () => {
    const { leagues } = make();
    const stored = league({ id: unique('lg') });
    await leagues.create(stored);
    expect((await leagues.get(stored.id))?.commissionerEmail).toBeUndefined();
    await leagues.setCommissionerEmail(stored.id, 'someone-else', 'x@example.com');
    expect((await leagues.get(stored.id))?.commissionerEmail).toBeUndefined();
    await leagues.setCommissionerEmail(stored.id, stored.commissionerId, 'c@example.com');
    expect(await leagues.get(stored.id)).toMatchObject({ commissionerEmail: 'c@example.com', version: 1 });
    // A league that is gone stores nothing (and is not created).
    const missing = unique('missing');
    await leagues.setCommissionerEmail(missing, stored.commissionerId, 'c@example.com');
    expect(await leagues.get(missing)).toBeNull();
    const updated = await leagues.update({ ...stored, commissionerEmail: null });
    expect(await leagues.get(stored.id)).toMatchObject({ commissionerEmail: null, version: updated.version });
  });

  it('stores leagues with settings, finds them by creator, and fetches several at once', async () => {
    const { leagues } = make();
    const creator = unique('creator');
    const a = league({ id: unique('lg'), createdBy: creator, createdAt: '2026-09-01T00:00:00.000Z' });
    const b = league({ id: unique('lg'), createdBy: creator, createdAt: '2026-09-02T00:00:00.000Z' });
    await leagues.create(b);
    await leagues.create(a);
    await leagues.create(league({ id: unique('lg'), createdBy: unique('other') }));
    expect(await leagues.get(a.id)).toEqual(a);
    expect((await leagues.listByCreator(creator)).map((l) => l.id)).toEqual([a.id, b.id]);
    expect(await leagues.listByCreator(unique('nobody'))).toEqual([]);
    expect((await leagues.getMany([b.id, 'missing', a.id])).map((l) => l.id)).toEqual([b.id, a.id]);
    expect(await leagues.getMany([])).toEqual([]);
    const updated = await leagues.update({ ...a, name: 'Renamed' });
    expect(await leagues.get(a.id)).toEqual(updated);
  });

  it('keeps teams in draft-slot order with optimistic concurrency', async () => {
    const { teams } = make();
    const leagueId = unique('lg');
    await teams.create([
      team(leagueId, 'team-2', 2),
      team(leagueId, 'team-1', 1, 'u1'),
      team(leagueId, 'team-3', 3)
    ]);
    await expect(teams.create([team(leagueId, 'team-1', 1)])).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await teams.list(leagueId)).map((t) => t.id)).toEqual(['team-1', 'team-2', 'team-3']);
    const stored = await teams.get(leagueId, 'team-2');
    expect(stored).toMatchObject({ seatType: 'agent', roster: [], ownerUserId: null });
    const updated = await teams.update({ ...stored!, name: 'Renamed' });
    expect(updated.version).toBe(2);
    await expect(teams.update(stored!)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(teams.update(team(leagueId, 'team-9', 9))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await teams.get(leagueId, 'team-9')).toBeNull();
    expect(await teams.list(unique('empty'))).toEqual([]);
  });

  it('deletes only teams nobody holds', async () => {
    const { teams } = make();
    const leagueId = unique('lg');
    await teams.create([team(leagueId, 'team-1', 1, 'u1'), team(leagueId, 'team-2', 2)]);
    expect(await teams.deleteUnowned(leagueId, 'team-1')).toBe(false);
    expect(await teams.deleteUnowned(leagueId, 'team-2')).toBe(true);
    expect(await teams.deleteUnowned(leagueId, 'team-2')).toBe(true);
    expect((await teams.list(leagueId)).map((t) => t.id)).toEqual(['team-1']);
  });

  it("backfills a legacy team's seat tenure from its holder's membership (#148)", async () => {
    const { teams, members } = make();
    const leagueId = unique('lg');
    const joinedAt = '2026-09-12T08:30:00.000Z';
    // Stored before `occupiedSince` existed: an AI seat a person took over after the league began.
    const { occupiedSince: _taken, ...taken } = team(leagueId, 'team-2', 2, 'u2');
    const { occupiedSince: _open, ...open } = team(leagueId, 'team-3', 3);
    await teams.create([taken, open]);
    await members.add({ leagueId, userId: 'u2', teamId: 'team-2', joinedAt });
    expect((await teams.get(leagueId, 'team-2'))?.occupiedSince).toBe(joinedAt);
    expect((await teams.get(leagueId, 'team-3'))?.occupiedSince).toBeUndefined();
    expect((await teams.list(leagueId)).map((t) => t.occupiedSince)).toEqual([joinedAt, undefined]);
    // The next write stores it, so it outlives the membership.
    await teams.update({ ...(await teams.get(leagueId, 'team-2'))!, name: 'Renamed' });
    await members.remove(leagueId, 'u2');
    expect((await teams.get(leagueId, 'team-2'))?.occupiedSince).toBe(joinedAt);
  });

  it('records one membership per person per league and lists a person leagues', async () => {
    const { members } = make();
    const user = unique('user');
    const [l1, l2] = [unique('lg'), unique('lg')];
    const member = { leagueId: l1, userId: user, teamId: 'team-1', joinedAt: START };
    expect(await members.add(member)).toBe(true);
    expect(await members.add({ ...member, teamId: 'team-2' })).toBe(false);
    expect(await members.add({ ...member, leagueId: l2 })).toBe(true);
    expect(await members.get(l1, user)).toEqual(member);
    expect((await members.listByUser(user)).map((m) => m.leagueId).sort()).toEqual([l1, l2].sort());
    await members.remove(l1, user);
    expect(await members.get(l1, user)).toBeNull();
    expect((await members.listByUser(user)).map((m) => m.leagueId)).toEqual([l2]);
  });

  it('finds invites by token hash and updates them with a version check', async () => {
    const { invites } = make();
    const leagueId = unique('lg');
    const older = invite(leagueId, { createdAt: '2026-09-01T00:00:00.000Z' });
    const newer = invite(leagueId, { email: 'x@example.com' });
    await invites.create(older);
    await invites.create(newer);
    expect(await invites.getByTokenHash(newer.tokenHash)).toEqual(newer);
    expect(await invites.getByTokenHash(unique('none'))).toBeNull();
    expect(await invites.get(leagueId, older.id)).toEqual(older);
    expect(await invites.get(leagueId, 'missing')).toBeNull();
    expect((await invites.list(leagueId)).map((i) => i.id)).toEqual([newer.id, older.id]);
    const used = await invites.update({ ...older, uses: 1 });
    expect(used).toMatchObject({ uses: 1, version: 2 });
    await expect(invites.update(older)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(invites.update(invite(leagueId))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('finds invites by join code, keeps codes unique, and limits lookups per hour', async () => {
    const { invites } = make();
    const leagueId = unique('lg');
    const code = 'K7MQ2X';
    const coded = invite(leagueId, { code });
    expect(await invites.create(coded)).toBe(true);
    expect(await invites.getByCode(code)).toEqual(coded);
    expect(await invites.getByCode('ZZZZZZ')).toBeNull();
    // A second invite cannot take a code that is already in use, and nothing of it is stored.
    const rival = invite(leagueId, { code });
    expect(await invites.create(rival)).toBe(false);
    expect(await invites.get(leagueId, rival.id)).toBeNull();
    // Invites without a code never collide.
    expect(await invites.create(invite(leagueId))).toBe(true);
    expect(await invites.create(invite(leagueId))).toBe(true);

    const user = unique('user');
    const noon = new Date('2026-09-10T12:10:00.000Z');
    for (let i = 0; i < 3; i++) expect(await invites.takeCodeAttempt(user, noon, 3)).toBe(true);
    expect(await invites.takeCodeAttempt(user, noon, 3)).toBe(false);
    expect(await invites.takeCodeAttempt(user, new Date('2026-09-10T12:50:00.000Z'), 3)).toBe(false);
    // A refunded attempt can be taken again, and refunding never goes below zero.
    await invites.refundCodeAttempt(user, noon);
    expect(await invites.takeCodeAttempt(user, noon, 3)).toBe(true);
    expect(await invites.takeCodeAttempt(user, noon, 3)).toBe(false);
    const idle = unique('user');
    await invites.refundCodeAttempt(idle, noon);
    for (let i = 0; i < 2; i++) expect(await invites.takeCodeAttempt(idle, noon, 2)).toBe(true);
    expect(await invites.takeCodeAttempt(idle, noon, 2)).toBe(false);
    // A new clock hour starts from zero, and another person's attempts are their own.
    expect(await invites.takeCodeAttempt(user, new Date('2026-09-10T13:00:00.000Z'), 3)).toBe(true);
    expect(await invites.takeCodeAttempt(unique('user'), noon, 3)).toBe(true);
  });

  it('lets only `limit` of many parallel attempts through', async () => {
    const { invites } = make();
    const user = unique('user');
    const now = new Date('2026-09-10T12:10:00.000Z');
    const results = await Promise.all(
      Array.from({ length: 25 }, () => invites.takeCodeAttempt(user, now, 10))
    );
    expect(results.filter(Boolean)).toHaveLength(10);
  });

  it('stores matchups by week and the latest standings', async () => {
    const { schedule } = make();
    const leagueId = unique('lg');
    await schedule.putMatchups([matchup(leagueId, 2, 1), matchup(leagueId, 1, 2), matchup(leagueId, 1, 1)]);
    expect((await schedule.listMatchups(leagueId)).map((m) => m.id)).toEqual(['W01-1', 'W01-2', 'W02-1']);
    expect((await schedule.listMatchups(leagueId, 2)).map((m) => m.id)).toEqual(['W02-1']);
    await schedule.putMatchups([
      { ...matchup(leagueId, 2, 1), homeScore: 101.5, awayScore: 99, status: 'final' }
    ]);
    expect(await schedule.listMatchups(leagueId, 2)).toEqual([
      expect.objectContaining({ homeScore: 101.5, awayScore: 99, status: 'final' })
    ]);
    expect(await schedule.latestStandings(leagueId)).toBeNull();
    const snapshot = (week: number): StandingsSnapshot => ({
      leagueId,
      week,
      computedAt: START,
      rows: [
        {
          teamId: 'team-1',
          rank: 1,
          wins: week,
          losses: 0,
          ties: 0,
          gamesPlayed: week,
          winPct: 1,
          pointsFor: 100,
          pointsAgainst: 90,
          streak: { result: 'W', length: week },
          tiebreakerOverNext: null
        }
      ]
    });
    await schedule.putStandings(snapshot(1));
    await schedule.putStandings(snapshot(10));
    await schedule.putStandings(snapshot(2));
    expect(await schedule.latestStandings(leagueId)).toEqual(snapshot(10));
  });

  it('deletes a whole league partition', async () => {
    const repos = make();
    const l = league({ id: unique('lg'), createdBy: unique('creator') });
    await repos.leagues.create(l);
    await repos.teams.create([team(l.id, 'team-1', 1, 'u1')]);
    await repos.members.add({ leagueId: l.id, userId: 'u1', teamId: 'team-1', joinedAt: START });
    const inv = invite(l.id);
    await repos.invites.create(inv);
    await repos.schedule.putMatchups([matchup(l.id, 1, 1)]);
    // The other league-scoped items in docs/adr/001-table-design.md: lineups, waivers, transactions,
    // and the chat partition (which delete_league clears with chat.deleteLeague).
    await repos.lineups.put([
      { leagueId: l.id, teamId: 'team-1', week: 1, entries: [], updatedAt: START, updatedBy: 'user#u1' }
    ]);
    await repos.waivers.putWireEntry({
      leagueId: l.id,
      playerId: 'p1',
      droppedByTeamId: 'team-1',
      droppedAt: START,
      clearsAt: START
    });
    await repos.waivers.addTransactions([
      {
        id: 'txn-1',
        leagueId: l.id,
        at: START,
        week: 1,
        type: 'add',
        teamId: 'team-1',
        addPlayerId: 'p1',
        dropPlayerId: null,
        cost: null,
        claimId: null
      }
    ]);
    for (const [id, roomId] of [
      ['m1', 'trash-talk'],
      ['m2', 'dm-team-1-team-2']
    ] as const) {
      await repos.chat.put(
        {
          id,
          leagueId: l.id,
          roomId,
          kind: 'user',
          author: { teamId: 'team-1', teamName: 'A', name: 'u1' },
          text: 'hi',
          mentionedTeamIds: [],
          event: null,
          createdAt: START
        },
        { dmTeamIds: ['team-1', 'team-2'] }
      );
    }
    await repos.chat.markRead(l.id, 'user#u1', 'trash-talk', START);
    await repos.chat.deleteLeague(l.id);
    await repos.leagues.delete(l.id);
    expect(await repos.chat.list(l.id, 'trash-talk', { limit: 10 })).toEqual({
      messages: [],
      nextCursor: null
    });
    expect(await repos.chat.dmRooms(l.id, 'team-1')).toEqual([]);
    expect(await repos.chat.readState(l.id, 'user#u1')).toEqual({});
    expect(await repos.lineups.listWeek(l.id, 1)).toEqual([]);
    expect(await repos.waivers.listWire(l.id)).toEqual([]);
    expect((await repos.waivers.listTransactions(l.id, { limit: 10 })).items).toEqual([]);
    expect(await repos.leagues.get(l.id)).toBeNull();
    expect(await repos.teams.list(l.id)).toEqual([]);
    expect(await repos.members.listByUser('u1')).not.toContainEqual(
      expect.objectContaining({ leagueId: l.id })
    );
    expect(await repos.invites.getByTokenHash(inv.tokenHash)).toBeNull();
    expect(await repos.schedule.listMatchups(l.id)).toEqual([]);
    expect(await repos.leagues.listByCreator(l.createdBy)).toEqual([]);
  });

  it('lists in-season leagues only while they are in season', async () => {
    const repos = make();
    const setup = league({ id: unique('lg'), createdBy: unique('creator') });
    const live = league({ id: unique('lg'), createdBy: setup.createdBy, phase: 'regular_season', week: 3 });
    const playoffs = league({ id: unique('lg'), createdBy: setup.createdBy, phase: 'playoffs', week: 15 });
    for (const l of [setup, live, playoffs]) await repos.leagues.create(l);
    const ours = async () =>
      (await listInSeason(repos))
        .map((l) => l.id)
        .filter((id) => [setup.id, live.id, playoffs.id].includes(id));
    expect(await ours()).toEqual([live.id, playoffs.id].sort());
    await repos.leagues.update({ ...playoffs, phase: 'complete' });
    expect(await ours()).toEqual([live.id]);
  });

  it('stores lineups per team and week and finds the latest earlier one', async () => {
    const { lineups } = make();
    const leagueId = unique('lg');
    const lineup = (teamId: string, week: number, slot: 'QB' | 'BN') => ({
      leagueId,
      teamId,
      week,
      entries: [{ playerId: `${teamId}-qb`, slot }],
      updatedAt: START,
      updatedBy: 'user#u1'
    });
    expect(await lineups.get(leagueId, 'team-1', 1)).toBeNull();
    expect(await lineups.latest(leagueId, 'team-1', 5)).toBeNull();
    await lineups.put([lineup('team-1', 1, 'QB'), lineup('team-2', 1, 'BN'), lineup('team-2', 4, 'QB')]);
    await lineups.put([lineup('team-1', 3, 'BN'), lineup('team-10', 3, 'QB')]);
    expect(await lineups.get(leagueId, 'team-1', 3)).toEqual(lineup('team-1', 3, 'BN'));
    expect((await lineups.latest(leagueId, 'team-1', 5))?.week).toBe(3);
    expect((await lineups.latest(leagueId, 'team-1', 2))?.week).toBe(1);
    expect((await lineups.latest(leagueId, 'team-2', 3))?.week).toBe(1);
    expect(await lineups.latest(leagueId, 'team-3', 18)).toBeNull();
    expect((await lineups.listWeek(leagueId, 3)).map((l) => l.teamId).sort()).toEqual(['team-1', 'team-10']);
    await lineups.put([lineup('team-1', 3, 'QB')]);
    expect(await lineups.get(leagueId, 'team-1', 3)).toEqual(lineup('team-1', 3, 'QB'));
  });
});

describe('DynamoDB league keys (docs/adr/001-table-design.md)', () => {
  it('writes the documented keys and GSI1 entries', async () => {
    const repos = createDynamoRepos(table);
    const l = league({ id: unique('lg'), createdBy: 'keys-user' });
    await repos.leagues.create(l);
    await repos.teams.create([team(l.id, 'team-1', 1, 'keys-user')]);
    await repos.members.add({ leagueId: l.id, userId: 'keys-user', teamId: 'team-1', joinedAt: START });
    await repos.invites.create(invite(l.id, { id: 'inv-keys', tokenHash: 'keys-hash', code: 'KEYS22' }));
    await repos.schedule.putMatchups([matchup(l.id, 3, 1)]);
    const items = await table.doc.send(
      new QueryCommand({
        TableName: table.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `LEAGUE#${l.id}` }
      })
    );
    const keys = (items.Items ?? []).map((i) => ({ sk: i.sk, GSI1PK: i.GSI1PK, GSI1SK: i.GSI1SK }));
    expect(keys).toEqual(
      expect.arrayContaining([
        { sk: 'META', GSI1PK: 'CREATOR#keys-user', GSI1SK: `LEAGUE#${l.createdAt}#${l.id}` },
        { sk: 'TEAM#team-1', GSI1PK: undefined, GSI1SK: undefined },
        { sk: 'MEMBER#keys-user', GSI1PK: 'USER#keys-user', GSI1SK: `LEAGUE#${l.id}` },
        { sk: 'INVITE#inv-keys', GSI1PK: 'INVITE#keys-hash', GSI1SK: 'INVITE' },
        { sk: 'MATCHUP#W03#W03-1', GSI1PK: undefined, GSI1SK: undefined }
      ])
    );
    expect(TABLE_KEYS.gsi1).toEqual({ name: 'GSI1', pk: 'GSI1PK', sk: 'GSI1SK' });

    // A join code is its own item pointing at the invite; lookups are counted per person and hour.
    const lookup = await table.doc.send(
      new GetCommand({ TableName: table.tableName, Key: { pk: 'INVITECODE#KEYS22', sk: 'LOOKUP' } })
    );
    expect(lookup.Item).toMatchObject({ leagueId: l.id, inviteId: 'inv-keys', entity: 'invite-code' });
    expect(typeof lookup.Item?.ttl).toBe('number');
    await repos.invites.takeCodeAttempt('keys-user', new Date(START), 10);
    const misses = await table.doc.send(
      new GetCommand({
        TableName: table.tableName,
        Key: {
          pk: 'RATE#INVITECODE#keys-user',
          sk: `HOUR#${Math.floor(new Date(START).getTime() / 3_600_000)}`
        }
      })
    );
    expect(misses.Item).toMatchObject({ attempts: 1, entity: 'invite-code-attempts' });
    expect(misses.Item?.ttl).toBe(Math.floor(new Date(START).getTime() / 1000) + 2 * 3600);
  });

  it('keys lineups by week and team, and indexes leagues by phase on GSI2', async () => {
    const repos = createDynamoRepos(table);
    const l = league({ id: unique('lg'), createdBy: 'keys-user', phase: 'regular_season', week: 5 });
    await repos.leagues.create(l);
    await repos.lineups.put([
      { leagueId: l.id, teamId: 'team-2', week: 5, entries: [], updatedAt: START, updatedBy: 'system' }
    ]);
    const items = await table.doc.send(
      new QueryCommand({
        TableName: table.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `LEAGUE#${l.id}` }
      })
    );
    const keys = (items.Items ?? []).map((i) => ({ sk: i.sk, GSI2PK: i.GSI2PK, GSI2SK: i.GSI2SK }));
    expect(keys).toEqual([
      { sk: 'LINEUP#W05#team-2', GSI2PK: undefined, GSI2SK: undefined },
      { sk: 'META', GSI2PK: 'LEAGUEPHASE#regular_season', GSI2SK: `${l.createdAt}#${l.id}` }
    ]);
  });

  it('ignores other items that share the TEAM# prefix', async () => {
    const repos = createDynamoRepos(table);
    const leagueId = unique('lg');
    await repos.teams.create([team(leagueId, 'team-1', 1)]);
    await table.doc.send(
      new PutCommand({
        TableName: table.tableName,
        Item: { pk: `LEAGUE#${leagueId}`, sk: 'TEAM#team-1#AGENT', entity: 'agent_config', personality: 'x' }
      })
    );
    expect((await repos.teams.list(leagueId)).map((t) => t.id)).toEqual(['team-1']);
  });
});

describe.each(backends)('%s draft report card', (_name, make) => {
  it('claims a draft report card once, lets a lapsed claim be retaken, and stores the result', async () => {
    const { drafts } = make();
    const leagueId = unique('lg');
    const grading = (claimedUntil: string): DraftReportCard => ({
      leagueId,
      status: 'grading',
      claimedUntil,
      source: null,
      fallbackReason: null,
      modelKey: null,
      summary: '',
      teams: [],
      createdAt: START,
      updatedAt: START
    });
    expect(await drafts.getReport(leagueId)).toBeNull();
    expect(await drafts.claimReport(grading('2026-09-10T12:02:00.000Z'), '2026-09-10T12:00:00.000Z')).toBe(
      true
    );
    // A live claim holds.
    expect(await drafts.claimReport(grading('2026-09-10T12:03:00.000Z'), '2026-09-10T12:01:00.000Z')).toBe(
      false
    );
    // A lapsed one can be retaken.
    expect(await drafts.claimReport(grading('2026-09-10T12:05:00.000Z'), '2026-09-10T12:03:00.000Z')).toBe(
      true
    );
    expect(await drafts.getReport(leagueId)).toMatchObject({ claimedUntil: '2026-09-10T12:05:00.000Z' });
    const ready: DraftReportCard = {
      ...grading('2026-09-10T12:05:00.000Z'),
      status: 'ready',
      claimedUntil: null,
      source: 'model',
      modelKey: 'claude-sonnet-5',
      summary: 'Team 1 won the draft.',
      teams: [
        {
          teamId: 'team-1',
          grade: 'A-',
          headline: 'Loaded at receiver.',
          strengths: ['Receivers'],
          weaknesses: ['Tight end'],
          analysis: 'A strong start.',
          projectedWins: 9,
          projectedLosses: 5,
          projectedRank: 1,
          projectedPoints: 1712.4,
          expectedWins: 8.6
        }
      ]
    };
    await drafts.putReport(ready);
    expect(await drafts.getReport(leagueId)).toEqual(ready);
    // A finished report card is never claimed again, even long after.
    expect(await drafts.claimReport(grading('2027-01-01T00:00:00.000Z'), '2026-12-31T00:00:00.000Z')).toBe(
      false
    );
  });
});
