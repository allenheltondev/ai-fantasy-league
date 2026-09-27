import type { AgentPrincipal } from '../auth/principal.js';
import { createContext, type Services } from '../context.js';
import { ApiError } from '../errors.js';
import { IDEMPOTENCY_ARGUMENT } from '../mcp/tools.js';
import { executeOperation, type ExecuteResult } from './execute.js';
import type { Registry } from './registry.js';

export interface ToolCall {
  registry: Registry;
  services: Services;
  /** Created by the agent runtime in-process. Never taken from a request. */
  principal: AgentPrincipal;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Runs an agent's tool call through exactly the same pipeline as an HTTP request.
 * The idempotency key comes from the `idempotencyKey` argument instead of a header.
 */
export async function invokeTool(call: ToolCall): Promise<ExecuteResult> {
  const op = call.registry.get(call.name);
  if (op === undefined) {
    const error = new ApiError('NOT_FOUND', `There is no tool named "${call.name}".`, {
      fix: 'Call one of the tools you were given; names are snake_case.'
    });
    return { status: error.status, body: { error: error.toBody() }, replayed: false };
  }
  const { [IDEMPOTENCY_ARGUMENT]: key, ...input } = call.args;
  const log = call.services.log.child({ agentId: call.principal.agentId, teamId: call.principal.teamId });
  return executeOperation({
    registry: call.registry,
    operation: op,
    ctx: createContext(call.services, call.principal, log),
    input,
    idempotencyKey: typeof key === 'string' ? key : null
  });
}
