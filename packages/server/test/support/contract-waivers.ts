import type { Repos } from '../../src/repos/types.js';
import { START, type RequestOptions } from './harness.js';
import { BOB } from './leagues.js';
import { signIdToken } from './tokens.js';
import { seedSeasonLeague } from './waivers.js';

/**
 * Contract cases for the waiver operations, over an in-season league where the harness's default
 * user ("Allen", user-123) owns team-1 and is the commissioner. fx-lamb is on waivers; claim
 * `cw-claim` is Allen's pending claim on him.
 */

const ALLEN = { sub: 'user-123', name: 'Allen' };
const W = '/api/v1/leagues/lg-cw';
const bob = signIdToken({ sub: BOB.sub, name: BOB.name, email: BOB.email });
const outsider = signIdToken({ sub: 'outsider', name: 'Olive' });
const key = (label: string) => `contract-w-${label}-0001`;

export async function seedContractWaivers(repos: Repos): Promise<void> {
  await seedSeasonLeague(repos, {
    id: 'lg-cw',
    owners: [ALLEN, BOB],
    rosters: { 'team-1': ['fx-jallen'], 'team-2': ['fx-mahomes', 'fx-cmc', 'fx-bijan'] }
  });
  await repos.waivers.putWireEntry({
    leagueId: 'lg-cw',
    playerId: 'fx-kelce',
    droppedByTeamId: 'team-2',
    droppedAt: START,
    clearsAt: '2026-09-12T12:00:00.000Z'
  });
  await repos.waivers.putWireEntry({
    leagueId: 'lg-cw',
    playerId: 'fx-lamb',
    droppedByTeamId: 'team-2',
    droppedAt: START,
    clearsAt: '2026-09-12T12:00:00.000Z'
  });
  await repos.waivers.createClaim({
    id: 'cw-claim',
    leagueId: 'lg-cw',
    teamId: 'team-1',
    addPlayerId: 'fx-lamb',
    dropPlayerId: null,
    bid: 5,
    priority: 1,
    status: 'pending',
    week: 2,
    processesAt: '2026-09-13T08:00:00.000Z',
    createdAt: START,
    createdBy: 'user#user-123',
    resolvedAt: null,
    failure: null,
    cost: null,
    awardingRunId: null,
    version: 1
  });
}

interface Case {
  label: string;
  path: string;
  init?: RequestOptions;
  status: number;
}

export const WAIVER_CASES: Record<string, Case[]> = {
  preview_waiver_claim: [
    { label: 'free agent', path: `${W}/waivers/preview?playerId=fx-chase`, status: 200 },
    { label: 'blocked', path: `${W}/waivers/preview?playerId=fx-chase`, init: { token: bob }, status: 200 },
    { label: 'unknown player', path: `${W}/waivers/preview?playerId=nope`, status: 404 }
  ],
  list_waiver_claims: [
    { label: 'all teams', path: `${W}/waivers/claims?status=all`, status: 200 },
    { label: 'outsider', path: `${W}/waivers/claims`, init: { token: outsider }, status: 403 }
  ],
  reorder_waiver_claims: [
    {
      label: 'ordered',
      path: `${W}/waivers/claims/order`,
      init: { body: { claimIds: ['cw-claim'] }, idempotencyKey: key('order') },
      status: 200
    },
    {
      label: 'missing ids',
      path: `${W}/waivers/claims/order`,
      init: { body: { claimIds: ['nope'] }, idempotencyKey: key('order-bad') },
      status: 400
    }
  ],
  cancel_waiver_claim: [
    {
      label: 'cancelled',
      path: `${W}/waivers/claims/cw-claim`,
      init: { idempotencyKey: key('cancel') },
      status: 200
    },
    {
      label: 'not pending',
      path: `${W}/waivers/claims/cw-claim`,
      init: { idempotencyKey: key('cancel-again') },
      status: 409
    },
    {
      label: 'not yours',
      path: `${W}/waivers/claims/cw-claim`,
      init: { token: bob, idempotencyKey: key('cancel-bob') },
      status: 404
    }
  ],
  claim_waiver: [
    {
      label: 'roster full',
      path: `${W}/waivers/claims`,
      init: { body: { playerId: 'fx-lamb', bid: 3 }, token: bob, idempotencyKey: key('claim-bob') },
      status: 409
    },
    {
      label: 'queued claim',
      path: `${W}/waivers/claims`,
      init: { body: { playerId: 'fx-kelce', bid: 2 }, idempotencyKey: key('claim-queued') },
      status: 200
    },
    {
      label: 'added',
      path: `${W}/waivers/claims`,
      init: { body: { playerId: 'fx-chase', bid: 1 }, idempotencyKey: key('claim-add') },
      status: 200
    },
    {
      label: 'rostered player',
      path: `${W}/waivers/claims`,
      init: { body: { playerId: 'fx-cmc' }, idempotencyKey: key('claim-taken') },
      status: 409
    },
    {
      label: 'invalid bid',
      path: `${W}/waivers/claims`,
      init: { body: { playerId: 'fx-lamb', bid: -1 }, idempotencyKey: key('claim-bad') },
      status: 400
    }
  ],
  drop_player: [
    {
      label: 'dropped',
      path: `${W}/drops`,
      init: { body: { playerId: 'fx-bijan' }, token: bob, idempotencyKey: key('drop') },
      status: 200
    },
    {
      label: 'not on roster',
      path: `${W}/drops`,
      init: { body: { playerId: 'fx-bijan' }, token: bob, idempotencyKey: key('drop-again') },
      status: 409
    }
  ],
  list_transactions: [
    { label: 'log', path: `${W}/transactions?limit=5`, status: 200 },
    { label: 'detail', path: `${W}/transactions?detail=true`, status: 200 },
    { label: 'outsider', path: `${W}/transactions`, init: { token: outsider }, status: 403 }
  ],
  get_league_dashboard: [
    { label: 'before the draft', path: '/api/v1/leagues/lg-c/dashboard', status: 200 },
    { label: 'in season', path: '/api/v1/leagues/lg-cs/dashboard', status: 200 },
    { label: 'with moves', path: `${W}/dashboard?moves=2`, status: 200 },
    { label: 'too many moves', path: `${W}/dashboard?moves=0`, status: 400 },
    { label: 'outsider', path: `${W}/dashboard`, init: { token: outsider }, status: 403 }
  ]
};
