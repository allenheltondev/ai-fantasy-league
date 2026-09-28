import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentPrincipal } from '../../src/auth/principal.js';
import { processWaivers } from '../../src/jobs/process-waivers.js';
import { silentLogger } from '../../src/log.js';
import { registry } from '../../src/operations/index.js';
import { invokeTool } from '../../src/registry/invoke.js';
import { createHarness, type Harness } from '../support/harness.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE, BOB, CAROL } from '../support/leagues.js';
import { seedSeasonLeague } from '../support/waivers.js';

/**
 * Waivers and free agency end to end over the REST adapter and DynamoDB Local: free-agent adds, drops onto
 * waivers, FAAB claims from a person and an agent, the processing job (idempotent per window), and
 * the transactions log.
 */

const L = '/leagues/lg-w';
let h: Harness;
let alice: Caller;
let bob: Caller;
let carol: Caller;

const agent = agentPrincipal({ agentId: 'agent-3', teamId: 'team-3', leagueId: 'lg-w' });
const asAgent = (name: string, args: Record<string, unknown>) =>
  invokeTool({ registry, services: h.services, principal: agent, name, args: { leagueId: 'lg-w', ...args } });
const job = () =>
  processWaivers(
    { repos: h.repos, reference: h.services.data.reference, events: h.events, log: silentLogger },
    h.clock
  );
const eventsOf = (type: string) => h.events.events.filter((e) => e.detailType === type);

beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo', registry });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  carol = as(h, CAROL);
  await seedSeasonLeague(h.repos, {
    id: 'lg-w',
    owners: [ALICE, BOB, null, null],
    rosters: { 'team-1': ['fx-jallen', 'fx-cmc'], 'team-2': ['fx-mahomes'], 'team-3': ['fx-hurts'] }
  });
  await seedSeasonLeague(h.repos, {
    id: 'lg-w-setup',
    owners: [ALICE],
    rosters: {},
    overrides: { phase: 'setup' }
  });
});
afterAll(() => h.close());

