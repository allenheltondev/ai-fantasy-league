import type { Repos } from '../../src/repos/types.js';
import type { RequestOptions } from './harness.js';
import { BOB, CAROL, seedInvite, seedLeague, token } from './leagues.js';
import { signIdToken } from './tokens.js';

/**
 * Contract cases for the league operations, over leagues seeded with fixed ids. The harness's
 * default token is user-123 ("Allen"), the commissioner of every seeded league.
 */

const ALLEN = { sub: 'user-123', name: 'Allen' };
const DAN = { sub: 'dan', name: 'Dan' };
const ERIN = { sub: 'erin', name: 'Erin' };

export async function seedContractLeagues(repos: Repos): Promise<void> {
  await seedLeague(repos, { id: 'lg-c', owners: [ALLEN, BOB, DAN] });
  await seedLeague(repos, { id: 'lg-c2', owners: [ALLEN, ERIN] });
  await seedLeague(repos, { id: 'lg-c-del', owners: [ALLEN] });
  await seedInvite(repos, 'lg-c', token('contract-join'), { maxUses: 5 });
  await seedInvite(repos, 'lg-c', token('contract-view'));
  await seedInvite(repos, 'lg-c', token('contract-revoke'), { id: 'inv-contract-revoke' });
}

const outsider = signIdToken({ sub: 'outsider', name: 'Olive' });
const bob = signIdToken({ sub: BOB.sub, name: BOB.name, email: BOB.email });
const carol = signIdToken({ sub: CAROL.sub, name: CAROL.name, email: CAROL.email });
const key = (label: string) => `contract-${label}-0001`;

interface Case {
  label: string;
  path: string;
  init?: RequestOptions;
  status: number;
}

const L = '/api/v1/leagues';

