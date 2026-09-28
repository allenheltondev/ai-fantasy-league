import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FunctionUrlEvent } from './lambda.js';

const LAMBDA_ENV = {
  AWS_LAMBDA_FUNCTION_NAME: 'fantasy-api',
  AWS_REGION: 'us-east-1',
  TABLE_NAME: 'FantasyTable',
  USER_POOL_ID: 'us-east-1_TestPool1',
  USER_POOL_CLIENT_ID: 'client',
  ORIGIN_VERIFY_SECRET: 'origin-current',
  ORIGIN_VERIFY_SECRET_PREVIOUS: 'origin-previous',
  // Even if someone sets it in Lambda, dev sign-in must stay off.
  FANTASY_LOCAL_AUTH: '1'
};

/** A Lambda Function URL event (payload format 2.0), as CloudFront forwards it. */
function functionUrlEvent(
  method: string,
  path: string,
  headers: Record<string, string> = {}
): FunctionUrlEvent {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { host: 'abc.lambda-url.us-east-1.on.aws', 'x-origin-verify': 'origin-current', ...headers },
    body: null,
    isBase64Encoded: false,
    requestContext: {
      accountId: '123456789012',
      apiId: 'abc',
      domainName: 'abc.lambda-url.us-east-1.on.aws',
      domainPrefix: 'abc',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: '$default',
      stage: '$default',
      time: '10/Sep/2026:12:00:00 +0000',
      timeEpoch: 1789041600000
    }
  } as unknown as FunctionUrlEvent;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadHandler() {
  for (const [key, value] of Object.entries(LAMBDA_ENV)) vi.stubEnv(key, value);
  return (await import('./lambda.js')).handler;
}

describe('lambda handler', () => {
  it('serves Function URL events', async () => {
    const handler = await loadHandler();
    const result = await handler(functionUrlEvent('GET', '/api/v1/health'));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ data: { status: 'ok' }, league: null, warnings: [] });
    const openApi = await handler(functionUrlEvent('GET', '/api/v1/openapi.json'));
    expect(JSON.parse(openApi.body)).toMatchObject({ openapi: '3.1.0' });
  });

  it('refuses a direct Function URL call without the CloudFront origin header', async () => {
    const handler = await loadHandler();
    const direct = await handler(functionUrlEvent('GET', '/api/v1/health', { 'x-origin-verify': '' }));
    expect(direct.statusCode).toBe(403);
    expect(JSON.parse(direct.body)).toMatchObject({ error: { code: 'FORBIDDEN' } });
    const rotated = await handler(
      functionUrlEvent('GET', '/api/v1/health', { 'x-origin-verify': 'origin-previous' })
    );
    expect(rotated.statusCode).toBe(200);
  });

  it('routes EventBridge events to the league event handlers', async () => {
    const handler = await loadHandler();
    const result = await handler({
      id: 'e1',
      source: 'fantasy',
      'detail-type': 'League Created',
      detail: {}
    });
    expect(result).toEqual({ handled: false });
  });

  it('never accepts dev sign-in, even with FANTASY_LOCAL_AUTH=1', async () => {
    const handler = await loadHandler();
    const result = await handler(functionUrlEvent('GET', '/api/v1/me', { authorization: 'Bearer dev' }));
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body)).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('does not import the dev auth module', () => {
    const source = readFileSync(new URL('./lambda.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from '\.\/auth\/dev\.js'/);
    expect(source).not.toMatch(/local\.js/);
  });

  it('fails fast without its environment', async () => {
    const { createLambdaApp } = await import('./lambda.js');
    expect(() => createLambdaApp({})).toThrow(/TABLE_NAME/);
  });
});
