import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { principalKey, type Principal } from '../auth/principal.js';
import type { Ctx } from '../context.js';
import { ApiError, internalError, isApiError } from '../errors.js';
import { leagueAllowedActions, phaseError, phaseFlags, resolveActor } from '../league/phase.js';
import type { AuditEntry, League } from '../repos/types.js';
import type { Envelope, LeagueStatus, SuccessEnvelope } from './envelope.js';
import { OperationResult, type AnyOperation, type AuthRequirement } from './operation.js';
import type { Registry } from './registry.js';

/** How long a completed mutation can be replayed with the same key. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** How long an in-flight claim blocks the same key before a retry may take it over. */
export const IDEMPOTENCY_LOCK_MS = 5 * 60 * 1000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

export interface ExecuteRequest {
  registry: Registry;
  operation: AnyOperation;
  ctx: Ctx;
  /** Path, query, and body merged. */
  input: Record<string, unknown>;
  idempotencyKey: string | null;
}

export interface ExecuteResult {
  status: number;
  body: Envelope;
  /** True when the body is a stored response for a repeated Idempotency-Key. */
  replayed: boolean;
}

/**
 * The single pipeline every call goes through, whether it came over HTTP or from an
 * agent tool: authorization, validation, phase checks, idempotency, the handler,
 * output validation, the envelope, and the audit log.
 */
export async function executeOperation(request: ExecuteRequest): Promise<ExecuteResult> {
  const { operation: op, ctx } = request;
  const log = ctx.log.child({ operation: op.name });
  let claim: { scope: string; key: string } | null = null;
  let auditable = false;
  let leagueId: string | null = null;
  try {
    authorize(op.auth, ctx.principal);
    const input = validateInput(op, request.input);
    leagueId = typeof input.leagueId === 'string' ? input.leagueId : null;
    if (ctx.principal.type === 'agent' && leagueId !== null && leagueId !== ctx.principal.leagueId) {
      throw new ApiError('FORBIDDEN', 'Agents may only act in their own league.', {
        fix: `Use leagueId "${ctx.principal.leagueId}".`
      });
    }
    if (op.phases !== undefined && leagueId !== null) {
      checkPhase(op, await requireLeague(ctx, leagueId));
    }

    if (op.mutation) {
      const key = requireIdempotencyKey(request.idempotencyKey);
      auditable = true;
      const scope = principalKey(ctx.principal);
      const now = ctx.clock.now();
      const started = await ctx.repos.idempotency.begin({
        scope,
        key,
        operation: op.name,
        requestHash: hashRequest(op.name, input),
        now,
        lockUntil: new Date(now.getTime() + IDEMPOTENCY_LOCK_MS),
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS)
      });
      if (started.status === 'replay') {
        log.info('idempotent replay', { idempotencyKey: key });
        return { status: started.response.status, body: started.response.body as Envelope, replayed: true };
      }
      if (started.status === 'mismatch') {
        auditable = false;
        throw new ApiError(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request.',
          {
            fix: 'Generate a new unique Idempotency-Key for each distinct request; reuse a key only to retry the identical request.',
            details: { originalOperation: started.operation }
          }
        );
      }
      if (started.status === 'in_progress') {
        auditable = false;
        throw new ApiError(
          'IDEMPOTENCY_IN_PROGRESS',
          'A request with this Idempotency-Key is still running.',
          {
            fix: 'Wait a few seconds, then retry with the same Idempotency-Key to get its result.'
          }
        );
      }
      claim = { scope, key };
    }

    const returned = await op.handler({ ...ctx, log, registry: request.registry }, input);
    const result = returned instanceof OperationResult ? returned : new OperationResult(returned, []);
    const data = validateOutput(op, result.data, log);
    const body: SuccessEnvelope = {
      data,
      league: leagueId === null ? null : await leagueStatus(request.registry, ctx, leagueId),
      warnings: result.warnings.map((w) => ({ code: w.code, message: w.message }))
    };
    const response = { status: 200, body };
    if (claim !== null) {
      await ctx.repos.idempotency.complete(claim.scope, claim.key, response, expiry(ctx));
    }
    if (auditable) await audit(ctx, op, leagueId, request.idempotencyKey, null);
    return { ...response, replayed: false };
  } catch (thrown) {
    const error = isApiError(thrown) ? thrown : internalError(thrown);
    if (!isApiError(thrown)) log.error('operation failed', { error: thrown });
    const response = { status: error.status, body: { error: error.toBody() } };
    if (claim !== null) {
      // A 4xx from the handler is a deterministic answer: replay it. A 5xx may be
      // transient, so free the key for a retry.
      if (error.status < 500) {
        await ctx.repos.idempotency.complete(claim.scope, claim.key, response, expiry(ctx));
      } else {
        await ctx.repos.idempotency.release(claim.scope, claim.key);
      }
    }
    if (auditable) await audit(ctx, op, leagueId, request.idempotencyKey, error.code);
    return { ...response, replayed: false };
  }
}

