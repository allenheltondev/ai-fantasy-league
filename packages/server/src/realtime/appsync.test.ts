import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppSyncEventsRealtime,
  NodeSha256,
  sigV4Signer,
  type HttpPost,
  type RequestSigner
} from './appsync.js';

const endpoint = { httpHost: 'abc.appsync-api.us-east-1.amazonaws.com', realtimeHost: 'abc.realtime' };
const message = { type: 'chat' as const, leagueId: 'lg-1', message: { id: 'm1', text: 'hi' } };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function harness(response: { ok?: boolean; status?: number; body?: string } = {}) {
  const signed: Parameters<RequestSigner>[0][] = [];
  const posts: { url: string; init: Parameters<HttpPost>[1] }[] = [];
  const realtime = new AppSyncEventsRealtime({
    endpoint,
    sign: async (request) => {
      signed.push(request);
      return {
        ...request.headers,
        authorization: 'AWS4-HMAC-SHA256 signed',
        'x-amz-date': '20260910T120000Z'
      };
    },
    post: async (url, init) => {
      posts.push({ url, init });
      return {
        ok: response.ok ?? true,
        status: response.status ?? 200,
        text: async () => response.body ?? '{"successful":[{"identifier":"x","index":0}],"failed":[]}'
      };
    }
  });
  return { realtime, signed, posts };
}

describe('AppSyncEventsRealtime', () => {
  it('reports the endpoint browsers connect to', () => {
    expect(harness().realtime.endpoint()).toEqual(endpoint);
  });

  it('POSTs one signed JSON-string event to the channel on the HTTP endpoint', async () => {
    const { realtime, signed, posts } = harness();
    await realtime.publish('/fantasy/league/lg-1', message);
    const body = JSON.stringify({ channel: '/fantasy/league/lg-1', events: [JSON.stringify(message)] });
    expect(signed).toEqual([
      {
        hostname: endpoint.httpHost,
        path: '/event',
        headers: { 'content-type': 'application/json', host: endpoint.httpHost },
        body
      }
    ]);
    // The signed headers go out, less `host` (fetch derives it from the URL).
    expect(posts).toEqual([
      {
        url: `https://${endpoint.httpHost}/event`,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'AWS4-HMAC-SHA256 signed',
            'x-amz-date': '20260910T120000Z'
          },
          body
        }
      }
    ]);
  });

  it('throws on an HTTP error or a refused event, so the relay retries', async () => {
    await expect(
      harness({ ok: false, status: 403, body: 'denied' }).realtime.publish('/fantasy/global', message)
    ).rejects.toThrow(/publish to \/fantasy\/global failed: HTTP 403 denied/);
    await expect(
      harness({ body: '{"failed":[{"code":"Unauthorized"}]}' }).realtime.publish('/fantasy/global', message)
    ).rejects.toThrow(/refused the publish to \/fantasy\/global: \[\{"code":"Unauthorized"\}\]/);
    // A success body we cannot read is still a success.
    await expect(
      harness({ body: 'ok' }).realtime.publish('/fantasy/global', message)
    ).resolves.toBeUndefined();
    await expect(
      harness({ body: 'null' }).realtime.publish('/fantasy/global', message)
    ).resolves.toBeUndefined();
  });

  it('uses fetch by default', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"successful":[],"failed":[]}', { status: 200 }));
    await new AppSyncEventsRealtime({ endpoint, sign: async (r) => r.headers }).publish(
      '/fantasy/global',
      message
    );
    expect(fetch).toHaveBeenCalledWith(
      `https://${endpoint.httpHost}/event`,
      expect.objectContaining({ method: 'POST' })
    );
  });
});

describe('sigV4Signer', () => {
  const request = {
    hostname: endpoint.httpHost,
    path: '/event',
    headers: { 'content-type': 'application/json', host: endpoint.httpHost },
    body: '{"channel":"/fantasy/global","events":["{}"]}'
  };

  it('signs for the appsync service in the region, with the session token', async () => {
    let loads = 0;
    const sign = sigV4Signer({
      region: 'us-east-1',
      credentials: async () => {
        loads++;
        return { accessKeyId: 'AKID', secretAccessKey: 'secret', sessionToken: 'session' };
      },
      now: () => new Date('2026-09-10T12:00:00.000Z')
    });
    const headers = await sign(request);
    expect(headers).toMatchObject({
      'content-type': 'application/json',
      host: endpoint.httpHost,
      'x-amz-date': '20260910T120000Z',
      'x-amz-security-token': 'session'
    });
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/20260910\/us-east-1\/appsync\/aws4_request, SignedHeaders=content-type;host;[a-z0-9;-]*x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/
    );
    // Deterministic for the same request and time.
    expect((await sign(request)).authorization).toBe(headers.authorization);
    expect(loads).toBeGreaterThan(0);
  });

  it("signs with the Lambda role's credentials from the environment by default", async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDENV');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
    vi.stubEnv('AWS_SESSION_TOKEN', '');
    const headers = await sigV4Signer({ region: 'us-west-2' })(request);
    expect(headers.authorization).toMatch(/Credential=AKIDENV\/\d{8}\/us-west-2\/appsync\/aws4_request/);
  });
});

describe('NodeSha256', () => {
  const hex = async (hash: NodeSha256) => Buffer.from(await hash.digest()).toString('hex');

  it('hashes text and bytes alike, and HMACs with a secret', async () => {
    const expected = createHash('sha256').update('abc').digest('hex');
    const text = new NodeSha256();
    text.update('abc');
    expect(await hex(text)).toBe(expected);
    const buffer = new NodeSha256();
    buffer.update(new TextEncoder().encode('abc').buffer);
    expect(await hex(buffer)).toBe(expected);
    const view = new NodeSha256();
    view.update(new DataView(new TextEncoder().encode('xabc').buffer, 1));
    expect(await hex(view)).toBe(expected);
    const hmac = new NodeSha256(new TextEncoder().encode('key').buffer);
    hmac.update('abc');
    const hmacText = new NodeSha256('key');
    hmacText.update('abc');
    expect(await hex(hmac)).toBe(await hex(hmacText));
    expect(await hex(hmacText)).not.toBe(expected);
  });
});
