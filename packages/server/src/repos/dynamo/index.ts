import type { Repos } from '../types.js';
import { DynamoAuditRepository } from './audit.js';
import { DynamoIdempotencyRepository } from './idempotency.js';
import { DynamoInviteRepository } from './invites.js';
import { DynamoLeagueRepository } from './leagues.js';
import { DynamoMemberRepository } from './members.js';
import { DynamoPlayerRepository } from './players.js';
import { DynamoScheduleRepository } from './schedule.js';
import type { TableContext } from './table.js';
import { DynamoTeamRepository } from './teams.js';

export function createDynamoRepos(table: TableContext): Repos {
  return {
    idempotency: new DynamoIdempotencyRepository(table),
    audit: new DynamoAuditRepository(table),
    players: new DynamoPlayerRepository(table),
    leagues: new DynamoLeagueRepository(table),
    teams: new DynamoTeamRepository(table),
    members: new DynamoMemberRepository(table),
    invites: new DynamoInviteRepository(table),
    schedule: new DynamoScheduleRepository(table)
  };
}

export {
  DynamoAuditRepository,
  DynamoIdempotencyRepository,
  DynamoInviteRepository,
  DynamoLeagueRepository,
  DynamoMemberRepository,
  DynamoPlayerRepository,
  DynamoScheduleRepository,
  DynamoTeamRepository
};
