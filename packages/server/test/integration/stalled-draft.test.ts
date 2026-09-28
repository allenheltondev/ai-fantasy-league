import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { advanceSeason, STALLED_DRAFT_AFTER_MS } from '../../src/jobs/season.js';
import { registry } from '../../src/operations/index.js';
import { fixtureDraftPool } from '../../src/players/fixtures.js';
import { createHarness, type Harness } from '../support/harness.js';
import { as } from '../support/league-client.js';
import { ALICE, BOB, seedLeague } from '../support/leagues.js';

/**
 * A live draft whose pick clock ran out with no pick (the deadline's autopick found no legal player,
 * or its timer was lost) is picked up by the weekly cycle: it runs the deadline again.
 */
const L = 'stalled-draft';
let h: Harness;

const jobDeps = () => ({
  repos: h.repos,
  reference: h.services.data.reference,
  events: h.events,
  log: h.services.log
});

beforeAll(async () => {
  h = await createHarness({ registry, players: fixtureDraftPool });
  await seedLeague(h.repos, { id: L, owners: [ALICE, BOB] });
  expect((await as(h, ALICE).post(`/leagues/${L}/draft/start`, {})).status).toBe(200);
});
afterAll(() => h.close());

describe('a stalled draft', () => {
  it('is left alone until its pick is overdue by more than the grace period', async () => {
    const draft = await h.repos.drafts.get(L);
    h.clock.set(new Date(Date.parse(draft?.deadline ?? '') + STALLED_DRAFT_AFTER_MS - 1000));
    expect(await advanceSeason(jobDeps(), h.clock)).toMatchObject({ status: 'skipped' });
    expect((await h.repos.drafts.get(L))?.state.picks).toHaveLength(0);
  });

  it('gets its overdue pick autopicked by the weekly cycle, and the clock moves on', async () => {
    const draft = await h.repos.drafts.get(L);
    h.clock.set(new Date(Date.parse(draft?.deadline ?? '') + STALLED_DRAFT_AFTER_MS + 1000));
    expect(await advanceSeason(jobDeps(), h.clock)).toMatchObject({
      stalledDrafts: 1,
      draft_autopicked: 1,
      failed: 0
    });
    const after = await h.repos.drafts.get(L);
    expect(after?.state.picks).toHaveLength(1);
    expect(after?.state.picks[0]).toMatchObject({ overall: 1, auto: true });
    expect(Date.parse(after?.deadline ?? '')).toBeGreaterThan(h.clock.now().getTime());
  });

  it('leaves a paused draft alone', async () => {
    expect((await as(h, ALICE).post(`/leagues/${L}/draft/pause`, {})).status).toBe(200);
    h.clock.advance(60 * 60_000);
    expect(await advanceSeason(jobDeps(), h.clock)).toMatchObject({ status: 'skipped' });
  });
});
