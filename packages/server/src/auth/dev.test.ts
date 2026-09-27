import { describe, expect, it } from 'vitest';
import { createDevVerifier, isLocalAuthEnabled } from './dev.js';
import { agentPrincipal, ANONYMOUS, principalKey } from './principal.js';

describe('local auth guard', () => {
  it('is on only with FANTASY_LOCAL_AUTH=1', () => {
    expect(isLocalAuthEnabled({ FANTASY_LOCAL_AUTH: '1' })).toBe(true);
    expect(isLocalAuthEnabled({ FANTASY_LOCAL_AUTH: 'true' })).toBe(false);
    expect(isLocalAuthEnabled({})).toBe(false);
  });

  it('can never be enabled inside Lambda', () => {
    const lambdaEnv = { FANTASY_LOCAL_AUTH: '1', AWS_LAMBDA_FUNCTION_NAME: 'fantasy-api' };
    expect(isLocalAuthEnabled(lambdaEnv)).toBe(false);
    expect(() => createDevVerifier(lambdaEnv)).toThrow(/cannot run inside Lambda/);
    expect(isLocalAuthEnabled({ FANTASY_LOCAL_AUTH: '1', AWS_LAMBDA_FUNCTION_NAME: '' })).toBe(true);
  });

  it('refuses to build a verifier when disabled', () => {
    expect(() => createDevVerifier({})).toThrow(/disabled/);
  });
});

describe('dev verifier', () => {
  const verifier = createDevVerifier({ FANTASY_LOCAL_AUTH: '1' });

  it('signs in dev users by handle', async () => {
    await expect(verifier.verify('dev')).resolves.toEqual({
      type: 'user',
      sub: 'local-dev',
      email: 'dev@localhost',
      name: 'Local Dev'
    });
    await expect(verifier.verify('dev:alice')).resolves.toMatchObject({ sub: 'local-alice', name: 'alice' });
  });

  it('rejects anything else', async () => {
    await expect(verifier.verify('agent:1')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(verifier.verify('dev:Bad Handle')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('principals', () => {
  it('builds stable keys', () => {
    expect(principalKey({ type: 'user', sub: 'u', email: null, name: 'n' })).toBe('user#u');
    expect(principalKey(agentPrincipal({ agentId: 'a', teamId: 't', leagueId: 'l' }))).toBe('agent#a');
    expect(principalKey(ANONYMOUS)).toBe('anonymous');
  });
});
