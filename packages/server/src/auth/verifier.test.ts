import { describe, expect, it } from 'vitest';
import { CLIENT_ID, jwks, otherPrivateKey, signIdToken, USER_POOL_ID } from '../../test/support/tokens.js';
import { createCognitoVerifier, principalFromClaims } from './verifier.js';

const verifier = createCognitoVerifier({ userPoolId: USER_POOL_ID, clientId: CLIENT_ID, jwks });

describe('createCognitoVerifier', () => {
  it('verifies a Cognito ID token and builds the user principal from its claims', async () => {
    await expect(verifier.verify(signIdToken())).resolves.toEqual({
      type: 'user',
      sub: 'user-123',
      email: 'allen@example.com',
      name: 'Allen'
    });
  });

  it.each([
    ['an expired token', signIdToken({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ['another app client', signIdToken({ aud: 'someone-else' })],
    ['another issuer', signIdToken({ iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other' })],
    ['an access token', signIdToken({ token_use: 'access' })],
    ['a forged signature', signIdToken({}, otherPrivateKey())],
    ['garbage', 'not.a.jwt']
  ])('rejects %s', async (_label, token) => {
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  });
});

describe('principalFromClaims', () => {
  it('falls back through name claims', () => {
    expect(principalFromClaims({ sub: 's', given_name: 'Al', family_name: 'H' }).name).toBe('Al H');
    expect(principalFromClaims({ sub: 's', preferred_username: 'allen' }).name).toBe('allen');
    expect(principalFromClaims({ sub: 's', email: 'a@b.c' })).toEqual({
      type: 'user',
      sub: 's',
      email: 'a@b.c',
      name: 'a@b.c'
    });
    expect(principalFromClaims({ sub: 's', email: '' })).toEqual({
      type: 'user',
      sub: 's',
      email: null,
      name: 's'
    });
  });

  it('ignores claims that try to make the caller an agent', () => {
    const principal = principalFromClaims({
      sub: 's',
      type: 'agent',
      agentId: 'agent-1',
      'custom:principal_type': 'agent'
    });
    expect(principal.type).toBe('user');
    expect(Object.keys(principal).sort()).toEqual(['email', 'name', 'sub', 'type']);
  });

  it('requires a subject', () => {
    expect(() => principalFromClaims({ email: 'a@b.c' })).toThrow(/subject/);
    expect(() => principalFromClaims({ sub: '' })).toThrow(/subject/);
  });
});
