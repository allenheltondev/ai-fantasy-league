import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../../../test/support/harness.js';
import { as, data, errorCode, type Caller } from '../../../test/support/league-client.js';
import { ALICE, BOB, CAROL, seedLeague } from '../../../test/support/leagues.js';
import { agentPrincipal } from '../../auth/principal.js';
import { vacateSeat } from '../../league/seats.js';
import { invokeTool } from '../../registry/invoke.js';
import { registry } from '../index.js';

/**
 * Team names (#194): who set a team's name (`nameSetBy`) on every rename path, the rename history,
 * the rules an AI manager's name must follow, the commissioner's lock, and the move board entry.
 */

let h: Harness;
let alice: Caller;
let bob: Caller;
let carol: Caller;
const SEAT = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' };

beforeEach(async () => {
  h = await createHarness({ registry });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  carol = as(h, CAROL);
  await seedLeague(h.repos, { id: 'lg-n', owners: [ALICE, BOB, CAROL] });
  expect((await alice.put('/leagues/lg-n/agents/team-4', { ...SEAT, name: 'Marcus Hale' })).status).toBe(200);
  expect(
    (await alice.put('/leagues/lg-n/agents/team-5', { ...SEAT, personalityId: 'hype-man', namesTeam: false }))
      .status
  ).toBe(200);
});
afterEach(() => h.close());

type TeamView = { id: string; name: string; nameSetBy: string; renamedFrom: string | null };

async function team(id: string): Promise<TeamView> {
  const league = data<{ teams: TeamView[] }>(await alice.get('/leagues/lg-n'));
  return league.teams.find((t) => t.id === id) as TeamView;
}

let step = 0;
function agentRename(teamId: string, name: string) {
  return invokeTool({
    registry: h.registry,
    services: h.services,
    principal: agentPrincipal({ agentId: `lg-n.${teamId}`, teamId, leagueId: 'lg-n' }),
    name: 'rename_team',
    args: { leagueId: 'lg-n', teamId, name, idempotencyKey: `agent-rename-${++step}` }
  });
}

const renamed = () =>
  h.events.events
    .filter((e) => e.detailType === 'Team Renamed')
    .map((e) => e.detail as Record<string, unknown>);

