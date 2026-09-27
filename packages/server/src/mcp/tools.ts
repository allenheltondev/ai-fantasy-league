import { splitObjectSchema, toJsonSchema, type JsonSchema } from '../openapi/json-schema.js';
import type { AnyOperation } from '../registry/operation.js';
import type { Registry } from '../registry/registry.js';

/** An MCP `tools/list` entry. */
export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export const IDEMPOTENCY_ARGUMENT = 'idempotencyKey';

export function toolInputSchema(op: AnyOperation): JsonSchema {
  const { properties, required, rest } = splitObjectSchema(toJsonSchema(op.input, 'input'));
  const schema: JsonSchema = { type: 'object', ...rest, properties: { ...properties } };
  const needs = [...required];
  if (op.mutation) {
    (schema.properties as Record<string, JsonSchema>)[IDEMPOTENCY_ARGUMENT] = {
      type: 'string',
      pattern: '^[A-Za-z0-9_.:-]{8,128}$',
      description:
        'A new unique value (e.g. a UUID) for this action. Reuse it only to retry the exact same call; a retry returns the original result instead of acting twice.'
    };
    needs.push(IDEMPOTENCY_ARGUMENT);
  }
  if (needs.length > 0) schema.required = needs;
  return schema;
}

export function toMcpTool(op: AnyOperation): McpTool {
  return {
    name: op.name,
    title: op.summary,
    description: `${op.summary}.\n\n${op.description}`,
    inputSchema: toolInputSchema(op),
    annotations: {
      title: op.summary,
      readOnlyHint: !op.mutation,
      idempotentHint: true,
      openWorldHint: false
    }
  };
}

/** The MCP tool list, generated from the same registry as REST and OpenAPI. */
export function generateMcpTools(registry: Registry): McpTool[] {
  return registry.operations.map(toMcpTool);
}
