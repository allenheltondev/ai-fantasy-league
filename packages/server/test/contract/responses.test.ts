import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../../src/operations/index.js';
import { LEAGUE_CASES, seedContractLeagues } from '../support/contract-leagues.js';
import { createHarness, type Harness, type RequestOptions } from '../support/harness.js';
import { seedLeague } from '../support/leagues.js';
import { RESEARCH_LEAGUE_ID, seedReferenceData } from '../support/reference-seed.js';
import { signIdToken } from '../support/tokens.js';

const OTHER_USER = signIdToken({ sub: 'someone-else' });
const SEAT = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'zero_rb' };

/**
 * Contract tests: every operation's real responses (success and error) validate
 * against the committed OpenAPI document.
 */

type Json = Record<string, unknown>;
interface OpenApiDoc {
  paths: Record<string, Record<string, { operationId: string; responses: Record<string, Json> }>>;
  components: { schemas: Record<string, Json> };
}

const doc = JSON.parse(readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8')) as OpenApiDoc;
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema({ $id: 'openapi', components: doc.components });

interface Case {
  label: string;
  path: string;
  init?: RequestOptions;
  status: number;
}

/** Requests per operation. Every operation needs at least one success and one error case. */
const CASES: Record<string, Case[]> = {
  get_health: [
    { label: 'ok', path: '/api/v1/health', init: { token: null }, status: 200 },
    { label: 'bad token', path: '/api/v1/health', init: { token: 'x' }, status: 401 }
  ],
  get_me: [
    { label: 'user', path: '/api/v1/me', status: 200 },
    { label: 'anonymous', path: '/api/v1/me', init: { token: null }, status: 401 }
  ],
  search_players: [
    { label: 'compact', path: '/api/v1/players?q=brown', status: 200 },
    { label: 'detail', path: '/api/v1/players?position=K&detail=true', status: 200 },
    { label: 'empty', path: '/api/v1/players?q=zzzzzz', status: 200 },
    { label: 'invalid', path: '/api/v1/players?limit=99', status: 400 }
  ],
  get_player: [
    { label: 'by id', path: '/api/v1/players/lookup?playerId=fx-cmc', status: 200 },
    { label: 'detail', path: '/api/v1/players/lookup?player=cmc&detail=true', status: 200 },
    { label: 'ambiguous', path: '/api/v1/players/lookup?player=williams', status: 400 },
    { label: 'not found', path: '/api/v1/players/lookup?playerId=nope', status: 404 },
    { label: 'no selector', path: '/api/v1/players/lookup', status: 400 }
  ],
  get_projections: [
    { label: 'one player', path: '/api/v1/projections?player=cmc', status: 200 },
    { label: 'position, detail', path: '/api/v1/projections?position=WR&detail=true', status: 200 },
    {
      label: 'several ids, league scoring',
      path: `/api/v1/projections?playerIds=fx-chase&playerIds=fx-bijan&leagueId=${RESEARCH_LEAGUE_ID}`,
      status: 200
    },
    { label: 'no projections yet', path: '/api/v1/projections?season=2026&week=9', status: 200 },
    { label: 'unknown league', path: '/api/v1/projections?leagueId=nope', status: 404 },
    { label: 'invalid week', path: '/api/v1/projections?week=30', status: 400 }
  ],
  get_trending_players: [
    { label: 'adds', path: '/api/v1/players/trending', status: 200 },
    {
      label: 'week lookback by position',
      path: '/api/v1/players/trending?lookbackHours=100&position=RB',
      status: 200
    },
    { label: 'no drops yet', path: '/api/v1/players/trending?type=drop', status: 200 },
    { label: 'invalid limit', path: '/api/v1/players/trending?limit=500', status: 400 }
  ],
  get_news: [
    { label: 'league-wide', path: '/api/v1/news', status: 200 },
    { label: 'player, detail', path: '/api/v1/news?player=mccaffrey&detail=true', status: 200 },
    { label: 'team', path: '/api/v1/news?team=BUF', status: 200 },
    {
      label: 'since after until',
      path: '/api/v1/news?since=2026-09-10T00:00:00Z&until=2026-09-09T00:00:00Z',
      status: 400
    },
    { label: 'unknown player', path: '/api/v1/news?playerId=nope', status: 404 }
  ],
  ...LEAGUE_CASES,
  configure_agent_seat: [
    {
      label: 'commissioner',
      path: '/api/v1/leagues/lg-1/agents/team-2',
      init: {
        body: { ...SEAT, advanced: { customFlavor: 'Loves kickers.' } },
        idempotencyKey: 'contract-cfg-1'
      },
      status: 200
    },
    {
      label: 'not commissioner',
      path: '/api/v1/leagues/lg-1/agents/team-2',
      init: { body: SEAT, idempotencyKey: 'contract-cfg-2', token: OTHER_USER },
      status: 403
    },
    {
      label: 'stale version',
      path: '/api/v1/leagues/lg-1/agents/team-2',
      init: { body: { ...SEAT, expectedVersion: 0 }, idempotencyKey: 'contract-cfg-3' },
      status: 409
    }
  ],
  randomize_agent_seats: [
    {
      label: 'seeded',
      path: '/api/v1/leagues/lg-1/agents/randomize',
      init: { body: { teamIds: ['team-3', 'team-4'], seed: 'contract' }, idempotencyKey: 'contract-rnd-1' },
      status: 200
    },
    {
      label: 'duplicates',
      path: '/api/v1/leagues/lg-1/agents/randomize',
      init: { body: { teamIds: ['team-2', 'team-2'] }, idempotencyKey: 'contract-rnd-2' },
      status: 400
    }
  ],
  get_agent_seat: [
    { label: 'commissioner', path: '/api/v1/leagues/lg-1/agents/team-2', status: 200 },
    {
      label: 'not a member',
      path: '/api/v1/leagues/lg-1/agents/team-2',
      init: { token: OTHER_USER },
      status: 403
    },
    { label: 'no seat', path: '/api/v1/leagues/lg-1/agents/team-9', status: 404 }
  ],
  get_agent_activity: [
    { label: 'commissioner', path: '/api/v1/leagues/lg-1/agent-activity?limit=5', status: 200 },
    {
      label: 'not commissioner',
      path: '/api/v1/leagues/lg-1/agent-activity',
      init: { token: OTHER_USER },
      status: 403
    }
  ]
};

function findOperation(name: string): { path: string; method: string; responses: Record<string, Json> } {
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op.operationId === name) return { path, method, responses: op.responses };
    }
  }
  throw new Error(`operation ${name} is not in openapi.json`);
}

