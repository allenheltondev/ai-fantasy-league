import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentPrincipal, type AgentPrincipal } from '../../src/auth/principal.js';
import { startSeasonSchedule } from '../../src/league/schedule.js';
import { leagueOperations } from '../../src/operations/league/index.js';
import { registry } from '../../src/operations/index.js';
import { invokeTool } from '../../src/registry/invoke.js';
import { createHarness, type Harness } from '../support/harness.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE, BOB, CAROL } from '../support/leagues.js';

/**
 * League lifecycle end to end: the REST adapter, real token verification, and DynamoDB Local. A creates a
 * league, B joins by invite, C is refused everywhere, settings change before and after the draft,
 * quotas and idempotency hold, and agents stay inside their own league and team.
 */

let h: Harness;
let alice: Caller;
let bob: Caller;
let carol: Caller;
let leagueId: string;
let otherLeagueId: string;

/** Valid bodies, so a refusal is about access and never about input. */
const BODIES: Record<string, unknown> = {
  update_league_settings: { changes: { trades: { reviewPeriodDays: 1 } } },
  create_invite: {},
  transfer_commissioner: { userId: 'bob' },
  set_seat_type: { seatType: 'agent' },
  rename_team: { name: 'Taken Over' },
  leave_league: {}
};

function pathFor(path: string, params: Record<string, string>): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? name);
}

beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo', registry });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  carol = as(h, CAROL);
});
afterAll(() => h.close());

