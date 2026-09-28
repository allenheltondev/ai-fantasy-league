/**
 * Every failure the API reports is an `ApiError`. The REST adapter renders it as
 * `{ error: { code, message, fix, details } }`, and agents receive the same object
 * as their tool result, so `fix` is written for a model: say exactly what to change.
 */

export const ERROR_STATUS = {
  INVALID_INPUT: 400,
  INVALID_JSON: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  AMBIGUOUS_PLAYER: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  PLAYER_NOT_FOUND: 404,
  LEAGUE_NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  PHASE_NOT_ALLOWED: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  INTERNAL: 500,
  // League lifecycle
  INVALID_SETTINGS: 400,
  INVITE_NOT_FOUND: 404,
  TEAM_NOT_FOUND: 404,
  ALREADY_A_MEMBER: 409,
  NO_OPEN_SEATS: 409,
  INVITE_EXPIRED: 410,
  INVITE_REVOKED: 410,
  INVITE_USED_UP: 410,
  LEAGUE_QUOTA_EXCEEDED: 403,
  // Season loop
  INVALID_LINEUP: 400,
  PLAYER_LOCKED: 409,
  // Draft
  SEATS_NOT_FILLED: 409,
  DRAFT_NOT_STARTED: 409,
  DRAFT_PAUSED: 409,
  DRAFT_COMPLETE: 409,
  NOT_YOUR_TURN: 409,
  PLAYER_ALREADY_DRAFTED: 409,
  ROSTER_WOULD_BE_INVALID: 409,
  ROSTER_POSITION_LIMIT: 409,
  // Waivers and free agency
  ROSTER_FULL: 409,
  INSUFFICIENT_FAAB: 409,
  INVALID_BID: 400,
  ZERO_BID_NOT_ALLOWED: 400,
  PLAYER_NOT_AVAILABLE: 409,
  PLAYER_NOT_ON_ROSTER: 409,
  DROP_PLAYER_NOT_ON_ROSTER: 409,
  ACQUISITION_LIMIT_REACHED: 409,
  DUPLICATE_WAIVER_CLAIM: 409,
  WAIVER_CLAIM_NOT_FOUND: 404,
  WAIVER_CLAIM_NOT_PENDING: 409
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[];

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  fix: string;
  details?: Record<string, unknown>;
}

export interface ApiErrorOptions {
  /** What the caller should do differently. Required: every error explains its fix. */
  fix: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fix: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: ApiErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    if (options.fix.trim().length === 0) {
      throw new TypeError(`ApiError ${code} needs a non-empty fix`);
    }
    this.fix = options.fix;
    this.details = options.details;
  }

  toBody(): ApiErrorBody {
    const body: ApiErrorBody = { code: this.code, message: this.message, fix: this.fix };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function internalError(cause?: unknown): ApiError {
  return new ApiError('INTERNAL', 'The server hit an unexpected error.', {
    fix: 'Retry the same request (reuse your Idempotency-Key for mutations). If it keeps failing, report it.',
    cause
  });
}
