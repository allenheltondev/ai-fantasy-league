import type { Repos } from '../types.js';
import { DynamoAuditRepository } from './audit.js';
import { DynamoIdempotencyRepository } from './idempotency.js';
import { DynamoLeagueRepository } from './leagues.js';
import { DynamoPlayerRepository } from './players.js';
import type { TableContext } from './table.js';

export function createDynamoRepos(table: TableContext): Repos {
  return {
    idempotency: new DynamoIdempotencyRepository(table),
    audit: new DynamoAuditRepository(table),
    players: new DynamoPlayerRepository(table),
    leagues: new DynamoLeagueRepository(table)
  };
}

export { DynamoAuditRepository, DynamoIdempotencyRepository, DynamoLeagueRepository, DynamoPlayerRepository };
