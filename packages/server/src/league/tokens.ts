import { createHash, randomBytes } from 'node:crypto';

/** Invite tokens carry 256 random bits (the minimum is 128). */
export const INVITE_TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

/** A new random invite token, URL-safe. Only its hash is stored. */
export function newInviteToken(): string {
  return randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
}

/** SHA-256 of the token, hex. Tokens are high-entropy, so no salt or slow hash is needed. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Cheap shape check before any lookup. */
export function isWellFormedInviteToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}
