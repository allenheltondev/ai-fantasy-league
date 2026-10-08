import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { UserPrincipal } from '../auth/principal.js';
import { createContext, type Services } from '../context.js';
import { ApiError } from '../errors.js';
import type { Logger } from '../log.js';
import type { Envelope } from '../registry/envelope.js';
import { executeOperation } from '../registry/execute.js';
import type { AnyOperation } from '../registry/operation.js';
import type { Registry } from '../registry/registry.js';
import { IDEMPOTENCY_ARGUMENT, toMcpTool, type McpTool } from './tools.js';

/**
 * The league MCP server (#38): the registry's operations as MCP tools over Streamable HTTP at
 * `/api/v1/mcp`, for a person's own assistant (Claude Desktop, a claude.ai custom connector) to act
 * on their own team. It is stateless: every POST builds a server and transport, answers with JSON,
 * and keeps nothing. Callers authenticate with the same Cognito ID token as REST, and each tool call
 * runs `executeOperation` as that user's principal: the same authorization, validation, phase
 * checks, idempotency (the `idempotencyKey` argument), and audit as the REST call.
 */

export const MCP_SERVER_INFO = { name: 'fantasy-league', version: '1.0.0' } as const;

/**
 * Operations that make no sense as tools for an assistant: the browser's realtime subscription
 * settings and the load balancer health check.
 */
export const MCP_EXCLUDED: ReadonlySet<string> = new Set(['get_realtime_config', 'get_health']);

export function mcpEligible(op: AnyOperation): boolean {
  return op.auth !== 'public' && !MCP_EXCLUDED.has(op.name);
}

/** `tools/list` for the league MCP server. */
export function mcpServerTools(registry: Registry): McpTool[] {
  return registry.operations.filter(mcpEligible).map(toMcpTool);
}

export const MCP_INSTRUCTIONS = [
  'Fantasy football league tools. You act as the signed-in person, with exactly their permissions: read any league they belong to and manage their own team.',
  'Start with list_my_leagues, then get_league_state for the phase, your team, and the actions allowed now. Every response carries `league.allowedActions`.',
  'Players always appear as {id, name, team, position}; tools that take a player accept `playerId` or a `player` name. Reads are compact; pass `detail: true` for full records.',
  'Tools that change anything need `idempotencyKey`: a new unique value (a UUID) per action, reused only to retry the same call.',
  'Errors carry `fix`, which says how to correct the call.'
].join(' ');

export interface McpCallContext {
  registry: Registry;
  services: Services;
  principal: UserPrincipal;
  log: Logger;
}

/** Builds the per-request MCP server for one signed-in person. */
export function createMcpServer(call: McpCallContext): Server {
  const server = new Server(MCP_SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: MCP_INSTRUCTIONS
  });
  const tools = mcpServerTools(call.registry);
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const op = call.registry.get(name);
    let body: Envelope;
    if (op === undefined || !mcpEligible(op)) {
      const error = new ApiError('NOT_FOUND', `There is no tool named "${name}".`, {
        fix: 'Call tools/list and use one of the tool names it returns.'
      });
      body = { error: error.toBody() };
    } else {
      const { [IDEMPOTENCY_ARGUMENT]: key, ...input } = args;
      const log = call.log.child({ operation: name, via: 'mcp' });
      const result = await executeOperation({
        registry: call.registry,
        operation: op,
        ctx: createContext(call.services, call.principal, log),
        input,
        idempotencyKey: typeof key === 'string' ? key : null
      });
      body = result.body;
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(body) }],
      structuredContent: body as unknown as Record<string, unknown>,
      isError: 'error' in body
    };
  });
  return server;
}

/** Answers one MCP Streamable HTTP POST statelessly, with a JSON (not SSE) response. */
export async function handleMcpRequest(request: Request, call: McpCallContext): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  const server = createMcpServer(call);
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

/** A JSON-RPC error response for requests refused before they reach the MCP server. */
export function mcpErrorResponse(
  status: number,
  message: string,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}
