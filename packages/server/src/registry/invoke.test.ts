import { FixedClock } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { league, START } from '../../test/support/harness.js';
import { testRegistry } from '../../test/support/test-ops.js';
import { agentPrincipal } from '../auth/principal.js';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { silentLogger } from '../log.js';
import { fixturePlayers } from '../players/fixtures.js';
import { createInMemoryRepos, InMemoryAuditRepository } from '../repos/memory.js';
import { createServices } from '../services.js';
import { invokeTool } from './invoke.js';

async function setup() {
  const repos = createInMemoryRepos({ players: fixturePlayers });
  await repos.leagues.create(league());
  const services = createServices({
    clock: new FixedClock(START),
    repos,
    events: new InMemoryEventPublisher(),
    log: silentLogger
  });
  const principal = agentPrincipal({ agentId: 'agent-7', teamId: 'team-7', leagueId: 'lg-1' });
  return { repos, services, principal };
}

describe('invokeTool', () => {
  it('runs the same pipeline as HTTP, taking the key from idempotencyKey', async () => {
    const { services, principal, repos } = await setup();
    const call = {
      registry: testRegistry,
      services,
      principal,
      name: 'pick_player',
      args: { leagueId: 'lg-1', round: 1, player: 'cmc', idempotencyKey: 'agent-key-1' }
    };
    const first = await invokeTool(call);
    expect(first.body).toMatchObject({
      data: { round: 1, player: { id: 'fx-cmc', name: 'Christian McCaffrey', team: 'SF', position: 'RB' } },
      league: { id: 'lg-1', phase: 'setup' }
    });
    expect((await invokeTool(call)).replayed).toBe(true);
    const audit = repos.audit as InMemoryAuditRepository;
    expect(audit.entries[0]).toMatchObject({
      principal: 'agent#agent-7',
      teamId: 'team-7',
      operation: 'pick_player'
    });
  });

  it('needs the idempotency key argument for mutations', async () => {
    const { services, principal } = await setup();
    const result = await invokeTool({
      registry: testRegistry,
      services,
      principal,
      name: 'pick_player',
      args: { leagueId: 'lg-1', round: 1, playerId: 'fx-cmc', idempotencyKey: 7 }
    });
    expect(result.body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
  });

  it('reports unknown tools', async () => {
    const { services, principal } = await setup();
    const result = await invokeTool({ registry: testRegistry, services, principal, name: 'hack', args: {} });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