/** Rewrites `#/components/...` refs to the registered `openapi` schema. */
function resolveRefs(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(resolveRefs);
  if (schema !== null && typeof schema === 'object') {
    return Object.fromEntries(
      Object.entries(schema).map(([k, v]) => [
        k,
        k === '$ref' && typeof v === 'string' && v.startsWith('#/components/')
          ? `openapi${v}`
          : resolveRefs(v)
      ])
    );
  }
  return schema;
}

function responseSchema(responses: Record<string, Json>, status: number): unknown {
  const entry = responses[String(status)] ?? responses[`${String(status)[0]}XX`];
  if (entry === undefined) throw new Error(`no response documented for ${status}`);
  if (typeof entry.$ref === 'string') {
    return { $ref: `openapi${String(entry.$ref).replace('/responses/Error', '/schemas/ErrorEnvelope')}` };
  }
  const content = entry.content as { 'application/json': { schema: unknown } };
  return resolveRefs(content['application/json'].schema);
}

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo' });
  await seedReferenceData(h.services, h.repos);
  await seedContractLeagues(h.repos);
  await seedLeague(h.repos, { id: 'lg-1', owners: [{ sub: 'user-123', name: 'Allen' }], teamCount: 4 });
});
afterAll(() => h.close());

describe('response contract', () => {
  it('has success and error cases for every operation', () => {
    for (const op of registry.operations) {
      const cases = CASES[op.name] ?? [];
      expect(
        cases.some((c) => c.status < 300),
        `${op.name} success case`
      ).toBe(true);
      expect(
        cases.some((c) => c.status >= 400),
        `${op.name} error case`
      ).toBe(true);
    }
  });

  it('rejects bodies that break the documented shape', () => {
    const health = findOperation('get_health');
    const validate = ajv.compile(responseSchema(health.responses, 200) as Json);
    expect(validate({ data: { status: 'ok' }, league: null, warnings: [] })).toBe(false);
    expect(
      validate({ data: { status: 'ok', version: '1', time: 't', extra: 1 }, league: null, warnings: [] })
    ).toBe(false);
    const error = ajv.compile(responseSchema(health.responses, 404) as Json);
    expect(error({ error: { code: 'NOT_A_CODE', message: 'm', fix: 'f' } })).toBe(false);
    expect(error({ error: { code: 'NOT_FOUND', message: 'm' } })).toBe(false);
  });

  for (const [name, cases] of Object.entries(CASES)) {
    describe(name, () => {
      for (const testCase of cases) {
        it(`${testCase.label} (${testCase.status}) matches the documented schema`, async () => {
          const op = findOperation(name);
          const res = await h.request(testCase.path, { method: op.method.toUpperCase(), ...testCase.init });
          expect(res.status).toBe(testCase.status);
          const validate = ajv.compile(responseSchema(op.responses, res.status) as Json);
          const valid = validate(res.body);
          expect(validate.errors ?? [], JSON.stringify(res.body)).toEqual([]);
          expect(valid).toBe(true);
        });
      }
    });
  }
});
