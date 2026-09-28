import { describe, expect, it } from 'vitest';
import { testRegistry } from '../../test/support/test-ops.js';
import { generateMcpTools } from '../mcp/tools.js';
import { registry } from '../operations/index.js';
import { generateOpenApi } from './generate.js';

type Json = Record<string, unknown>;
const doc = generateOpenApi(testRegistry) as {
  paths: Record<string, Record<string, Json>>;
  components: Json;
};

describe('generateOpenApi', () => {
  it('emits one operation per registry entry under /api/v1', () => {
    const operationIds = Object.values(doc.paths).flatMap((methods) =>
      Object.values(methods).map((op) => op.operationId)
    );
    expect(operationIds.sort()).toEqual(testRegistry.operations.map((op) => op.name).sort());
  });

  it('puts path params in the path, the rest in the body for POST, and requires the idempotency header', () => {
    const op = doc.paths['/api/v1/leagues/{leagueId}/name']?.post as Json;
    expect(op.parameters).toEqual([
      expect.objectContaining({ name: 'leagueId', in: 'path', required: true }),
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true })
    ]);
    expect(op.requestBody).toMatchObject({
      required: true,
      content: { 'application/json': { schema: { required: ['name'], properties: { name: {}, fail: {} } } } }
    });
    expect(op['x-phases']).toEqual(['setup', 'drafting']);
    expect(op.description).toMatch(/Mutation: requires an `Idempotency-Key`/);
    expect(op.security).toEqual([{ bearerAuth: [] }]);
  });

  it('marks a body optional when nothing in it is required', () => {
    const op = doc.paths['/api/v1/explode']?.post as Json;
    expect(op.requestBody).toMatchObject({ required: false });
  });

  it('puts non-path fields of reads in the query and leaves public operations unsecured', () => {
    const search = doc.paths['/api/v1/players']?.get as { parameters: Json[] };
    expect(search.parameters.map((p) => [p.name, p.in])).toEqual([
      ['q', 'query'],
      ['position', 'query'],
      ['team', 'query'],
      ['limit', 'query'],
      ['detail', 'query'],
      ['leagueId', 'query'],
      ['availability', 'query']
    ]);
    expect(doc.paths['/api/v1/health']?.get?.security).toEqual([]);
  });
});

describe('generateMcpTools', () => {
  const tools = generateMcpTools(testRegistry);

  it('lists every operation with its model-facing description', () => {
    expect(tools.map((t) => t.name)).toEqual(testRegistry.operations.map((op) => op.name));
    const search = tools.find((t) => t.name === 'search_players');
    expect(search?.description).toMatch(/^Search NFL players by name, team, or position\.\n\nFinds players/);
    expect(search?.annotations.readOnlyHint).toBe(true);
    expect(search?.inputSchema).toMatchObject({ type: 'object', properties: { q: { type: 'string' } } });
    expect(search?.inputSchema).not.toHaveProperty('required');
  });

  it('adds a required idempotencyKey argument to mutations', () => {
    const rename = tools.find((t) => t.name === 'rename_league');
    expect(rename?.annotations.readOnlyHint).toBe(false);
    expect(rename?.inputSchema.required).toEqual(['leagueId', 'name', 'idempotencyKey']);
    const explode = tools.find((t) => t.name === 'explode');
    expect(explode?.inputSchema.required).toEqual(['idempotencyKey']);
  });

  it('covers the production registry', () => {
    const names = generateMcpTools(registry).map((t) => t.name);
    expect([...names].sort()).toEqual(registry.operations.map((op) => op.name).sort());
    expect(names).toEqual(
      expect.arrayContaining([
        'get_health',
        'get_me',
        'get_player',
        'search_players',
        'get_projections',
        'get_trending_players',
        'get_news',
        'create_league',
        'create_invite',
        'delete_league',
        'get_invite',
        'get_league',
        'get_league_state',
        'get_matchup',
        'get_standings',
        'join_league',
        'leave_league',
        'list_invites',
        'list_my_leagues',
        'remove_member',
        'rename_team',
        'revoke_invite',
        'set_seat_type',
        'transfer_commissioner',
        'update_league_settings',
        'configure_agent_seat',
        'randomize_agent_seats',
        'get_agent_seat',
        'get_agent_activity',
        'get_agent_catalog',
        'get_default_settings'
      ])
    );
  });
});
