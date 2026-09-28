import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { z } from 'zod';
import { ANONYMOUS, type Principal } from '../auth/principal.js';
import type { TokenVerifier } from '../auth/verifier.js';
import { createContext, type Services } from '../context.js';
import { ApiError, internalError, isApiError } from '../errors.js';
import { API_PREFIX, generateOpenApi } from '../openapi/generate.js';
import type { Envelope } from '../registry/envelope.js';
import { executeOperation } from '../registry/execute.js';
import type { AnyOperation } from '../registry/operation.js';
import type { Registry } from '../registry/registry.js';
import { coerceParams } from './coerce.js';
import { requireOriginSecret } from './origin.js';

export interface AppOptions {
  registry: Registry;
  services: Services;
  /** Verifies bearer tokens. Null means sign-in is not configured: every token is rejected. */
  verifier: TokenVerifier | null;
  /**
   * Origin-verify secrets CloudFront sends (http/origin.ts). When set, every request without one of
   * them is refused with 403. Unset for the local dev server, which has no CloudFront in front.
   */
  originSecrets?: readonly string[];
}

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * The REST adapter: one route per registry operation under /api/v1. Path, query,
 * and body merge into the operation input, and every response is an envelope.
 */
export function createApp(options: AppOptions): Hono {
  const { registry, services, verifier } = options;
  const app = new Hono();
  const openApi = generateOpenApi(registry);
  if (options.originSecrets !== undefined) app.use('*', requireOriginSecret(options.originSecrets));

  app.get(`${API_PREFIX}/openapi.json`, (c) => c.json(openApi));

  for (const op of registry.operations) {
    const route = `${API_PREFIX}${op.path.replace(/\{([A-Za-z0-9]+)\}/g, ':$1')}`;
    app.on(op.method, route, async (c) => {
      const requestId = randomUUID();
      const log = services.log.child({ requestId, operation: op.name });
      c.header('x-request-id', requestId);
      let principal: Principal;
      let input: Record<string, unknown>;
      try {
        principal = await authenticate(verifier, c.req.header('authorization'));
        input = await readInput(c, op);
      } catch (error) {
        return send(c, errorResult(error, log));
      }
      const result = await executeOperation({
        registry,
        operation: op,
        ctx: createContext(services, principal, log),
        input,
        idempotencyKey: c.req.header('idempotency-key') ?? null
      });
      if (result.replayed) c.header('Idempotent-Replayed', 'true');
      return send(c, result);
    });
  }

  app.notFound((c) =>
    send(
      c,
      errorResult(
        new ApiError('ROUTE_NOT_FOUND', `No operation at ${c.req.method} ${c.req.path}.`, {
          fix: `List every operation, with its method and path, at GET ${API_PREFIX}/openapi.json.`
        }),
        services.log
      )
    )
  );
  app.onError((error, c) => send(c, errorResult(error, services.log)));
  return app;
}

function send(c: Context, result: { status: number; body: Envelope }): Response {
  return c.json(result.body, result.status as 200);
}

function errorResult(error: unknown, log: Services['log']): { status: number; body: Envelope } {
  const apiError = isApiError(error) ? error : internalError(error);
  if (!isApiError(error)) log.error('unhandled request error', { error });
  return { status: apiError.status, body: { error: apiError.toBody() } };
}

/** HTTP callers can only ever be anonymous or a verified user; never an agent. */
export async function authenticate(
  verifier: TokenVerifier | null,
  header: string | undefined
): Promise<Principal> {
  if (header === undefined || header.trim() === '') return ANONYMOUS;
  const match = BEARER.exec(header.trim());
  if (match?.[1] === undefined) {
    throw new ApiError('UNAUTHENTICATED', 'The Authorization header is malformed.', {
      fix: 'Send `Authorization: Bearer <ID token>`.'
    });
  }
  if (verifier === null) {
    throw new ApiError('UNAUTHENTICATED', 'Sign-in is not configured on this server.', {
      fix: 'Call without an Authorization header for public operations, or use a server with sign-in configured.'
    });
  }
  return verifier.verify(match[1]);
}

async function readInput(c: Context, op: AnyOperation): Promise<Record<string, unknown>> {
  const shape = op.input.shape as Record<string, z.ZodType>;
  const pathParams = coerceParams(
    shape,
    Object.fromEntries(Object.entries(c.req.param() as Record<string, string>).map(([k, v]) => [k, [v]]))
  );
  const query = coerceParams(shape, c.req.queries());
  const body = op.method === 'GET' || op.method === 'DELETE' ? {} : await readBody(c);
  for (const [name, value] of Object.entries(pathParams)) {
    if (name in body && body[name] !== value) {
      throw new ApiError('INVALID_INPUT', `The body's "${name}" does not match the path.`, {
        fix: `Remove "${name}" from the body or make it equal to the value in the path.`
      });
    }
  }
  return { ...body, ...query, ...pathParams };
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError('INVALID_JSON', 'The request body is not valid JSON.', {
      fix: 'Send a JSON object body with `Content-Type: application/json`.'
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError('INVALID_INPUT', 'The request body must be a JSON object.', {
      fix: 'Wrap the fields in an object, e.g. {"field": "value"}.'
    });
  }
  return parsed as Record<string, unknown>;
}