describe('free agency', () => {
  it('previews an add, then adds a free agent immediately at no cost', async () => {
    const preview = data(await alice.get(`${L}/waivers/preview?playerId=fx-bijan&bid=5`));
    expect(preview).toMatchObject({
      wouldSucceed: true,
      outcome: 'add_now',
      issues: [],
      faabRemaining: 100,
      faabAfter: 100
    });
    expect((preview.resultingRoster as { id: string }[]).map((p) => p.id)).toEqual([
      'fx-jallen',
      'fx-cmc',
      'fx-bijan'
    ]);

    const res = await alice.post(`${L}/waivers/claims`, { player: 'bijan', bid: 5 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(data(res)).toMatchObject({
      outcome: 'added',
      player: { id: 'fx-bijan' },
      claim: null,
      faabRemaining: 100
    });
    expect((res.body as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toEqual([
      'FAAB_NOT_CHARGED'
    ]);
    expect((await h.repos.teams.get('lg-w', 'team-1'))?.roster).toEqual(['fx-jallen', 'fx-cmc', 'fx-bijan']);
  });

  it('refuses a full roster with the players to drop, and rostered players', async () => {
    const full = await alice.post(`${L}/waivers/claims`, { playerId: 'fx-chase' });
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({
      error: { code: 'ROSTER_FULL', fix: expect.stringContaining('fx-bijan (Bijan Robinson, RB)') }
    });
    expect(
      (full.body as { error: { details: { droppable: unknown[] } } }).error.details.droppable
    ).toHaveLength(3);
    const preview = data(await alice.get(`${L}/waivers/preview?playerId=fx-chase`));
    expect(preview).toMatchObject({
      wouldSucceed: false,
      outcome: 'blocked',
      issues: [{ code: 'ROSTER_FULL' }]
    });

    expect(errorCode(await bob.post(`${L}/waivers/claims`, { playerId: 'fx-cmc' }))).toBe(
      'PLAYER_NOT_AVAILABLE'
    );
    expect(
      errorCode(await bob.post(`${L}/waivers/claims`, { playerId: 'fx-lamb', dropPlayerId: 'fx-cmc' }))
    ).toBe('DROP_PLAYER_NOT_ON_ROSTER');
    expect(errorCode(await carol.post(`${L}/waivers/claims`, { playerId: 'fx-lamb' }))).toBe('FORBIDDEN');
    expect(errorCode(await alice.post('/leagues/lg-w-setup/waivers/claims', { playerId: 'fx-lamb' }))).toBe(
      'PHASE_NOT_ALLOWED'
    );
  });

  it('adds with a drop in one move; the dropped player goes on waivers', async () => {
    h.clock.set('2026-09-10T12:01:00.000Z');
    const res = await alice.post(`${L}/waivers/claims`, { playerId: 'fx-chase', dropPlayerId: 'fx-bijan' });
    expect(data(res)).toMatchObject({ outcome: 'added', dropped: { id: 'fx-bijan' } });
    const search = data<{ players: { id: string; availability: { status: string; clearsAt?: string } }[] }>(
      await alice.get(`/players?q=bijan&leagueId=lg-w`)
    );
    expect(search.players[0]).toMatchObject({
      id: 'fx-bijan',
      // Two days, rounded up to the waiver run that processes claims on him.
      availability: { status: 'waivers', clearsAt: '2026-09-13T08:00:00.000Z' }
    });
  });
});

describe('waiver claims', () => {
  it('drop_player puts the player on waivers for the waiver period', async () => {
    h.clock.set('2026-09-10T12:02:00.000Z');
    const res = await alice.post(`${L}/drops`, { playerId: 'fx-cmc' });
    expect(data(res)).toMatchObject({
      dropped: { id: 'fx-cmc' },
      clearsAt: '2026-09-13T08:00:00.000Z',
      rosterSize: 2
    });
    expect(errorCode(await alice.post(`${L}/drops`, { playerId: 'fx-cmc' }))).toBe('PLAYER_NOT_ON_ROSTER');
  });

  it('queues claims on a player on waivers, from a person and an agent', async () => {
    const tooMuch = data(await bob.get(`${L}/waivers/preview?playerId=fx-cmc&bid=200`));
    expect(tooMuch).toMatchObject({ wouldSucceed: false, issues: [{ code: 'INSUFFICIENT_FAAB' }] });
    expect(errorCode(await bob.post(`${L}/waivers/claims`, { playerId: 'fx-cmc', bid: 200 }))).toBe(
      'INSUFFICIENT_FAAB'
    );

    const res = await bob.post(`${L}/waivers/claims`, { playerId: 'fx-cmc', bid: 30 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(data(res)).toMatchObject({
      outcome: 'claim_pending',
      claim: {
        teamId: 'team-2',
        bid: 30,
        priority: 1,
        status: 'pending',
        processesAt: '2026-09-13T08:00:00.000Z'
      }
    });
    expect((res.body as { warnings: { code: string }[] }).warnings[0]?.code).toBe('WAIVER_CLAIM_QUEUED');
    expect(errorCode(await bob.post(`${L}/waivers/claims`, { playerId: 'fx-cmc', bid: 31 }))).toBe(
      'DUPLICATE_WAIVER_CLAIM'
    );

    const agentClaim = await asAgent('claim_waiver', {
      playerId: 'fx-cmc',
      bid: 30,
      idempotencyKey: 'agent-claim-1'
    });
    expect(agentClaim.status).toBe(200);
    const bijan = await asAgent('claim_waiver', {
      playerId: 'fx-bijan',
      bid: 10,
      idempotencyKey: 'agent-claim-2'
    });
    expect(bijan.status).toBe(200);
  });

  it('keeps bids sealed: each team sees only its own pending claims, even the commissioner', async () => {
    const mine = data<{ claims: { teamId: string }[] }>(await bob.get(`${L}/waivers/claims`));
    expect(mine.claims.map((c) => c.teamId)).toEqual(['team-2']);
    const commissioner = data<{ claims: unknown[] }>(await alice.get(`${L}/waivers/claims?status=all`));
    expect(commissioner.claims).toEqual([]);
    const agents = (await asAgent('list_waiver_claims', {})).body as {
      data: { claims: { teamId: string }[] };
    };
    expect(agents.data.claims.map((c) => c.teamId)).toEqual(['team-3', 'team-3']);
    expect(data<{ claims: unknown[] }>(await bob.get(`${L}/waivers/claims?teamId=team-3`)).claims).toEqual(
      []
    );
    expect(errorCode(await carol.get(`${L}/waivers/claims`))).toBe('FORBIDDEN');
  });

  it('reorders and cancels claims', async () => {
    const listed = await asAgent('list_waiver_claims', {});
    const claims = (listed.body as { data: { claims: { id: string; player: { id: string } }[] } }).data
      .claims;
    const [cmc, bijan] = [
      claims.find((c) => c.player.id === 'fx-cmc'),
      claims.find((c) => c.player.id === 'fx-bijan')
    ];
    const reordered = await asAgent('reorder_waiver_claims', {
      claimIds: [bijan?.id, cmc?.id],
      idempotencyKey: 'agent-order-1'
    });
    expect(
      (reordered.body as { data: { claims: { priority: number }[] } }).data.claims.map((c) => c.priority)
    ).toEqual([1, 2]);
    const bad = await asAgent('reorder_waiver_claims', {
      claimIds: [cmc?.id],
      idempotencyKey: 'agent-order-2'
    });
    expect(bad.status).toBe(400);

    const cancelled = await asAgent('cancel_waiver_claim', {
      claimId: bijan?.id,
      idempotencyKey: 'agent-cancel-1'
    });
    expect((cancelled.body as { data: { claim: { status: string } } }).data.claim.status).toBe('cancelled');
    expect(errorCode(await bob.del(`${L}/waivers/claims/${bijan?.id ?? ''}`))).toBe('WAIVER_CLAIM_NOT_FOUND');
    const again = await asAgent('cancel_waiver_claim', {
      claimId: bijan?.id,
      idempotencyKey: 'agent-cancel-2'
    });
    expect((again.body as { error: { code: string } }).error.code).toBe('WAIVER_CLAIM_NOT_PENDING');
  });
});

describe('waiver processing', () => {
  it('leaves claims pending until the player clears, and runs once per window', async () => {
    h.clock.set('2026-09-11T08:00:00.000Z');
    expect(await job()).toMatchObject({ status: 'ok', leagues: 1, processed: 1, awarded: 0 });
    expect(await job()).toMatchObject({ processed: 0 });
    expect(eventsOf('Waiver Window Opened').at(-1)?.detail).toMatchObject({
      leagueId: 'lg-w',
      closesAt: '2026-09-12T08:00:00.000Z'
    });
    expect((await h.repos.leagues.get('lg-w'))?.deadlines.nextWaiverRunAt).toBe('2026-09-12T08:00:00.000Z');
    expect(data<{ claims: unknown[] }>(await bob.get(`${L}/waivers/claims`)).claims).toHaveLength(1);
  });

  it('awards the tied bid on waiver priority, charges FAAB, and logs the transaction', async () => {
    h.clock.set('2026-09-13T08:00:00.000Z');
    expect(await job()).toMatchObject({ processed: 1, awarded: 1 });
    const bobTeam = await h.repos.teams.get('lg-w', 'team-2');
    expect(bobTeam).toMatchObject({ roster: ['fx-mahomes', 'fx-cmc'], faabRemaining: 70, waiverPriority: 4 });
    expect((await h.repos.teams.get('lg-w', 'team-3'))?.faabRemaining).toBe(100);
    const all = data<{ claims: { teamId: string; status: string; failure: { code: string } | null }[] }>(
      await alice.get(`${L}/waivers/claims?status=all`)
    ).claims;
    expect(all.find((c) => c.teamId === 'team-2')).toMatchObject({ status: 'awarded' });
    expect(all.find((c) => c.teamId === 'team-3' && c.status === 'failed')).toMatchObject({
      failure: { code: 'PLAYER_CLAIMED' }
    });
    expect(eventsOf('Waivers Processed').at(-1)?.detail).toMatchObject({
      leagueId: 'lg-w',
      awarded: [{ teamId: 'team-2', playerId: 'fx-cmc', cost: 30 }],
      // The losing claim, with why, for team-3's notification inbox (#165).
      lost: [
        {
          teamId: 'team-3',
          playerId: 'fx-cmc',
          player: { id: 'fx-cmc', name: 'Christian McCaffrey' },
          code: 'PLAYER_CLAIMED',
          reason: expect.any(String)
        }
      ],
      failed: 1
    });

    const log = data<{
      transactions: { type: string; teamId: string; cost: number | null }[];
      nextCursor: string | null;
    }>(await bob.get(`${L}/transactions`));
    expect(log.transactions.map((t) => t.type)).toEqual(['waiver_claim', 'drop', 'add', 'add']);
    expect(log.transactions[0]).toMatchObject({ teamId: 'team-2', cost: 30, added: { id: 'fx-cmc' } });
    const page = data<{ transactions: unknown[]; nextCursor: string | null }>(
      await bob.get(`${L}/transactions?limit=3`)
    );
    expect(page.transactions).toHaveLength(3);
    const rest = data<{ transactions: { type: string }[]; nextCursor: string | null }>(
      await bob.get(`${L}/transactions?limit=3&cursor=${encodeURIComponent(page.nextCursor ?? '')}`)
    );
    expect(rest).toMatchObject({ transactions: [{ type: 'add' }], nextCursor: null });
  });

  it('frees players who cleared waivers with no claim', async () => {
    const res = await alice.post(`${L}/waivers/claims`, { playerId: 'fx-bijan' });
    expect(data(res)).toMatchObject({ outcome: 'added' });
  });
});

describe('league waiver settings and edge cases', () => {
  beforeAll(async () => {
    h.clock.set('2026-09-20T12:00:00.000Z');
    const base = (await h.repos.leagues.get('lg-w'))?.settings;
    if (base === undefined) throw new Error('lg-w missing');
    await seedSeasonLeague(h.repos, {
      id: 'lg-w2',
      owners: [ALICE, BOB],
      rosters: { 'team-1': ['fx-jallen'], 'team-2': ['fx-mahomes'] },
      overrides: {
        settings: { ...base, waivers: { ...base.waivers, allowZeroBids: false, maxAcquisitionsPerWeek: 1 } }
      }
    });
    await seedSeasonLeague(h.repos, {
      id: 'lg-w3',
      owners: [ALICE, BOB],
      rosters: { 'team-1': ['fx-jallen'], 'team-2': ['fx-mahomes', 'fx-lamar'] },
      overrides: { settings: { ...base, waivers: { ...base.waivers, type: 'rolling' } } }
    });
  });

  it('enforces $0 bids and the weekly acquisition limit', async () => {
    const W2 = '/leagues/lg-w2';
    expect(data(await bob.post(`${W2}/drops`, { player: 'mahomes', teamId: 'team-2' }))).toMatchObject({
      dropped: { id: 'fx-mahomes' },
      rosterSize: 0
    });
    expect(errorCode(await bob.post(`${W2}/drops`, { playerId: 'fx-mahomes' }))).toBe('PLAYER_NOT_ON_ROSTER');
    expect(errorCode(await alice.post(`${W2}/waivers/claims`, { playerId: 'fx-mahomes', bid: 0 }))).toBe(
      'ZERO_BID_NOT_ALLOWED'
    );
    expect(errorCode(await alice.post(`${W2}/waivers/claims`, { playerId: 'fx-jallen' }))).toBe(
      'PLAYER_NOT_AVAILABLE'
    );
    expect(
      errorCode(await alice.post(`${W2}/waivers/claims`, { playerId: 'fx-kelce', teamId: 'team-2' }))
    ).toBe('FORBIDDEN');
    const first = await alice.post(`${W2}/waivers/claims`, { playerId: 'fx-kelce', teamId: 'team-1' });
    expect(data(first)).toMatchObject({ outcome: 'added' });
    expect(errorCode(await alice.post(`${W2}/waivers/claims`, { playerId: 'fx-laporta' }))).toBe(
      'ACQUISITION_LIMIT_REACHED'
    );
    const claims = data<{ claims: unknown[] }>(
      await alice.get(`${W2}/waivers/claims?teamId=team-2&status=all`)
    );
    expect(claims.claims).toEqual([]);
    expect(errorCode(await alice.get(`${W2}/waivers/claims?teamId=team-9`))).toBe('TEAM_NOT_FOUND');
    const own = data<{ claims: unknown[] }>(await bob.get(`${W2}/waivers/claims?teamId=team-2`));
    expect(own.claims).toEqual([]);
  });

  it('ignores bids under rolling waivers and previews a swap', async () => {
    const W3 = '/leagues/lg-w3';
    await bob.post(`${W3}/drops`, { playerId: 'fx-lamar' });
    const preview = data(
      await alice.get(`${W3}/waivers/preview?playerId=fx-lamar&dropPlayerId=fx-jallen&bid=40`)
    );
    expect(preview).toMatchObject({ outcome: 'claim_pending', faabAfter: 100, drop: { id: 'fx-jallen' } });
    expect((preview.resultingRoster as { id: string }[]).map((p) => p.id)).toEqual(['fx-lamar']);
    const res = await alice.post(`${W3}/waivers/claims`, {
      playerId: 'fx-lamar',
      dropPlayer: 'jalen hurts',
      bid: 40
    });
    expect(errorCode(res)).toBe('DROP_PLAYER_NOT_ON_ROSTER');
    const ok = await alice.post(`${W3}/waivers/claims`, {
      playerId: 'fx-lamar',
      dropPlayerId: 'fx-jallen',
      bid: 40
    });
    expect(data(ok)).toMatchObject({
      claim: { bid: 0, drop: { id: 'fx-jallen' } },
      dropped: { id: 'fx-jallen' }
    });
  });
});
