import type { Repos } from '../../src/repos/types.js';
import type { RequestOptions } from './harness.js';
import { BOB } from './leagues.js';
import { signIdToken } from './tokens.js';
import { seedTrade } from './trades.js';
import { seedSeasonLeague } from './waivers.js';

/**
 * Contract cases for the trade operations, over an in-season league where the harness's default
 * user ("Allen", user-123) owns team-1 and is the commissioner, and Bob owns team-2. Seeded trades:
 * ct-counter, ct-reject, and ct-withdraw are Bob's open offers to Allen; ct-review is an accepted
 * trade between team-2 and team-3 under league review.
 */

const ALLEN = { sub: 'user-123', name: 'Allen' };
const T = '/api/v1/leagues/lg-ct';
const bob = signIdToken({ sub: BOB.sub, name: BOB.name, email: BOB.email });
const outsider = signIdToken({ sub: 'outsider', name: 'Olive' });
const key = (label: string) => `contract-t-${label}-0001`;

export async function seedContractTrades(repos: Repos): Promise<void> {
  await seedSeasonLeague(repos, {
    id: 'lg-ct',
    owners: [ALLEN, BOB],
    rosters: {
      'team-1': ['fx-jallen', 'fx-cmc'],
      'team-2': ['fx-mahomes', 'fx-bijan'],
      'team-3': ['fx-hurts', 'fx-lamb']
    }
  });
  const offer = {
    leagueId: 'lg-ct',
    from: 'team-2',
    to: 'team-1',
    fromSends: ['fx-bijan'],
    toSends: ['fx-cmc']
  };
  for (const id of ['ct-counter', 'ct-reject', 'ct-withdraw']) await seedTrade(repos, { ...offer, id });
  await seedTrade(repos, {
    leagueId: 'lg-ct',
    id: 'ct-review',
    from: 'team-2',
    to: 'team-3',
    fromSends: ['fx-mahomes'],
    toSends: ['fx-hurts'],
    status: 'in_review',
    reviewEndsAt: '2026-09-12T12:00:00.000Z'
  });
}

interface Case {
  label: string;
  path: string;
  init?: RequestOptions;
  status: number;
}

const post = (label: string, body: Record<string, unknown>, extra: RequestOptions = {}): RequestOptions => ({
  body,
  idempotencyKey: key(label),
  ...extra
});

export const TRADE_CASES: Record<string, Case[]> = {
  preview_trade: [
    {
      label: 'new offer',
      path: `${T}/trades/preview?withTeamId=team-2&send=fx-cmc&receive=fx-bijan`,
      status: 200
    },
    { label: 'existing offer', path: `${T}/trades/preview?tradeId=ct-counter`, status: 200 },
    { label: 'nothing to preview', path: `${T}/trades/preview`, status: 400 }
  ],
  list_trades: [
    { label: 'mine and under review', path: `${T}/trades`, status: 200 },
    { label: 'outsider', path: `${T}/trades`, init: { token: outsider }, status: 403 }
  ],
  propose_trade: [
    {
      label: 'proposed',
      path: `${T}/trades`,
      init: post('propose', { withTeamId: 'team-3', send: ['fx-jallen'], receive: ['fx-lamb'] }),
      status: 200
    },
    {
      label: 'not on roster',
      path: `${T}/trades`,
      init: post('propose-bad', { withTeamId: 'team-3', send: ['fx-hurts'] }),
      status: 409
    }
  ],
  counter_trade: [
    {
      label: 'countered',
      path: `${T}/trades/ct-counter/counter`,
      init: post('counter', { send: ['fx-jallen'], receive: ['fx-bijan'] }),
      status: 200
    },
    {
      label: 'already countered',
      path: `${T}/trades/ct-counter/counter`,
      init: post('counter-again', { send: ['fx-jallen'], receive: ['fx-bijan'] }),
      status: 409
    }
  ],
  respond_to_trade: [
    {
      label: 'rejected',
      path: `${T}/trades/ct-reject/respond`,
      init: post('reject', { response: 'reject' }),
      status: 200
    },
    {
      label: 'not your offer to answer',
      path: `${T}/trades/ct-withdraw/respond`,
      init: post('respond-bob', { response: 'accept' }, { token: bob }),
      status: 403
    }
  ],
  withdraw_trade: [
    {
      label: 'withdrawn',
      path: `${T}/trades/ct-withdraw/withdraw`,
      init: post('withdraw', {}, { token: bob }),
      status: 200
    },
    {
      label: 'unknown trade',
      path: `${T}/trades/nope/withdraw`,
      init: post('withdraw-nope', {}),
      status: 404
    }
  ],
  vote_trade: [
    {
      label: 'veto vote',
      path: `${T}/trades/ct-review/votes`,
      init: post('vote', { decision: 'veto' }),
      status: 200
    },
    { label: 'voted already', path: `${T}/trades/ct-review/votes`, init: post('vote-again', {}), status: 409 }
  ]
};