function expiry(ctx: Ctx): Date {
  return new Date(ctx.clock.now().getTime() + IDEMPOTENCY_TTL_MS);
}

export function authorize(requirement: AuthRequirement, principal: Principal): void {
  if (requirement === 'public') return;
  if (principal.type === 'anonymous') {
    throw new ApiError('UNAUTHENTICATED', 'This operation requires signing in.', {
      fix: 'Send `Authorization: Bearer <ID token>` with a Cognito ID token from your Ready, Set, Cloud sign-in.'
    });
  }
  if (requirement === 'user' && principal.type !== 'user') {
    throw new ApiError('FORBIDDEN', 'Only signed-in people can call this operation.', {
      fix: 'This operation is not available to agents; use a different operation.'
    });
  }
}

function validateInput(op: AnyOperation, raw: Record<string, unknown>): Record<string, unknown> {
  const parsed = op.input.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new ApiError('INVALID_INPUT', `Invalid input for ${op.name}.`, {
    fix: `Correct the fields listed in details.issues and retry. The full input schema is operationId "${op.name}" in GET /api/v1/openapi.json.`,
    details: { issues: formatIssues(parsed.error) }
  });
}

export function formatIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message
  }));
}

function validateOutput(op: AnyOperation, data: unknown, log: Ctx['log']): unknown {
  const parsed = op.output.safeParse(data);
  if (parsed.success) return parsed.data;
  log.error('handler output does not match its schema', { issues: formatIssues(parsed.error) });
  throw internalError();
}

function requireIdempotencyKey(key: string | null): string {
  if (key === null || key.length === 0) {
    throw new ApiError(
      'IDEMPOTENCY_KEY_REQUIRED',
      'This operation changes state and needs an idempotency key.',
      {
        fix: 'Send an `Idempotency-Key` header (agents: the `idempotencyKey` argument) with a new unique value such as a UUID. Reuse it only when retrying the same request.'
      }
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError('INVALID_INPUT', 'The idempotency key is malformed.', {
      fix: 'Use 8 to 128 characters from A-Z, a-z, 0-9, and _ . : - (a UUID works).'
    });
  }
  return key;
}

async function requireLeague(ctx: Ctx, leagueId: string): Promise<League> {
  const league = await ctx.repos.leagues.get(leagueId);
  if (league === null) {
    throw new ApiError('LEAGUE_NOT_FOUND', `League "${leagueId}" does not exist.`, {
      fix: 'Check the leagueId. Your leagues are listed by the league operations.'
    });
  }
  return league;
}

function checkPhase(op: AnyOperation, league: League): void {
  if (op.phases === undefined || op.phases.includes(league.phase)) return;
  throw phaseError(op.name, league.phase, op.phases);
}

/** The league block of the envelope: phase, week, sub-phase flags, and what this caller may do now. */
async function leagueStatus(registry: Registry, ctx: Ctx, leagueId: string): Promise<LeagueStatus | null> {
  const league = await ctx.repos.leagues.get(leagueId);
  if (league === null) return null;
  const teams = await ctx.repos.teams.list(leagueId);
  const now = ctx.clock.now();
  return {
    id: league.id,
    phase: league.phase,
    week: league.week,
    flags: phaseFlags(league, now),
    allowedActions: leagueAllowedActions(
      registry.operations,
      league,
      resolveActor(league, teams, ctx.principal),
      now
    )
  };
}

async function audit(
  ctx: Ctx,
  op: AnyOperation,
  leagueId: string | null,
  idempotencyKey: string | null,
  errorCode: string | null
): Promise<void> {
  const principal = ctx.principal;
  const entry: AuditEntry = {
    id: randomUUID(),
    at: ctx.clock.now().toISOString(),
    principal: principalKey(principal),
    principalType: principal.type,
    teamId: principal.type === 'agent' ? principal.teamId : null,
    operation: op.name,
    leagueId,
    idempotencyKey,
    outcome: errorCode === null ? 'ok' : 'error',
    errorCode
  };
  try {
    await ctx.repos.audit.record(entry);
  } catch (error) {
    ctx.log.error('audit write failed', { error, audit: entry });
  }
}

/** Stable hash of the operation and its validated input (object keys sorted). */
export function hashRequest(operation: string, input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([operation, canonical(input)]))
    .digest('hex');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)])
    );
  }
  return value;
}
