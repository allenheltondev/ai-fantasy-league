import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { Jwks } from 'aws-jwt-verify/jwk';

export const USER_POOL_ID = 'us-east-1_TestPool1';
export const CLIENT_ID = 'test-client-id';
export const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${USER_POOL_ID}`;
const KID = 'test-key-1';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const publicJwk = publicKey.export({ format: 'jwk' });

export const jwks: Jwks = {
  keys: [{ kty: 'RSA', n: String(publicJwk.n), e: String(publicJwk.e), kid: KID, alg: 'RS256', use: 'sig' }]
};

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Signs a Cognito-shaped ID token with the test key (or another key, to test rejection). */
export function signIdToken(claims: Record<string, unknown> = {}, key: KeyObject = privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: 'user-123',
    email: 'allen@example.com',
    name: 'Allen',
    aud: CLIENT_ID,
    iss: ISSUER,
    token_use: 'id',
    auth_time: now,
    iat: now,
    exp: now + 3600,
    ...claims
  };
  const input = `${b64url({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64url(payload)}`;
  const signature = sign('RSA-SHA256', Buffer.from(input), key).toString('base64url');
  return `${input}.${signature}`;
}

export function otherPrivateKey(): KeyObject {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
}