export const LEAGUE_CASES: Record<string, Case[]> = {
  create_league: [
    {
      label: 'created',
      path: L,
      init: { body: { name: 'Contract League' }, token: outsider, idempotencyKey: key('create') },
      status: 200
    },
    {
      label: 'invalid',
      path: L,
      init: { body: { name: '' }, idempotencyKey: key('create-bad') },
      status: 400
    },
    {
      label: 'over quota',
      path: L,
      init: { body: { name: 'Fourth' }, idempotencyKey: key('create-quota') },
      status: 403
    }
  ],
  list_my_leagues: [
    { label: 'mine', path: L, status: 200 },
    { label: 'anonymous', path: L, init: { token: null }, status: 401 }
  ],
  get_league: [
    { label: 'member', path: `${L}/lg-c`, status: 200 },
    { label: 'outsider', path: `${L}/lg-c`, init: { token: outsider }, status: 403 },
    { label: 'missing', path: `${L}/nope`, status: 404 }
  ],
  get_league_state: [
    { label: 'member', path: `${L}/lg-c/state`, status: 200 },
    { label: 'outsider', path: `${L}/lg-c/state`, init: { token: outsider }, status: 403 }
  ],
  update_league_settings: [
    {
      label: 'changed',
      path: `${L}/lg-c/settings`,
      init: { body: { changes: { trades: { reviewPeriodDays: 1 } } }, idempotencyKey: key('settings') },
      status: 200
    },
    {
      label: 'invalid',
      path: `${L}/lg-c/settings`,
      init: { body: { changes: { playoffs: { teams: 12 } } }, idempotencyKey: key('settings-bad') },
      status: 400
    }
  ],
  create_invite: [
    {
      label: 'created',
      path: `${L}/lg-c/invites`,
      init: { body: { maxUses: 2 }, idempotencyKey: key('invite') },
      status: 200
    },
    {
      label: 'not commissioner',
      path: `${L}/lg-c/invites`,
      init: { body: {}, token: bob, idempotencyKey: key('invite-bob') },
      status: 403
    }
  ],
  list_invites: [
    { label: 'commissioner', path: `${L}/lg-c/invites`, status: 200 },
    { label: 'member', path: `${L}/lg-c/invites`, init: { token: bob }, status: 403 }
  ],
  revoke_invite: [
    {
      label: 'revoked',
      path: `${L}/lg-c/invites/inv-contract-revoke`,
      init: { idempotencyKey: key('revoke') },
      status: 200
    },
    {
      label: 'missing',
      path: `${L}/lg-c/invites/nope`,
      init: { idempotencyKey: key('revoke-bad') },
      status: 404
    }
  ],
  get_invite: [
    {
      label: 'preview',
      path: `/api/v1/invites/${token('contract-view')}`,
      init: { token: null },
      status: 200
    },
    {
      label: 'unknown',
      path: `/api/v1/invites/${token('contract-none')}`,
      init: { token: null },
      status: 404
    }
  ],
  join_league: [
    {
      label: 'joined',
      path: `/api/v1/invites/${token('contract-join')}/join`,
      init: { body: {}, token: carol, idempotencyKey: key('join') },
      status: 200
    },
    {
      label: 'already a member',
      path: `/api/v1/invites/${token('contract-join')}/join`,
      init: { body: {}, token: carol, idempotencyKey: key('join-again') },
      status: 409
    }
  ],
  leave_league: [
    {
      label: 'left',
      path: `${L}/lg-c/leave`,
      init: { body: {}, token: bob, idempotencyKey: key('leave') },
      status: 200
    },
    {
      label: 'commissioner',
      path: `${L}/lg-c/leave`,
      init: { body: {}, idempotencyKey: key('leave-comm') },
      status: 403
    }
  ],
  remove_member: [
    { label: 'removed', path: `${L}/lg-c/members/dan`, init: { idempotencyKey: key('remove') }, status: 200 },
    {
      label: 'not a member',
      path: `${L}/lg-c/members/nobody`,
      init: { idempotencyKey: key('remove-bad') },
      status: 404
    }
  ],
  transfer_commissioner: [
    {
      label: 'transferred',
      path: `${L}/lg-c2/commissioner`,
      init: { body: { userId: 'erin' }, idempotencyKey: key('transfer') },
      status: 200
    },
    {
      label: 'no seat',
      path: `${L}/lg-c/commissioner`,
      init: { body: { userId: 'nobody' }, idempotencyKey: key('transfer-bad') },
      status: 404
    }
  ],
  set_seat_type: [
    {
      label: 'human',
      path: `${L}/lg-c/teams/team-5/seat-type`,
      init: { body: { seatType: 'human' }, idempotencyKey: key('seat') },
      status: 200
    },
    {
      label: 'held seat',
      path: `${L}/lg-c/teams/team-1/seat-type`,
      init: { body: { seatType: 'agent' }, idempotencyKey: key('seat-bad') },
      status: 409
    }
  ],
  rename_team: [
    {
      label: 'renamed',
      path: `${L}/lg-c/teams/team-1/name`,
      init: { body: { name: 'Contract Kings' }, idempotencyKey: key('rename') },
      status: 200
    },
    {
      label: 'not yours',
      path: `${L}/lg-c/teams/team-1/name`,
      init: { body: { name: 'Mine' }, token: carol, idempotencyKey: key('rename-bad') },
      status: 403
    }
  ],
  delete_league: [
    { label: 'deleted', path: `${L}/lg-c-del`, init: { idempotencyKey: key('delete') }, status: 200 },
    {
      label: 'not commissioner',
      path: `${L}/lg-c`,
      init: { token: carol, idempotencyKey: key('delete-bad') },
      status: 403
    }
  ],
  get_standings: [
    { label: 'before the season', path: `${L}/lg-c/standings`, status: 200 },
    { label: 'outsider', path: `${L}/lg-c/standings`, init: { token: outsider }, status: 403 }
  ],
  get_matchup: [
    { label: 'no schedule yet', path: `${L}/lg-c/matchup`, status: 200 },
    { label: 'in season, with lineups', path: `${L}/lg-cs/matchup`, status: 200 },
    { label: 'week out of range', path: `${L}/lg-c/matchup?week=18`, status: 400 }
  ],
  get_playoff_bracket: [
    { label: 'before the season', path: `${L}/lg-c/playoffs`, status: 200 },
    { label: 'projected', path: `${L}/lg-cs/playoffs`, status: 200 },
    { label: 'outsider', path: `${L}/lg-c/playoffs`, init: { token: outsider }, status: 403 }
  ],
  get_league_history: [
    { label: 'in season', path: `${L}/lg-cs/history`, status: 200 },
    { label: 'outsider', path: `${L}/lg-c/history`, init: { token: outsider }, status: 403 }
  ]
};
