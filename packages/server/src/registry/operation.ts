import { z } from 'zod';
import type { Ctx } from '../context.js';
import type { LeaguePhase } from '../repos/types.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * - `public`: anyone, signed in or not.
 * - `authenticated`: a signed-in human or one of our agents (the default).
 * - `user`: a signed-in human only.
 */
export type AuthRequirement = 'public' | 'authenticated' | 'user';

export interface Warning {
  code: string;
  message: string;
}

/** Return this from a handler to attach warnings to the response envelope. */
export class OperationResult<T> {
  constructor(
    readonly data: T,
    readonly warnings: readonly Warning[]
  ) {}
}

export function withWarnings<T>(data: T, warnings: readonly Warning[]): OperationResult<T> {
  return new OperationResult(data, warnings);
}

/** Any zod object schema: operation inputs are always objects (path, query, and body merged). */
export type AnyInputSchema = z.ZodObject<z.core.$ZodLooseShape, z.core.$ZodObjectConfig>;

export interface OperationDefinition<I extends AnyInputSchema, O extends z.ZodType> {
  /** snake_case; also the MCP and agent tool name. */
  name: string;
  method: HttpMethod;
  /** Relative to `/api/v1`, with `{param}` placeholders that must be fields of `input`. */
  path: string;
  summary: string;
  /** Written for a model: when to use it, preconditions, common errors and their fixes. */
  description: string;
  tags?: readonly string[];
  /** Path, query, and body merged into one object. */
  input: I;
  output: O;
  /** Mutations require an Idempotency-Key and are written to the audit log. */
  mutation: boolean;
  auth?: AuthRequirement;
  /** League phases in which the operation may run. Omit to allow every phase. */
  phases?: readonly LeaguePhase[];
  handler(ctx: Ctx, input: z.output<I>): Promise<z.input<O> | OperationResult<z.input<O>>>;
}

export interface Operation<
  I extends AnyInputSchema = AnyInputSchema,
  O extends z.ZodType = z.ZodType
> extends OperationDefinition<I, O> {
  auth: AuthRequirement;
  pathParams: readonly string[];
}

export type AnyOperation = Operation;

const NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const PATH_PARAM = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

export function defineOperation<I extends AnyInputSchema, O extends z.ZodType>(
  definition: OperationDefinition<I, O>
): Operation<I, O> {
  const { name, path, description, summary } = definition;
  if (!NAME_PATTERN.test(name)) throw new Error(`Operation name "${name}" must be snake_case`);
  if (!path.startsWith('/')) throw new Error(`Operation ${name}: path must start with "/"`);
  if (summary.trim().length === 0 || description.trim().length === 0) {
    throw new Error(`Operation ${name}: summary and description are required`);
  }
  const pathParams = [...path.matchAll(PATH_PARAM)].map((m) => m[1] ?? '');
  for (const param of pathParams) {
    if (!(param in definition.input.shape)) {
      throw new Error(`Operation ${name}: path parameter "${param}" is not a field of the input schema`);
    }
  }
  if (definition.mutation && definition.method === 'GET') {
    throw new Error(`Operation ${name}: a mutation cannot use GET`);
  }
  return { ...definition, auth: definition.auth ?? 'authenticated', pathParams };
}
