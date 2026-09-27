import { API_VERSION } from '../operations/system.js';
import {
  ErrorEnvelopeSchema,
  LeagueStatusSchema,
  successEnvelopeSchema,
  WarningSchema
} from '../registry/envelope.js';
import type { AnyOperation } from '../registry/operation.js';
import type { Registry } from '../registry/registry.js';
import { splitObjectSchema, toJsonSchema, type JsonSchema } from './json-schema.js';

export const API_PREFIX = '/api/v1';

const API_DESCRIPTION = [
  'One API for people and AI agents in the same fantasy football league. Every operation here is also an agent tool with the same name.',
  '',
  'Conventions:',
  '- Success responses are `{ data, league, warnings }`. `league` (phase, week, allowedActions) is present whenever the request is about a league; check `allowedActions` before acting.',
  '- Errors are `{ error: { code, message, fix, details } }`. `fix` says exactly what to change; follow it.',
  '- Players always appear as `{ id, name, team, position }`. Anything that takes a player accepts `playerId` or `player` (a name); ambiguous names return AMBIGUOUS_PLAYER with candidates.',
  '- `detail: true` returns full records instead of compact ones.',
  '- Every mutation needs an `Idempotency-Key` header with a unique value. Retrying with the same key returns the original response (header `Idempotent-Replayed: true`).'
].join('\n');

/** Converts `/leagues/{leagueId}` to the full OpenAPI path. */
export function openApiPath(op: AnyOperation): string {
  return `${API_PREFIX}${op.path}`;
}

const hasBody = (op: AnyOperation) => op.method !== 'GET' && op.method !== 'DELETE';

function describeOperation(op: AnyOperation): string {
  const notes: string[] = [];
  if (op.mutation)
    notes.push('Mutation: requires an `Idempotency-Key` header and is recorded in the audit log.');
  if (op.phases !== undefined) notes.push(`Allowed league phases: ${op.phases.join(', ')}.`);
  return notes.length === 0 ? op.description : `${op.description}\n\n${notes.join(' ')}`;
}

function operationObject(op: AnyOperation): JsonSchema {
  const input = splitObjectSchema(toJsonSchema(op.input, 'input'));
  const parameters: JsonSchema[] = [];
  const bodyProperties: Record<string, JsonSchema> = {};
  for (const [name, schema] of Object.entries(input.properties)) {
    const isPath = op.pathParams.includes(name);
    if (!isPath && hasBody(op)) {
      bodyProperties[name] = schema;
      continue;
    }
    const { description, ...rest } = schema;
    const parameter: JsonSchema = {
      name,
      in: isPath ? 'path' : 'query',
      required: isPath || input.required.includes(name),
      schema: rest
    };
    if (typeof description === 'string') parameter.description = description;
    parameters.push(parameter);
  }
  if (op.mutation) {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      description:
        'A unique value (e.g. a UUID) per distinct request. Reuse it only to retry the same request.',
      schema: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{8,128}$' }
    });
  }

  const result: JsonSchema = {
    operationId: op.name,
    summary: op.summary,
    description: describeOperation(op),
    tags: [...(op.tags ?? [])],
    parameters,
    responses: {
      '200': {
        description: 'Success',
        content: { 'application/json': { schema: toJsonSchema(successEnvelopeSchema(op.output), 'output') } }
      },
      '4XX': { $ref: '#/components/responses/Error' },
      '5XX': { $ref: '#/components/responses/Error' }
    },
    security: op.auth === 'public' ? [] : [{ bearerAuth: [] }],
    'x-mutation': op.mutation
  };
  if (hasBody(op)) {
    const required = input.required.filter((name) => name in bodyProperties);
    const body: JsonSchema = { type: 'object', properties: bodyProperties };
    if (required.length > 0) body.required = required;
    result.requestBody = {
      required: required.length > 0,
      content: { 'application/json': { schema: body } }
    };
  }
  if (op.phases !== undefined) result['x-phases'] = [...op.phases];
  return result;
}

/** The OpenAPI 3.1 document for every operation in the registry. */
export function generateOpenApi(registry: Registry): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const op of registry.operations) {
    const path = openApiPath(op);
    paths[path] ??= {};
    paths[path][op.method.toLowerCase()] = operationObject(op);
  }
  const tags = [...new Set(registry.operations.flatMap((op) => op.tags ?? []))]
    .sort()
    .map((name) => ({ name }));
  return {
    openapi: '3.1.0',
    info: { title: 'AI Fantasy League API', version: API_VERSION, description: API_DESCRIPTION },
    tags,
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    components: {
      schemas: {
        ErrorEnvelope: toJsonSchema(ErrorEnvelopeSchema, 'output'),
        LeagueStatus: toJsonSchema(LeagueStatusSchema, 'output'),
        Warning: toJsonSchema(WarningSchema, 'output')
      },
      responses: {
        Error: {
          description: 'An error. `error.fix` explains how to correct the request.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } }
        }
      },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'A Cognito ID token from the Ready, Set, Cloud user pool.'
        }
      }
    }
  };
}

/** The exact text of the committed `packages/server/openapi.json`. */
export function renderOpenApi(registry: Registry): string {
  return `${JSON.stringify(generateOpenApi(registry), null, 2)}\n`;
}
