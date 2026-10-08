import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_EXCLUDED, mcpServerTools } from '../../src/mcp/server.js';
import { registry } from '../../src/operations/index.js';
import { createHarness, type Harness } from '../support/harness.js';
import { ALICE, CAROL, seedLeague } from '../support/leagues.js';
import { signIdToken } from '../support/tokens.js';

/**
 * The league MCP server (#38) with the official MCP SDK client against the real app: the same
 * bearer token, principal, validation, and idempotency as REST.
 */

const URL_MCP = 'http://localhost/api/v1/mcp';
let h: Harness;

const tokenFor = (p: { sub: string; name: string; email: string }) =>
  signIdToken({ sub: p.sub, name: p.name, email: p.email });

async function connect(token: string | null): Promise<Client> {
  const client = new Client({ name: 'test-assistant', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), {
    fetch: async (input, init) => h.app.fetch(new Request(input, init)),
    ...(token === null ? {} : { requestInit: { headers: { authorization: `Bearer ${token}` } } })
  });
  await client.connect(transport);
  return client;
}

type Envelope = { data?: Record<string, unknown>; error?: { code: string; fix: string } };
const envelope = (result: Awaited<ReturnType<Client['callTool']>>) => result.structuredContent as Envelope;

beforeAll(async () => {
  h = await createHarness({ registry });
  await seedLeague(h.repos, { id: 'lg-mcp', owners: [ALICE] });
});
afterAll(() => h.close());

describe('league MCP server', () => {
  it('lists the registry operations as tools, minus the excluded ones', async () => {
    const client = await connect(tokenFor(ALICE));
    expect(client.getServerVersion()).toMatchObject({ name: 'fantasy-league' });
    expect(client.getInstructions()).toMatch(/idempotencyKey/);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(mcpServerTools(registry).map((t) => t.name));
    expect(names).toEqual(expect.arrayContaining(['get_league_state', 'get_matchup_outlook', 'set_lineup']));
    for (const excluded of MCP_EXCLUDED) expect(names).not.toContain(excluded);
    const rename = tools.find((t) => t.name === 'rename_team');
    expect(rename?.inputSchema.required).toContain('idempotencyKey');
    expect(rename?.annotations?.readOnlyHint).toBe(false);
    await client.close();
  });

  it('calls a read as the signed-in person', async () => {
    const client = await connect(tokenFor(ALICE));
    const result = await client.callTool({ name: 'get_league_state', arguments: { leagueId: 'lg-mcp' } });
    expect(result.isError).toBe(false);
    expect(envelope(result).data).toMatchObject({ leagueId: 'lg-mcp', youAreCommissioner: true });
    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? '')).toEqual(
      result.structuredContent
    );

    const outsider = await connect(tokenFor(CAROL));
    const refused = await outsider.callTool({ name: 'get_league_state', arguments: { leagueId: 'lg-mcp' } });
    expect(refused.isError).toBe(true);
    expect(envelope(refused).error?.code).toBe('FORBIDDEN');
    await Promise.all([client.close(), outsider.close()]);
  });

  it('runs a mutation once per idempotency key and requires one', async () => {
    const client = await connect(tokenFor(ALICE));
    const args = { leagueId: 'lg-mcp', teamId: 'team-1', name: 'MCP Marauders' };
    const missing = await client.callTool({ name: 'rename_team', arguments: args });
    expect(envelope(missing).error?.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const first = await client.callTool({
      name: 'rename_team',
      arguments: { ...args, idempotencyKey: 'mcp-rename-1' }
    });
    expect(first.isError, JSON.stringify(first.structuredContent)).toBe(false);
    expect((await h.repos.teams.get('lg-mcp', 'team-1'))?.name).toBe('MCP Marauders');
    const replay = await client.callTool({
      name: 'rename_team',
      arguments: { ...args, idempotencyKey: 'mcp-rename-1' }
    });
    expect(replay.structuredContent).toEqual(first.structuredContent);

    const invalid = await client.callTool({
      name: 'rename_team',
      arguments: { leagueId: 'lg-mcp', teamId: 'team-1', idempotencyKey: 'mcp-rename-2' }
    });
    expect(envelope(invalid).error?.code).toBe('INVALID_INPUT');

    const unknown = await client.callTool({ name: 'get_realtime_config', arguments: { leagueId: 'lg-mcp' } });
    expect(envelope(unknown).error?.code).toBe('NOT_FOUND');
    await client.close();
  });

  it('refuses requests without a valid token', async () => {
    await expect(connect(null)).rejects.toThrow(/401|Sign in|Unauthorized/i);
    await expect(connect('not-a-jwt')).rejects.toThrow();
    const res = await h.app.request('/api/v1/mcp', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    const get = await h.app.request('/api/v1/mcp', {
      headers: { authorization: `Bearer ${tokenFor(ALICE)}` }
    });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });
});