describe('league lifecycle over HTTP (DynamoDB Local)', () => {
  it('A creates a league and is its commissioner on seat 1', async () => {
    const res = await alice.post('/leagues', { name: 'Hero League', teamCount: 8, preset: 'full_ppr' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const league = data<{ id: string; teams: { ownerUserId: string | null; seatType: string }[] }>(res);
    leagueId = league.id;
    expect(league.teams[0]).toMatchObject({ ownerUserId: 'alice', seatType: 'human' });
    expect(league.teams.filter((t) => t.seatType === 'agent')).toHaveLength(7);
    const mine = data<{ leagues: { id: string }[] }>(await alice.get('/leagues'));
    expect(mine.leagues.map((l) => l.id)).toEqual([leagueId]);
    const state = await alice.get(`/leagues/${leagueId}/state`);
    expect(state.body).toMatchObject({
      data: { phase: 'setup', youAreCommissioner: true, yourTeam: { id: 'team-1' } },
      league: { id: leagueId, phase: 'setup', allowedActions: expect.arrayContaining(['create_invite']) }
    });
    otherLeagueId = data<{ id: string }>(await carol.post('/leagues', { name: 'Carol League' })).id;
  });

  it('B previews and joins with an invite; the token works once', async () => {
    const created = await alice.post(`/leagues/${leagueId}/invites`, { email: 'bob@example.com' });
    const { token } = data<{ token: string }>(created);
    const preview = await h.request(`/api/v1/invites/${token}`, { token: null });
    expect(data(preview)).toMatchObject({
      leagueName: 'Hero League',
      commissionerName: 'Alice',
      openSeats: 7,
      joinable: true
    });
    const joined = await bob.post(`/invites/${token}/join`, { teamName: 'Bob Squad' });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(data(joined)).toMatchObject({ team: { id: 'team-2', name: 'Bob Squad', ownerUserId: 'bob' } });
    expect(errorCode(await carol.post(`/invites/${token}/join`, {}))).toBe('INVITE_USED_UP');
    expect(data<{ leagues: { id: string }[] }>(await bob.get('/leagues')).leagues.map((l) => l.id)).toEqual([
      leagueId
    ]);
    const events = h.events.events.map((e) => e.detailType);
    expect(events).toEqual(expect.arrayContaining(['League Created', 'Member Joined']));
  });

  it('C, who is not a member, gets 403 from every league operation', async () => {
    const params = { leagueId, teamId: 'team-2', inviteId: 'inv-1', userId: 'bob' };
    const scoped = leagueOperations.filter((op) => op.pathParams.includes('leagueId'));
    expect(scoped.length).toBe(19);
    for (const op of scoped) {
      const res = await h.request(`/api/v1${pathFor(op.path, params)}`, {
        method: op.method,
        token: carol.token,
        ...(op.mutation ? { idempotencyKey: `carol-${op.name}` } : {}),
        ...(op.method === 'GET' || op.method === 'DELETE' ? {} : { body: BODIES[op.name] ?? {} })
      });
      expect(res.status, `${op.name}: ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body, op.name).toMatchObject({ error: { code: 'FORBIDDEN', fix: expect.any(String) } });
    }
  });

  it('B, a member, cannot configure the league or touch another team', async () => {
    expect((await bob.get(`/leagues/${leagueId}`)).status).toBe(200);
    for (const [name, call] of [
      [
        'update_league_settings',
        () => bob.patch(`/leagues/${leagueId}/settings`, BODIES.update_league_settings)
      ],
      ['create_invite', () => bob.post(`/leagues/${leagueId}/invites`, {})],
      ['list_invites', () => bob.get(`/leagues/${leagueId}/invites`)],
      ['set_seat_type', () => bob.put(`/leagues/${leagueId}/teams/team-3/seat-type`, BODIES.set_seat_type)],
      ['rename_team', () => bob.put(`/leagues/${leagueId}/teams/team-1/name`, BODIES.rename_team)],
      ['remove_member', () => bob.del(`/leagues/${leagueId}/members/alice`)],
      ['delete_league', () => bob.del(`/leagues/${leagueId}`)]
    ] as const) {
      expect(errorCode(await call()), name).toBe('FORBIDDEN');
    }
    expect(
      data(await bob.put(`/leagues/${leagueId}/teams/team-2/name`, { name: 'Bob Squad II' }))
    ).toMatchObject({
      team: { name: 'Bob Squad II' }
    });
  });

  it('A edits settings before the draft, with optimistic concurrency', async () => {
    const before = data<{ version: number }>(await alice.get(`/leagues/${leagueId}`));
    const res = await alice.patch(`/leagues/${leagueId}/settings`, {
      changes: { roster: { slots: { BN: 5 } }, waivers: { faabBudget: 150 } },
      expectedVersion: before.version
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(data(res)).toMatchObject({
      version: before.version + 1,
      changedPaths: ['roster.slots.BN', 'waivers.faabBudget']
    });
    const teams = data<{ teams: { faabRemaining: number }[] }>(await alice.get(`/leagues/${leagueId}`)).teams;
    expect(teams.every((t) => t.faabRemaining === 150)).toBe(true);
    const stale = await alice.patch(`/leagues/${leagueId}/settings`, {
      changes: { waivers: { faabBudget: 175 } },
      expectedVersion: before.version
    });
    expect(errorCode(stale)).toBe('CONFLICT');
    expect(h.events.events.map((e) => e.detailType)).toContain('Settings Changed');
  });

  it('replays mutations with the same Idempotency-Key and rejects a reused key', async () => {
    const key = 'flow-invite-key-1';
    const first = await alice.post(`/leagues/${leagueId}/invites`, { maxUses: 2 }, key);
    const replay = await alice.post(`/leagues/${leagueId}/invites`, { maxUses: 2 }, key);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect((await h.repos.invites.list(leagueId)).length).toBe(2);
    expect((await alice.post(`/leagues/${leagueId}/invites`, { maxUses: 3 }, key)).status).toBe(422);
    const created = await alice.post('/leagues', { name: 'Replay' }, 'flow-create-key-1');
    const again = await alice.post('/leagues', { name: 'Replay' }, 'flow-create-key-1');
    expect(again.body).toEqual(created.body);
    const ids = data<{ leagues: { id: string }[] }>(await alice.get('/leagues')).leagues.map((l) => l.id);
    expect(ids).toHaveLength(2);
  });

  it('enforces the per-user quota of active leagues', async () => {
    expect((await alice.post('/leagues', { name: 'Third' })).status).toBe(200);
    const fourth = await alice.post('/leagues', { name: 'Fourth' });
    expect(fourth.status).toBe(403);
    expect(fourth.body).toMatchObject({ error: { code: 'LEAGUE_QUOTA_EXCEEDED', details: { limit: 3 } } });
    const extra = data<{ leagues: { id: string; name: string }[] }>(await alice.get('/leagues')).leagues.find(
      (l) => l.name === 'Third'
    );
    expect(
      (await alice.post(`/leagues/${extra!.id}/chat/messages`, { text: 'about to delete this' })).status
    ).toBe(200);
    expect((await alice.del(`/leagues/${extra!.id}`)).status).toBe(200);
    // The chat partition goes with the league.
    expect((await h.repos.chat.list(extra!.id, 'trash-talk', { limit: 10 })).messages).toEqual([]);
    expect((await alice.post('/leagues', { name: 'Fourth' })).status).toBe(200);
  });

  it('locks draft-time settings after the draft and generates the schedule', async () => {
    const stored = await h.repos.leagues.get(leagueId);
    const drafting = await h.repos.leagues.update({ ...stored!, phase: 'drafting' });
    const schedule = await startSeasonSchedule({ repos: h.repos }, drafting);
    expect(schedule).toHaveLength(14 * 4);
    const locked = await alice.patch(`/leagues/${leagueId}/settings`, {
      changes: { scoring: { perStat: { rec: 0.5 } } }
    });
    expect(locked.status).toBe(400);
    expect(locked.body).toMatchObject({
      error: {
        code: 'INVALID_SETTINGS',
        details: {
          issues: [expect.objectContaining({ code: 'SETTING_LOCKED', path: 'scoring.perStat.rec' })]
        }
      }
    });
    const allowed = await alice.patch(`/leagues/${leagueId}/settings`, {
      changes: { trades: { review: 'none' } }
    });
    expect(allowed.status).toBe(200);
    expect(errorCode(await bob.post(`/leagues/${leagueId}/leave`))).toBe('PHASE_NOT_ALLOWED');
    expect(errorCode(await alice.del(`/leagues/${leagueId}`))).toBe('PHASE_NOT_ALLOWED');
    const matchup = data<{ matchup: { week: number } }>(await bob.get(`/leagues/${leagueId}/matchup`));
    expect(matchup.matchup.week).toBe(1);
  });
});

describe('agents stay in their own league and team (invokeTool)', () => {
  const agentOn = (teamId: string, league = leagueId): AgentPrincipal =>
    agentPrincipal({ agentId: `agent-${teamId}`, teamId, leagueId: league });
  const call = (principal: AgentPrincipal, name: string, args: Record<string, unknown>) =>
    invokeTool({ registry, services: h.services, principal, name, args });

  it('reads its own league', async () => {
    const res = await call(agentOn('team-3'), 'get_league_state', { leagueId });
    expect(res.body).toMatchObject({ data: { yourTeam: { id: 'team-3' } }, league: { id: leagueId } });
  });

  it('is refused in another league', async () => {
    for (const name of ['get_league', 'get_league_state', 'get_standings', 'get_matchup']) {
      const res = await call(agentOn('team-3'), name, { leagueId: otherLeagueId });
      expect(res.status, name).toBe(403);
    }
  });

  it('is refused on another team and for configuration', async () => {
    const rename = await call(agentOn('team-3'), 'rename_team', {
      leagueId,
      teamId: 'team-4',
      name: 'Hijacked',
      idempotencyKey: 'agent-hijack-1'
    });
    expect(rename.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    const settings = await call(agentOn('team-3'), 'update_league_settings', {
      leagueId,
      changes: {},
      idempotencyKey: 'agent-settings-1'
    });
    expect(settings.status).toBe(403);
    const humanSeat = await call(agentOn('team-2'), 'get_league', { leagueId });
    expect(humanSeat.body).toMatchObject({
      error: { code: 'FORBIDDEN', fix: expect.stringContaining('Agents') }
    });
  });
});
