import type { Repos } from '../../src/repos/types.js';
import type { RequestOptions } from './harness.js';
import { seedLeague } from './leagues.js';
import { signIdToken } from './tokens.js';

/**
 * Contract cases for the draft operations. They run in order over `lg-draft-c`, a 4-team league in
 * setup whose commissioner (the harness's default token, "Allen") holds seat 1.
 */

export async function seedDraftContractLeague(repos: Repos): Promise<void> {
  await seedLeague(repos, { id: 'lg-draft-c', owners: [{ sub: 'user-123', name: 'Allen' }], teamCount: 4 });
}

const outsider = signIdToken({ sub: 'outsider', name: 'Olive' });
const key = (label: string) => `contract-draft-${label}-0001`;
const D = '/api/v1/leagues/lg-draft-c/draft';

interface Case {
  label: string;
  path: string;
  init?: RequestOptions;
  status: number;
}

export const DRAFT_CASES: Record<string, Case[]> = {
  start_draft: [
    {
      label: 'outsider',
      path: `${D}/start`,
      init: { token: outsider, idempotencyKey: key('start-out') },
      status: 403
    },
    { label: 'started', path: `${D}/start`, init: { body: {}, idempotencyKey: key('start') }, status: 200 },
    {
      label: 'already started',
      path: `${D}/start`,
      init: { body: {}, idempotencyKey: key('start-2') },
      status: 409
    }
  ],
  get_draft_board: [
    { label: 'on the clock', path: `${D}?position=RB&limit=5`, status: 200 },
    { label: 'not started', path: '/api/v1/leagues/lg-c/draft', status: 409 },
    { label: 'outsider', path: D, init: { token: outsider }, status: 403 },
    { label: 'sorted by last season', path: `${D}?sort=lastSeasonPoints&limit=5`, status: 200 },
    { label: 'unknown sort', path: `${D}?sort=adp`, status: 400 }
  ],
  get_draft_depth: [
    { label: 'depth', path: `${D}/depth`, status: 200 },
    { label: 'not started', path: '/api/v1/leagues/lg-c/draft/depth', status: 409 },
    { label: 'outsider', path: `${D}/depth`, init: { token: outsider }, status: 403 }
  ],
  make_draft_pick: [
    {
      label: 'picked',
      path: `${D}/picks`,
      init: { body: { player: 'chase', pick: 1 }, idempotencyKey: key('pick') },
      status: 200
    },
    {
      label: 'not your turn',
      path: `${D}/picks`,
      init: { body: { playerId: 'fx-cmc' }, idempotencyKey: key('pick-2') },
      status: 409
    },
    {
      label: 'ambiguous',
      path: `${D}/picks`,
      init: { body: { player: 'williams' }, idempotencyKey: key('pick-3') },
      status: 400
    }
  ],
  pause_draft: [
    { label: 'paused', path: `${D}/pause`, init: { idempotencyKey: key('pause') }, status: 200 },
    {
      label: 'outsider',
      path: `${D}/pause`,
      init: { token: outsider, idempotencyKey: key('pause-out') },
      status: 403
    }
  ],
  resume_draft: [
    { label: 'resumed', path: `${D}/resume`, init: { idempotencyKey: key('resume') }, status: 200 },
    { label: 'not paused', path: `${D}/resume`, init: { idempotencyKey: key('resume-2') }, status: 409 }
  ]
};
