import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { Jwks } from 'aws-jwt-verify/jwk';
import { ApiError } from '../errors.js';
import type { UserPrincipal } from './principal.js';

/** Turns a bearer token into a user principal, or throws UNAUTHENTICATED. */
export interface TokenVerifier {
  verify(token: string): Promise<UserPrincipal>;
}

export function unauthenticated(message: string): ApiError {
  return new ApiError('UNAUTHENTICATED', message, {
    fix: 'Sign in again and send `Authorization: Bearer <ID token>` with a fresh Cognito ID token.'
  });
}

/**
 * Builds the principal from verified claims only. It never reads anything that
 * could make the caller an agent: HTTP callers are always users.
 */
export function principalFromClaims(claims: Record<string, unknown>): UserPrincipal {
  const sub = claims.sub;
  if (typeof sub !== 'string' || sub.length === 0) throw unauthenticated('The token has no subject.');
  const email = typeof claims.email === 'string' && claims.email.length > 0 ? claims.email : null;
  const name = firstString(
    claims.name,
    joinNames(claims.given_name, claims.family_name),
    claims.preferred_username,
    email,
    sub
  );
  return Object.freeze({ type: 'user', sub, email, name });
}

function joinNames(given: unknown, family: unknown): string | null {
  const parts = [given, family].filter((p): p is string => typeof p === 'string' && p.length > 0);
  return parts.length === 0 ? null : parts.join(' ');
}

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === 'string' && value.length > 0) return value;
  return '';
}

export interface CognitoVerifierOptions {
  userPoolId: string;
  clientId: string;
  /** Preloaded JWKS (tests and offline use). Normally fetched from Cognito and cached. */
  jwks?: Jwks;
}

/** Verifies Cognito ID tokens (signature, issuer, audience, expiry, token_use=id). */
export function createCognitoVerifier(options: CognitoVerifierOptions): TokenVerifier {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: options.userPoolId,
    clientId: options.clientId,
    tokenUse: 'id'
  });
  if (options.jwks !== undefined) verifier.cacheJwks(options.jwks);
  return {
    async verify(token) {
      let claims: Record<string, unknown>;
      try {
        claims = await verifier.verify(token);
      } catch (error) {
        throw new ApiError('UNAUTHENTICATED', 'The bearer token is invalid or expired.', {
          fix: 'Sign in again and send `Authorization: Bearer <ID token>` with a fresh Cognito ID token (not the access token).',
          cause: error
        });
      }
      return principalFromClaims(claims);
    }
  };
}
