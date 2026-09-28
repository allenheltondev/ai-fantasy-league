#!/usr/bin/env node
/**
 * Post-deploy smoke test: does the deployed stack actually serve a request?
 *
 * Needs **no AWS credentials** and spends nothing: every check is an anonymous
 * GET against the public front door (CloudFront). That is what makes it safe
 * to run after every deploy, in a job that holds no cloud permissions.
 *
 * What it proves:
 *   - the SPA is served at / (200, HTML), and a deep link resolves to it, so
 *     CloudFront's router function works rather than returning S3's 403;
 *   - the API answers GET /api/v1/health with 200 and the JSON envelope, so
 *     CloudFront reaches the Lambda Function URL and the handler boots;
 *   - GET /api/v1/openapi.json returns an OpenAPI document;
 *   - with --function-url (the stack's ApiFunctionUrl output), a direct call to
 *     the Lambda Function URL, around CloudFront, is refused with 403 (#104).
 *     Skipped, not failed, when the URL is not given.
 *
 * What it does not prove: anything needing a signed-in user.
 *
 * Usage:
 *   node scripts/deploy-smoke.mjs --url https://fantasy.readysetcloud.io
 *   node scripts/deploy-smoke.mjs --url https://d111.cloudfront.net --attempts 3 --retry-seconds 5
 *   node scripts/deploy-smoke.mjs --url https://d111.cloudfront.net --function-url https://abc.lambda-url.us-east-1.on.aws/
 *
 * Exits 0 only when every check passes. Node 22, no dependencies.
 */

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const API_PREFIX = '/api/v1';
const DEFAULT_ATTEMPTS = 10;
const DEFAULT_RETRY_SECONDS = 15;
const REQUEST_TIMEOUT_MS = 30_000;

