import { createHash, randomBytes, randomInt } from 'node:crypto';

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

/**
 * Join codes: six characters people can read aloud and type. No 0/O or 1/I/L, so a code cannot be
 * misread; 31^6 (about 887 million) combinations. A code is a short alias for an invite, so it is
 * stored as typed (the commissioner can see it again) and guarded by a per-user miss limit instead.
 */
export const INVITE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const INVITE_CODE_LENGTH = 6;
const CODE_PATTERN = new RegExp(`^[${INVITE_CODE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`);

/** A new random join code, e.g. `K7MQ2X`. */
export function newInviteCode(): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++)
    code += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)];
  return code;
}

/** The code inside what a person typed (any case, spaces and dashes ignored), or null if it is not one. */
export function parseInviteCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

/** How a code is shown: `K7M-Q2X`. */
export function formatInviteCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}
