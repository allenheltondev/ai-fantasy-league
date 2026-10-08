import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { yahooDefaultSettings } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { START } from '../../test/support/harness.js';
import { claimSeat, newTeam } from '../league/seats.js';
import { ENTITY } from './dynamo/league-records.js';
import { DynamoTeamRepository } from './dynamo/teams.js';
import { createInMemoryRepos } from './memory.js';
import { backfillSeatTenure, seatTenureStart, type Member, type Team } from './types.js';

/** Seat tenure for teams stored before `occupiedSince` (#148), backfilled from memberships. */

const JOINED = '2026-09-12T08:30:00.000Z';
const settings = yahooDefaultSettings(8);

/** A team as stored before `occupiedSince` existed: created as an AI seat, later taken by `u2`. */
function legacyTeam(id = 'team-2', slot = 2): Team {
  const created = newTeam({ leagueId: 'lg', id, draftSlot: slot, settings, now: new Date(START) });
  const { occupiedSince: _dropped, ...claimed } = claimSeat(
    created,
    { userId: 'u2', name: 'Pat' },
    'Pat FC',
    new Date(JOINED)
  );
  return claimed;
}

const membership: Member = { leagueId: 'lg', userId: 'u2', teamId: 'team-2', joinedAt: JOINED };

describe('backfillSeatTenure', () => {
  it("starts a legacy holder's tenure when they joined, not when the team was created", () => {
    const team = legacyTeam();
    expect(seatTenureStart(team)).toBe(START);
    const filled = backfillSeatTenure(team, membership);
    expect(filled.occupiedSince).toBe(JOINED);
    expect(seatTenureStart(filled)).toBe(JOINED);
  });

  it('never starts a tenure before the team existed', () => {
    const early = { ...membership, joinedAt: '2026-09-01T00:00:00.000Z' };
    expect(backfillSeatTenure(legacyTeam(), early).occupiedSince).toBe(START);
  });

  it('leaves teams that record their tenure, open seats, and mismatched memberships alone', () => {
    const recorded = { ...legacyTeam(), occupiedSince: '2026-09-15T00:00:00.000Z' };
    expect(backfillSeatTenure(recorded, membership)).toBe(recorded);
    const open = { ...legacyTeam(), ownerUserId: null, ownerName: null, seatType: 'agent' as const };
    expect(backfillSeatTenure(open, membership)).toBe(open);
    const team = legacyTeam();
    expect(backfillSeatTenure(team, null)).toBe(team);
    expect(backfillSeatTenure(team, { ...membership, teamId: 'team-3' })).toBe(team);
    expect(backfillSeatTenure(team, { ...membership, userId: 'u9' })).toBe(team);
  });
});

describe('in-memory teams', () => {
  it('read a legacy team with its holder’s tenure, and the next write stores it', async () => {
    const repos = createInMemoryRepos();
    const agentSeat = newTeam({ leagueId: 'lg', id: 'team-3', draftSlot: 3, settings, now: new Date(START) });
    const { occupiedSince: _dropped, ...legacyAgent } = agentSeat;
    await repos.teams.create([legacyTeam(), legacyAgent]);
    await repos.members.add(membership);
    expect((await repos.teams.get('lg', 'team-2'))?.occupiedSince).toBe(JOINED);
    expect((await repos.teams.list('lg')).map((t) => [t.id, t.occupiedSince])).toEqual([
      ['team-2', JOINED],
      // An AI seat has no membership to read: it keeps the `createdAt` fallback.
      ['team-3', undefined]
    ]);
    const written = await repos.teams.update({
      ...(await repos.teams.get('lg', 'team-2'))!,
      name: 'Renamed'
    });
    await repos.members.remove('lg', 'u2');
    expect((await repos.teams.get('lg', 'team-2'))?.occupiedSince).toBe(written.occupiedSince);
    expect(written.occupiedSince).toBe(JOINED);
  });
});

describe('DynamoDB teams', () => {
  /** A table holding `items` that answers GetItem and Query from them, recording each command. */
  function fakeTable(items: Record<string, unknown>[]) {
    const sent: string[] = [];
    const send = async (command: GetCommand | QueryCommand) => {
      if (command instanceof GetCommand) {
        const { pk, sk } = command.input.Key as { pk: string; sk: string };
        sent.push(`get ${sk}`);
        return { Item: items.find((item) => item.pk === pk && item.sk === sk) };
      }
      const values = command.input.ExpressionAttributeValues as Record<string, string>;
      sent.push(`query ${values[':prefix']}`);
      return {
        Items: items.filter(
          (item) =>
            item.pk === values[':pk'] &&
            String(item.sk).startsWith(values[':prefix'] as string) &&
            Object.entries(values).some(
              ([key, value]) => key !== ':pk' && key !== ':prefix' && item.entity === value
            )
        )
      };
    };
    return { sent, table: { tableName: 'T', doc: { send } as unknown as DynamoDBDocumentClient } };
  }
  const teamItem = (team: Team) => ({ pk: 'LEAGUE#lg', sk: `TEAM#${team.id}`, entity: ENTITY.team, ...team });
  const memberItem = (member: Member) => ({
    pk: 'LEAGUE#lg',
    sk: `MEMBER#${member.userId}`,
    entity: ENTITY.member,
    ...member
  });

  it("read a legacy team with its holder's tenure from the membership", async () => {
    const { sent, table } = fakeTable([teamItem(legacyTeam()), memberItem(membership)]);
    const repo = new DynamoTeamRepository(table);
    expect((await repo.get('lg', 'team-2'))?.occupiedSince).toBe(JOINED);
    expect((await repo.list('lg')).map((t) => t.occupiedSince)).toEqual([JOINED]);
    expect(sent).toEqual(['get TEAM#team-2', 'get MEMBER#u2', 'query TEAM#', 'query MEMBER#']);
  });

  it('read no memberships for teams that record their tenure or that nobody holds', async () => {
    const recorded = { ...legacyTeam(), occupiedSince: JOINED };
    const { occupiedSince: _dropped, ...agentSeat } = newTeam({
      leagueId: 'lg',
      id: 'team-3',
      draftSlot: 3,
      settings,
      now: new Date(START)
    });
    const { sent, table } = fakeTable([teamItem(recorded), teamItem(agentSeat), memberItem(membership)]);
    const repo = new DynamoTeamRepository(table);
    expect((await repo.get('lg', 'team-2'))?.occupiedSince).toBe(JOINED);
    expect((await repo.get('lg', 'team-3'))?.occupiedSince).toBeUndefined();
    expect(await repo.list('lg')).toHaveLength(2);
    expect(sent).toEqual(['get TEAM#team-2', 'get TEAM#team-3', 'query TEAM#']);
  });

  it('keep the createdAt fallback when the membership is gone', async () => {
    const { table } = fakeTable([teamItem(legacyTeam())]);
    const repo = new DynamoTeamRepository(table);
    expect((await repo.get('lg', 'team-2'))?.occupiedSince).toBeUndefined();
    expect((await repo.list('lg'))[0]?.occupiedSince).toBeUndefined();
  });
});