/** An HTTP error status is a response here; only "no response at all" throws. */
export async function fetchText(url, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'fantasy-deploy-smoke' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`unreachable: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: await response.text()
  };
}

function snippet(text) {
  return JSON.stringify(text.slice(0, 200));
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Each check resolves to null on success or a failure reason. */
export const checks = {
  async spaRoot(base, fetchImpl) {
    const res = await fetchText(`${base}/`, fetchImpl);
    if (res.status !== 200) return `expected 200, got ${res.status}: ${snippet(res.body)}`;
    if (!res.contentType.includes('html'))
      return `200 but content-type was ${JSON.stringify(res.contentType)}`;
    if (!res.body.includes('id="root"')) return 'HTML without the SPA root element';
    return null;
  },

  async spaDeepLink(base, fetchImpl) {
    const res = await fetchText(`${base}/leagues/smoke/standings`, fetchImpl);
    if (res.status !== 200) {
      return `expected 200, got ${res.status}. A 403/404 means CloudFront is not routing to index.html`;
    }
    if (!res.contentType.includes('html'))
      return `200 but content-type was ${JSON.stringify(res.contentType)}`;
    return null;
  },

  async authConfig(base, fetchImpl) {
    const res = await fetchText(`${base}/auth-config.json`, fetchImpl);
    if (res.status !== 200) return `expected 200, got ${res.status}`;
    const parsed = parseJson(res.body);
    if (!parsed.ok) return `not JSON: ${snippet(res.body)}`;
    for (const key of ['region', 'clientId']) {
      if (typeof parsed.value?.[key] !== 'string' || parsed.value[key] === '') return `missing ${key}`;
    }
    return null;
  },

  async health(base, fetchImpl) {
    const res = await fetchText(`${base}${API_PREFIX}/health`, fetchImpl);
    if (res.status !== 200) return `expected 200, got ${res.status}: ${snippet(res.body)}`;
    if (!res.contentType.includes('json'))
      return `200 but content-type was ${JSON.stringify(res.contentType)}`;
    const parsed = parseJson(res.body);
    if (!parsed.ok) return `200 but not JSON: ${snippet(res.body)}`;
    const value = parsed.value;
    if (typeof value !== 'object' || value === null || !('data' in value)) {
      return `200 but not the { data, ... } envelope: ${snippet(res.body)}`;
    }
    return null;
  },

  async openapi(base, fetchImpl) {
    const res = await fetchText(`${base}${API_PREFIX}/openapi.json`, fetchImpl);
    if (res.status !== 200) return `expected 200, got ${res.status}: ${snippet(res.body)}`;
    const parsed = parseJson(res.body);
    if (!parsed.ok) return `200 but not JSON: ${snippet(res.body)}`;
    const doc = parsed.value;
    if (typeof doc?.openapi !== 'string' || typeof doc?.paths !== 'object' || doc.paths === null) {
      return 'not an OpenAPI document (needs `openapi` and `paths`)';
    }
    return null;
  },

  /** `base` here is the Function URL: without CloudFront's origin header it must refuse. */
  async functionUrlRefused(base, fetchImpl) {
    const res = await fetchText(`${base}${API_PREFIX}/health`, fetchImpl);
    if (res.status === 403) return null;
    return `expected 403 for a call around CloudFront, got ${res.status}: ${snippet(res.body)}`;
  }
};

const PLAN = [
  // First, and retried: a fresh distribution can 404 while it propagates.
  { name: 'SPA is served at /', run: checks.spaRoot, retry: true },
  { name: 'SPA deep link resolves', run: checks.spaDeepLink },
  { name: 'auth-config.json is published', run: checks.authConfig },
  // Retried too: the Lambda may be cold, and CloudFront may still be wiring /api/*.
  { name: 'API health answers with the envelope', run: checks.health, retry: true },
  { name: 'OpenAPI document is served', run: checks.openapi },
  // Against the Function URL, not the app URL. Retried: CloudFormation may still be rolling the Lambda.
  {
    name: 'Direct Function URL call is refused',
    run: checks.functionUrlRefused,
    target: 'functionUrl',
    retry: true
  }
];

export async function runSmoke({
  url,
  functionUrl = '',
  attempts = DEFAULT_ATTEMPTS,
  retrySeconds = DEFAULT_RETRY_SECONDS,
  fetchImpl = fetch,
  log = console.log,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  const base = url.replace(/\/+$/, '');
  const bases = { url: base, functionUrl: functionUrl.replace(/\/+$/, '') };
  const failed = [];
  let passed = 0;
  let skipped = 0;
  log(`Smoking ${base}\n`);

  for (const step of PLAN) {
    const target = bases[step.target ?? 'url'];
    if (target === '') {
      skipped++;
      log(`SKIP  ${step.name} (no --function-url; the ApiFunctionUrl stack output was not available)`);
      continue;
    }
    const tries = step.retry ? attempts : 1;
    let reason = null;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        reason = await step.run(target, fetchImpl);
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
      if (reason === null) break;
      if (attempt < tries) {
        log(`  ... ${step.name}: ${reason} -- retrying in ${retrySeconds}s`);
        await sleep(retrySeconds * 1000);
      }
    }
    if (reason === null) {
      passed++;
      log(`PASS  ${step.name}`);
    } else {
      failed.push(step.name);
      log(`FAIL  ${step.name}\n      ${reason}`);
    }
  }

  log(`\n${passed} passed, ${failed.length} failed${skipped ? ` (${skipped} skipped)` : ''}`);
  if (failed.length) log(`Failed: ${failed.join(', ')}`);
  return failed.length === 0 ? 0 : 1;
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      'function-url': { type: 'string', default: '' },
      attempts: { type: 'string', default: String(DEFAULT_ATTEMPTS) },
      'retry-seconds': { type: 'string', default: String(DEFAULT_RETRY_SECONDS) }
    }
  });
  const url = values.url ?? '';
  if (!/^https?:\/\//.test(url)) {
    console.error(`deploy-smoke: --url must be absolute, got ${JSON.stringify(url)}`);
    return 2;
  }
  const functionUrl = values['function-url'].trim();
  if (functionUrl !== '' && !/^https?:\/\//.test(functionUrl)) {
    console.error(`deploy-smoke: --function-url must be absolute, got ${JSON.stringify(functionUrl)}`);
    return 2;
  }
  return runSmoke({
    url,
    functionUrl,
    attempts: Math.max(1, Number.parseInt(values.attempts, 10) || DEFAULT_ATTEMPTS),
    retrySeconds: Math.max(0, Number(values['retry-seconds']) || 0)
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
