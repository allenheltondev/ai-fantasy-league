import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, league, type Harness } from '../support/harness.js';
import { signIdToken } from '../support/tokens.js';

/**
 * Security: agent principals are created in-process only. Nothing an HTTP caller
 * sends (body, query, headers, or token claims) can make it an agent.
 */
let h: Harness;
beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo' });
  await h.repos.leagues.create(league({ id: 'lg-sec' }));
});
afterAll(() => h.close());

const AGENT_HEADERS = {
  'x-principal-type': 'agent',
  'x-agent-id': 'agent-1',
  'x-team-id': 'team-1',
  'x-league-id': 'lg-sec',
  'x-amzn-oidc-identity': 'agent-1'
};

describe('an HTTP caller cannot become an agent', () => {
  it('ignores agent claims in the token', async () => {
    const token = signIdToken({
      sub: 'human-1',
      type: 'agent',
      agentId: 'agent-1',
      teamId: 'team-1',
      leagueId: 'lg-sec',
      'custom:principal_type': 'agent'
    });
    const res = await h.request('/api/v1/me', { token, headers: AGENT_HEADERS });
    expect(res.body).toMatchObject({ data: { type: 'user', sub: 'human-1' } });
  });

  it('ignores agent identity in query and headers', async () => {
    const res = await h.request('/api/v1/me?type=agent&agentId=agent-1&principal=agent', {
      headers: AGENT_HEADERS
    });
    expect(res.body).toMatchObject({ data: { type: 'user', sub: 'user-123' } });
  });

  it('ignores agent identity in a mutation body and audits the real user', async () => {
    const res = await h.request('/api/v1/leagues/lg-sec/name', {
      method: 'POST',
      idempotencyKey: 'sec-key-0001',
      headers: AGENT_HEADERS,
      body: {
        name: 'Mine',
        principal: { type: 'agent', agentId: 'agent-1', teamId: 'team-1', leagueId: 'lg-sec' }
      }
    });
    expect(res.status).toBe(200);
    const [entry] = await h.repos.audit.listByLeague('lg-sec');
    expect(entry).toMatchObject({ principal: 'user#user-123', principalType: 'user', teamId: null });
  });

  it('stays anonymous without a token no matter what else is sent', async () => {
    const res = await h.request('/api/v1/me', { token: null, headers: AGENT_HEADERS });
    expect(res.status).toBe(401);
  });

  it('does not accept dev tokens when dev sign-in is off', async () => {
    const res = await h.request('/api/v1/me', { token: 'dev' });
    expect(res.status).toBe(401);
  });
});
