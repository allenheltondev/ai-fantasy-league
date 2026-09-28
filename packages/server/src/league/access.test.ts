import { FixedClock } from '@fantasy/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { START } from '../../test/support/harness.js';
import { ALICE, BOB, CAROL, seedLeague } from '../../test/support/leagues.js';
import { agentPrincipal, ANONYMOUS, type Principal } from '../auth/principal.js';
import { createContext, type Ctx } from '../context.js';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { silentLogger } from '../log.js';
import { createInMemoryRepos } from '../repos/memory.js';
import type { Repos } from '../repos/types.js';
import { createServices } from '../services.js';
import { loadAccess, requireCommissioner, requireMember, requireTeam, requireTeamOwner } from './access.js';

const user = (u: { sub: string; name: string; email: string }): Principal => ({ type: 'user', ...u });

let repos: Repos;
const ctxAs = (principal: Principal): Ctx =>
  createContext(
    createServices({
      clock: new FixedClock(START),
      repos,
      events: new InMemoryEventPublisher(),
      log: silentLogger
    }),
    principal
  );

beforeEach(async () => {
  repos = createInMemoryRepos();
  // Alice is commissioner on team-1, Bob holds team-2; the rest are agent seats.
  await seedLeague(repos, { id: 'lg-a', owners: [ALICE, BOB] });
  await seedLeague(repos, { id: 'lg-b', owners: [CAROL] });
});

describe('requireMember', () => {
  it('lets members, the commissioner, and the league agents read', async () => {
    await expect(requireMember(ctxAs(user(ALICE)), 'lg-a')).resolves.toMatchObject({
      league: { id: 'lg-a' }
    });
    await expect(requireMember(ctxAs(user(BOB)), 'lg-a')).resolves.toMatchObject({
      actor: { kind: 'user', team: { id: 'team-2' } }
    });
    const agent = agentPrincipal({ agentId: 'ag-5', teamId: 'team-5', leagueId: 'lg-a' });
    await expect(requireMember(ctxAs(agent), 'lg-a')).resolves.toMatchObject({ actor: { kind: 'agent' } });
  });

  it('denies other leagues, strangers, and agents of human seats', async () => {
    await expect(requireMember(ctxAs(user(CAROL)), 'lg-a')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      fix: expect.stringContaining('join_league')
    });
    await expect(requireMember(ctxAs(user(ALICE)), 'lg-b')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const agentOnHumanSeat = agentPrincipal({ agentId: 'ag-2', teamId: 'team-2', leagueId: 'lg-a' });
    await expect(requireMember(ctxAs(agentOnHumanSeat), 'lg-a')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      fix: expect.stringContaining('Agents')
    });
    await expect(requireMember(ctxAs(ANONYMOUS), 'lg-a')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reports a missing league', async () => {
    await expect(loadAccess(ctxAs(user(ALICE)), 'nope')).rejects.toMatchObject({ code: 'LEAGUE_NOT_FOUND' });
  });
});

describe('requireCommissioner', () => {
  it('admits only the commissioner', async () => {
    await expect(requireCommissioner(ctxAs(user(ALICE)), 'lg-a')).resolves.toMatchObject({
      league: { commissionerId: 'alice' }
    });
    await expect(requireCommissioner(ctxAs(user(BOB)), 'lg-a')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      fix: expect.stringContaining('Alice')
    });
    const agent = agentPrincipal({ agentId: 'ag-5', teamId: 'team-5', leagueId: 'lg-a' });
    await expect(requireCommissioner(ctxAs(agent), 'lg-a')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(requireCommissioner(ctxAs(user(CAROL)), 'lg-a')).rejects.toMatchObject({
      message: 'You are not a member of this league.'
    });
  });
});

describe('requireTeamOwner', () => {
  it('lets owners change only their own team', async () => {
    const bob = await requireMember(ctxAs(user(BOB)), 'lg-a');
    expect(requireTeamOwner(bob, 'team-2').id).toBe('team-2');
    expect(() => requireTeamOwner(bob, 'team-1')).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', fix: expect.stringContaining('"team-2"') })
    );
    expect(() => requireTeamOwner(bob, 'team-5', { commissionerForUnowned: true })).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' })
    );
    expect(() => requireTeamOwner(bob, 'team-99')).toThrow(
      expect.objectContaining({ code: 'TEAM_NOT_FOUND' })
    );
  });

  it('lets the commissioner act for seats no person holds, when allowed', async () => {
    const alice = await requireMember(ctxAs(user(ALICE)), 'lg-a');
    expect(requireTeamOwner(alice, 'team-5', { commissionerForUnowned: true }).id).toBe('team-5');
    expect(() => requireTeamOwner(alice, 'team-5')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => requireTeamOwner(alice, 'team-2', { commissionerForUnowned: true })).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' })
    );
  });

  it('keeps agents on their own team', async () => {
    const agent = agentPrincipal({ agentId: 'ag-5', teamId: 'team-5', leagueId: 'lg-a' });
    const access = await requireMember(ctxAs(agent), 'lg-a');
    expect(requireTeamOwner(access, 'team-5').id).toBe('team-5');
    expect(() => requireTeamOwner(access, 'team-6')).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', fix: 'Use your own teamId "team-5".' })
    );
    const { teams, league } = access;
    expect(() =>
      requireTeamOwner({ league, teams, actor: { kind: 'agent', agentId: 'x', team: null } }, 'team-6')
    ).toThrow(expect.objectContaining({ fix: 'Use your own teamId "(none)".' }));
  });

  it('refuses callers with no team at all', async () => {
    const access = await loadAccess(ctxAs(user(CAROL)), 'lg-a');
    expect(() => requireTeamOwner(access, 'team-1')).toThrow(
      expect.objectContaining({ fix: 'You can only change a team you own.' })
    );
    expect(() => requireTeamOwner({ ...access, actor: { kind: 'anonymous' } }, 'team-1')).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' })
    );
    expect(requireTeam(access, 'team-3').name).toBe('Team 3');
  });
});
