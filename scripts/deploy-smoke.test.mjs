// Run with: npm run test:scripts
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, describe, it } from 'node:test';
import { runSmoke } from './deploy-smoke.mjs';

const HTML = '<!doctype html><html><body><div id="root"></div></body></html>';

function makeServer(overrides = {}) {
  const routes = {
    '/auth-config.json': [200, 'application/json', '{"region":"us-east-1","clientId":"c"}'],
    '/api/v1/health': [200, 'application/json', '{"data":{"status":"ok"},"league":null,"warnings":[]}'],
    '/api/v1/openapi.json': [200, 'application/json', '{"openapi":"3.1.0","paths":{}}'],
    ...overrides
  };
  return createServer((req, res) => {
    const route = routes[req.url ?? '/'];
    const [status, type, body] = route ?? [200, 'text/html', HTML];
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function smoke(url) {
  const lines = [];
  const code = await runSmoke({ url, attempts: 2, retrySeconds: 0, log: (l) => lines.push(l) });
  return { code, output: lines.join('\n') };
}

describe('deploy-smoke', () => {
  const servers = [];
  const start = async (overrides) => {
    const server = makeServer(overrides);
    servers.push(server);
    return listen(server);
  };
  after(() => servers.forEach((s) => s.close()));

  it('passes against a healthy deployment', async () => {
    const { code, output } = await smoke(`${await start()}/`);
    assert.equal(code, 0, output);
    assert.match(output, /5 passed, 0 failed/);
  });

  it('fails when the API health is not the envelope', async () => {
    const url = await start({ '/api/v1/health': [200, 'application/json', '{"status":"ok"}'] });
    const { code, output } = await smoke(url);
    assert.equal(code, 1);
    assert.match(output, /FAIL {2}API health answers with the envelope/);
  });

  it('fails when CloudFront returns S3 403 for a deep link', async () => {
    const url = await start({ '/leagues/smoke/standings': [403, 'application/xml', '<Error/>'] });
    const { code, output } = await smoke(url);
    assert.equal(code, 1);
    assert.match(output, /not routing to index\.html/);
  });

  it('fails when the OpenAPI document is missing', async () => {
    const url = await start({ '/api/v1/openapi.json': [404, 'application/json', '{"error":{}}'] });
    const { code, output } = await smoke(url);
    assert.equal(code, 1);
    assert.match(output, /FAIL {2}OpenAPI document is served/);
  });

  it('fails without auth-config.json', async () => {
    const url = await start({ '/auth-config.json': [200, 'application/json', '{"region":"us-east-1"}'] });
    const { code, output } = await smoke(url);
    assert.equal(code, 1);
    assert.match(output, /missing clientId/);
  });

  it('reports an unreachable host', async () => {
    const { code, output } = await smoke('http://127.0.0.1:9');
    assert.equal(code, 1);
    assert.match(output, /unreachable/);
  });
});
