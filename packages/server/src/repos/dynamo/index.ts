import type { Repos } from '../types.js';
import { DynamoAgentRepository } from './agents.js';
import { DynamoAuditRepository } from './audit.js';
import { DynamoDraftRepository } from './drafts.js';
import { DynamoChatRepository } from './chat.js';
import { DynamoIdempotencyRepository } from './idempotency.js';
import { DynamoInviteRepository } from './invites.js';
import { DynamoLeagueRepository } from './leagues.js';
import { DynamoLineupRepository } from './lineups.js';
import { DynamoMemberRepository } from './members.js';
import { DynamoPlayerRepository } from './players.js';
import { DynamoScheduleRepository } from './schedule.js';
import type { TableContext } from './table.js';
import { DynamoTeamRepository } from './teams.js';
import { DynamoWaiverRepository } from './waivers.js';

export function createDynamoRepos(table: TableContext): Repos {
  return {
    idempotency: new DynamoIdempotencyRepository(table),
    audit: new DynamoAuditRepository(table),
    players: new DynamoPlayerRepository(table),
    leagues: new DynamoLeagueRepository(table),
    teams: new DynamoTeamRepository(table),
    members: new DynamoMemberRepository(table),
    invites: new DynamoInviteRepository(table),
    schedule: new DynamoScheduleRepository(table),
    lineups: new DynamoLineupRepository(table),
    drafts: new DynamoDraftRepository(table),
    agents: new DynamoAgentRepository(table),
    waivers: new DynamoWaiverRepository(table),
    chat: new DynamoChatRepository(table)
  };
}

export {
  DynamoAgentRepository,
  DynamoAuditRepository,
  DynamoDraftRepository,
  DynamoChatRepository,
  DynamoIdempotencyRepository,
  DynamoInviteRepository,
  DynamoLeagueRepository,
  DynamoLineupRepository,
  DynamoMemberRepository,
  DynamoPlayerRepository,
  DynamoScheduleRepository,
  DynamoTeamRepository,
  DynamoWaiverRepository
};