describe('nameSetBy bookkeeping', () => {
  it('starts as the owner’s for people and the default for AI seats', async () => {
    expect(await team('team-2')).toMatchObject({ name: "Bob's Team", nameSetBy: 'owner', renamedFrom: null });
    expect(await team('team-4')).toMatchObject({ name: 'Team 4', nameSetBy: 'default', renamedFrom: null });
  });

  it('records an owner’s rename and announces it', async () => {
    expect(data(await bob.put('/leagues/lg-n/teams/team-2/name', { name: 'Bob Squad' }))).toMatchObject({
      team: { name: 'Bob Squad', nameSetBy: 'owner', renamedFrom: "Bob's Team" }
    });
    expect(renamed()).toEqual([
      { leagueId: 'lg-n', teamId: 'team-2', from: "Bob's Team", to: 'Bob Squad', by: 'owner' }
    ]);
    // The same name again is no rename.
    await bob.put('/leagues/lg-n/teams/team-2/name', { name: 'Bob Squad' });
    expect(renamed()).toHaveLength(1);
  });

  it('leaves a commissioner’s name to the AI manager when its seat names its team, else locks it', async () => {
    expect(data(await alice.put('/leagues/lg-n/teams/team-4/name', { name: 'Robo Ballers' }))).toMatchObject({
      team: { nameSetBy: 'default', renamedFrom: 'Team 4' }
    });
    expect(data(await alice.put('/leagues/lg-n/teams/team-5/name', { name: 'Locked In' }))).toMatchObject({
      team: { nameSetBy: 'commissioner' }
    });
    // A seat nobody configured has no manager to leave it to: locked too.
    expect(data(await alice.put('/leagues/lg-n/teams/team-6/name', { name: 'Open Book' }))).toMatchObject({
      team: { nameSetBy: 'commissioner' }
    });
    expect(renamed().map((e) => e.by)).toEqual(['commissioner', 'commissioner', 'commissioner']);

    // The AI manager may replace the name left to it, never a locked one.
    expect((await agentRename('team-4', 'Regression to the Mean')).body).toMatchObject({
      data: { team: { name: 'Regression to the Mean', nameSetBy: 'agent', renamedFrom: 'Robo Ballers' } }
    });
    expect((await agentRename('team-6', 'Mine Now')).body).toMatchObject({
      error: { code: 'FORBIDDEN', fix: expect.stringContaining('commissioner picked this name') }
    });
    expect(renamed().at(-1)).toMatchObject({ teamId: 'team-4', by: 'agent' });
  });

  it('never lets an agent rename when its seat does not name its team', async () => {
    expect((await agentRename('team-5', 'Fireworks Factory')).body).toMatchObject({
      error: { code: 'FORBIDDEN', fix: expect.stringContaining('does not let you name your team') }
    });
    expect((await team('team-5')).name).toBe('Team 5');
  });

  it('holds an AI manager’s name to the naming rules, with a fix for each', async () => {
    const refused = async (name: string) => (await agentRename('team-4', name)).body;
    expect(await refused('Team 9')).toMatchObject({
      error: { code: 'INVALID_INPUT', details: { reason: 'generic' } }
    });
    expect(await refused('Marcus Hale')).toMatchObject({ error: { details: { reason: 'generic' } } });
    expect(await refused('Ok')).toMatchObject({
      error: { code: 'INVALID_INPUT', details: { reason: 'length' } }
    });
    expect(await refused('Bob Is My Hero')).toMatchObject({
      error: { code: 'INVALID_INPUT', details: { reason: 'impersonation' }, fix: expect.any(String) }
    });
    expect(await refused('Sh1t Show')).toMatchObject({ error: { details: { reason: 'blocked' } } });
    expect(await refused("carol's  TEAM")).toMatchObject({ error: { code: 'CONFLICT' } });
    expect((await team('team-4')).name).toBe('Team 4');
    expect(renamed()).toEqual([]);
  });

  it('puts a vacated seat back to its default name', async () => {
    await bob.put('/leagues/lg-n/teams/team-2/name', { name: 'Bob Squad' });
    expect((await bob.post('/leagues/lg-n/leave')).status).toBe(200);
    expect(await team('team-2')).toMatchObject({ name: 'Team 2', nameSetBy: 'default' });
    const stored = await h.repos.teams.get('lg-n', 'team-2');
    expect(vacateSeat(stored!, new Date()).nameSetBy).toBe('default');
  });
});

describe('the namesTeam seat toggle', () => {
  it('is the commissioner’s alone, and carries over when left out', async () => {
    expect(errorCode(await bob.put('/leagues/lg-n/agents/team-4', { ...SEAT, namesTeam: false }))).toBe(
      'FORBIDDEN'
    );
    await alice.put('/leagues/lg-n/agents/team-5', { ...SEAT, difficulty: 'rookie' });
    const seat = data<{ commissioner: { current: { config: Record<string, unknown> } } }>(
      await alice.get('/leagues/lg-n/agents/team-5')
    );
    expect(seat.commissioner.current.config).toMatchObject({ namesTeam: false, difficulty: 'rookie' });
    // Other members see the public persona only.
    const pub = data<{ seat: Record<string, unknown>; commissioner: null }>(
      await bob.get('/leagues/lg-n/agents/team-5')
    );
    expect(pub.commissioner).toBeNull();
    expect(JSON.stringify(pub.seat)).not.toContain('namesTeam');
  });
});

describe('the move board', () => {
  it('shows renames next to roster moves, newest first', async () => {
    await bob.put('/leagues/lg-n/teams/team-2/name', { name: 'Bob Squad' });
    h.clock.set(new Date(h.clock.now().getTime() + 60_000).toISOString());
    await agentRename('team-4', 'Standard Deviants');
    const board = data<{ moves: Record<string, unknown>[]; hasMoreMoves: boolean }>(
      await carol.get('/leagues/lg-n/dashboard?moves=1')
    );
    expect(board.moves).toEqual([
      expect.objectContaining({
        type: 'team_renamed',
        week: 1,
        rename: { from: 'Team 4', to: 'Standard Deviants', by: 'agent' },
        teams: [expect.objectContaining({ teamId: 'team-4', teamName: 'Standard Deviants', added: [] })]
      })
    ]);
    expect(board.hasMoreMoves).toBe(true);
    const all = data<{ moves: { type: string; rename: { to: string } | null }[] }>(
      await carol.get('/leagues/lg-n/dashboard')
    );
    expect(all.moves.map((m) => m.rename?.to)).toEqual(['Standard Deviants', 'Bob Squad']);
  });
});
