import { yahooDefaultSettings } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { league as leagueFixture, START } from '../../test/support/harness.js';
import { agentPrincipal, ANONYMOUS, type Principal } from '../auth/principal.js';
import type { League, LeaguePhase, Team } from '../repos/types.js';
import {
  ACTION_RULES,
  actionError,
  actorRoles,
  actorTeam,
  allowedActions,
  assertAction,
  canTransition,
  isInSeason,
  isOutsider,
  isPreDraft,
  leagueAllowedActions,
  NEXT_PHASE,
  phaseError,
  nextLineupLock,
  phaseFlags,
  resolveActor,
  transitionPhase,
  type Actor
} from './phase.js';
import { newTeam } from './seats.js';

const NOW = new Date(START);
const settings = yahooDefaultSettings(8);
const league = (overrides: Partial<League> = {}) => leagueFixture({ commissionerId: 'comm', ...overrides });
const team = (id: string, slot: number, owner?: string): Team =>
  newTeam({
    leagueId: 'lg-1',
    id,
    draftSlot: slot,
    settings,
    now: NOW,
    ...(owner === undefined ? {} : { owner: { userId: owner, name: owner, teamName: `${owner} team` } })
  });
const TEAMS = [team('team-1', 1, 'comm'), team('team-2', 2, 'member'), team('team-3', 3)];
const user = (sub: string): Principal => ({ type: 'user', sub, email: null, name: sub });
const actorFor = (principal: Principal, l: League = league()) => resolveActor(l, TEAMS, principal);

const COMMISSIONER = actorFor(user('comm'));
const MEMBER = actorFor(user('member'));
const OUTSIDER = actorFor(user('stranger'));
const AGENT = actorFor(agentPrincipal({ agentId: 'a-3', teamId: 'team-3', leagueId: 'lg-1' }));

describe('phase machine', () => {
  it('moves forward one phase at a time and stops at complete', () => {
    const order: LeaguePhase[] = ['setup', 'drafting', 'regular_season', 'playoffs', 'complete'];
    for (const [i, phase] of order.entries()) expect(NEXT_PHASE[phase]).toBe(order[i + 1] ?? null);
    expect(canTransition('setup', 'drafting')).toBe(true);
    expect(canTransition('setup', 'regular_season')).toBe(false);
    expect(canTransition('drafting', 'setup')).toBe(false);
  });

  it('transitions a league or explains the only legal move', () => {
    const later = new Date('2026-09-11T00:00:00.000Z');
    expect(transitionPhase(league(), 'drafting', later)).toMatchObject({
      phase: 'drafting',
      updatedAt: later.toISOString()
    });
    expect(() => transitionPhase(league(), 'playoffs', NOW)).toThrow(
      expect.objectContaining({ code: 'PHASE_NOT_ALLOWED', fix: expect.stringContaining('"drafting"') })
    );
    expect(() => transitionPhase(league({ phase: 'complete' }), 'setup', NOW)).toThrow(
      expect.objectContaining({ fix: expect.stringContaining('complete') })
    );
  });

  it('classifies phases', () => {
    expect(isPreDraft(league())).toBe(true);
    expect(isPreDraft(league({ phase: 'drafting' }))).toBe(false);
    expect(isInSeason(league({ phase: 'regular_season' }))).toBe(true);
    expect(isInSeason(league({ phase: 'playoffs' }))).toBe(true);
    expect(isInSeason(league({ phase: 'complete' }))).toBe(false);
  });
});

describe('phaseFlags', () => {
  const deadlines = {
    draftStartsAt: null,
    nextLineupLockAt: null,
    nextWaiverRunAt: null,
    tradeDeadlineAt: null
  };

  it('has every flag off before the season', () => {
    expect(phaseFlags(league(), NOW)).toEqual({
      waiversOpen: false,
      preLock: false,
      tradeDeadlinePassed: false
    });
  });

  it('opens waivers and pre-lock in season until the lineup lock', () => {
    const inSeason = league({
      phase: 'regular_season',
      week: 3,
      deadlines: { ...deadlines, nextLineupLockAt: '2026-09-11T00:20:00.000Z' }
    });
    expect(phaseFlags(inSeason, NOW)).toEqual({
      waiversOpen: true,
      preLock: true,
      tradeDeadlinePassed: false
    });
    expect(phaseFlags(inSeason, new Date('2026-09-11T00:20:00.000Z')).preLock).toBe(false);
    expect(phaseFlags(league({ phase: 'regular_season', week: 3 }), NOW).preLock).toBe(true);
  });

  it('stays pre-lock after Thursday night while later kickoffs remain, and reports the next one', () => {
    const THU = '2026-09-11T00:20:00.000Z';
    const SUN = '2026-09-13T17:00:00.000Z';
    const inSeason = league({
      phase: 'regular_season',
      week: 1,
      deadlines: { ...deadlines, nextLineupLockAt: THU, lineupLocksAt: [THU, SUN] }
    });
    const friday = new Date('2026-09-11T12:00:00.000Z');
    expect(phaseFlags(inSeason, friday).preLock).toBe(true);
    expect(nextLineupLock(inSeason, friday)).toBe(SUN);
    expect(nextLineupLock(inSeason, NOW)).toBe(THU);
    const monday = new Date('2026-09-14T00:00:00.000Z');
    expect(phaseFlags(inSeason, monday).preLock).toBe(false);
    expect(nextLineupLock(inSeason, monday)).toBe(SUN);
  });

  it('passes the trade deadline by week or by the stored deadline time', () => {
    const deadlineWeek = settings.trades.deadlineWeek;
    const at = (week: number, tradeDeadlineAt: string | null = null) =>
      phaseFlags(league({ phase: 'regular_season', week, deadlines: { ...deadlines, tradeDeadlineAt } }), NOW)
        .tradeDeadlinePassed;
    expect(at(deadlineWeek)).toBe(false);
    expect(at(deadlineWeek + 1)).toBe(true);
    expect(at(deadlineWeek, '2026-09-10T11:00:00.000Z')).toBe(true);
    expect(at(deadlineWeek, '2026-09-10T13:00:00.000Z')).toBe(false);
    expect(phaseFlags(league({ phase: 'regular_season', week: null }), NOW).tradeDeadlinePassed).toBe(false);
    expect(phaseFlags(league({ phase: 'playoffs', week: 15 }), NOW).tradeDeadlinePassed).toBe(true);
    expect(phaseFlags(league({ phase: 'complete', week: 17 }), NOW)).toEqual({
      waiversOpen: false,
      preLock: false,
      tradeDeadlinePassed: true
    });
  });
});

describe('actors', () => {
  it('resolves users, agents, and anonymous callers', () => {
    expect(COMMISSIONER).toMatchObject({ kind: 'user', isCommissioner: true, team: { id: 'team-1' } });
    expect(actorRoles(COMMISSIONER)).toEqual(['commissioner', 'member']);
    expect(actorRoles(MEMBER)).toEqual(['member']);
    expect(actorRoles(OUTSIDER)).toEqual(['outsider']);
    expect(actorRoles(AGENT)).toEqual(['agent']);
    expect(actorRoles(actorFor(ANONYMOUS))).toEqual(['outsider']);
    expect(actorRoles(resolveActor(league(), [], user('comm')))).toEqual(['commissioner']);
  });

  it('treats agents of other teams, human seats, or other leagues as outsiders', () => {
    const humanSeat = actorFor(agentPrincipal({ agentId: 'a', teamId: 'team-2', leagueId: 'lg-1' }));
    const otherLeague = actorFor(agentPrincipal({ agentId: 'a', teamId: 'team-3', leagueId: 'lg-2' }));
    const missing = actorFor(agentPrincipal({ agentId: 'a', teamId: 'team-9', leagueId: 'lg-1' }));
    for (const actor of [humanSeat, otherLeague, missing]) expect(isOutsider(actor)).toBe(true);
    expect(isOutsider(AGENT)).toBe(false);
  });

  it('finds the caller team', () => {
    expect(actorTeam(MEMBER)?.id).toBe('team-2');
    expect(actorTeam(AGENT)?.id).toBe('team-3');
    expect(actorTeam(OUTSIDER)).toBeNull();
    expect(actorTeam({ kind: 'anonymous' })).toBeNull();
  });
});

describe('action rules', () => {
  const allowed = (actor: Actor, l: League = league()) => allowedActions(l, actor, NOW);

  it('lets only the commissioner configure the league before the draft', () => {
    expect(allowed(COMMISSIONER)).toEqual([
      'configure_agent_seat',
      'create_invite',
      'delete_league',
      'post_message',
      'randomize_agent_seats',
      'remove_member',
      'rename_team',
      'revoke_invite',
      'set_draft_queue',
      'set_seat_type',
      'start_draft',
      'transfer_commissioner',
      'update_league_settings'
    ]);
    expect(allowed(MEMBER)).toEqual(['leave_league', 'post_message', 'rename_team', 'set_draft_queue']);
    expect(allowed(AGENT)).toEqual(['post_message', 'rename_team', 'set_draft_queue']);
    expect(allowed(OUTSIDER)).toEqual([]);
  });

  it('follows the season through the phases and flags', () => {
    expect(allowed(MEMBER, league({ phase: 'drafting' }))).toEqual([
      'make_draft_pick',
      'post_message',
      'rename_team',
      'set_draft_queue'
    ]);
    const season = league({ phase: 'regular_season', week: 5 });
    expect(allowed(AGENT, season)).toEqual([
      'cancel_waiver_claim',
      'claim_waiver',
      'counter_trade',
      'drop_player',
      'post_message',
      'propose_trade',
      'rename_team',
      'reorder_waiver_claims',
      'respond_to_trade',
      'set_lineup',
      'vote_trade',
      'withdraw_trade'
    ]);
    const lateSeason = league({ phase: 'regular_season', week: 12 });
    expect(allowed(AGENT, lateSeason)).not.toContain('propose_trade');
    expect(allowed(COMMISSIONER, league({ phase: 'complete' }))).toEqual(['post_message']);
  });

  it('explains every refusal with a fix', () => {
    const season = league({ phase: 'regular_season', week: 12 });
    expect(actionError('nope', league(), MEMBER, NOW)).toMatchObject({ code: 'NOT_FOUND' });
    expect(actionError('create_invite', league(), MEMBER, NOW)).toMatchObject({
      code: 'FORBIDDEN',
      fix: expect.stringContaining('commissioner')
    });
    expect(actionError('leave_league', league(), COMMISSIONER, NOW)).toMatchObject({
      code: 'FORBIDDEN',
      fix: expect.stringContaining('transfer_commissioner')
    });
    expect(actionError('leave_league', league({ phase: 'drafting' }), MEMBER, NOW)).toMatchObject({
      code: 'PHASE_NOT_ALLOWED',
      fix: expect.stringContaining('can no longer be done')
    });
    expect(actionError('make_draft_pick', league(), MEMBER, NOW)).toMatchObject({
      code: 'PHASE_NOT_ALLOWED',
      fix: expect.stringContaining('Wait until')
    });
    expect(actionError('propose_trade', season, MEMBER, NOW)).toMatchObject({
      code: 'TRADE_DEADLINE_PASSED',
      message: 'The trade deadline has passed.',
      details: { flag: 'tradeDeadlinePassed' }
    });
    expect(actionError('claim_waiver', league({ phase: 'regular_season', week: 3 }), MEMBER, NOW)).toBeNull();
    expect(() => assertAction('create_invite', league(), MEMBER, NOW)).toThrow(
      'You cannot call create_invite'
    );
    expect(() => assertAction('create_invite', league(), COMMISSIONER, NOW)).not.toThrow();
  });

  it('can check a flag that must be on', () => {
    const rules = {
      closed: {
        phases: ['setup'] as const,
        roles: ['member'] as const,
        roleFix: 'x',
        flag: { name: 'waiversOpen' as const, value: true, message: 'Closed.', fix: 'Wait.' }
      }
    };
    expect(actionError('closed', league(), MEMBER, NOW, rules)).toMatchObject({ message: 'Closed.' });
  });

  it('builds phase errors that say whether to wait', () => {
    expect(phaseError('x', 'setup', ['playoffs']).fix).toContain('Wait until');
    expect(phaseError('x', 'playoffs', ['setup', 'drafting']).fix).toContain('can no longer be done');
    expect(phaseError('x', 'drafting', ['setup', 'playoffs']).details).toEqual({
      phase: 'drafting',
      allowedPhases: ['setup', 'playoffs']
    });
  });

  it('every rule names a role and a phase', () => {
    for (const [name, rule] of Object.entries(ACTION_RULES)) {
      expect(rule.phases.length, name).toBeGreaterThan(0);
      expect(rule.roles.length, name).toBeGreaterThan(0);
      expect(rule.roleFix.length, name).toBeGreaterThan(10);
    }
  });
});

describe('leagueAllowedActions', () => {
  const ops = [
    { name: 'create_invite', mutation: true, pathParams: ['leagueId'] },
    { name: 'get_league', mutation: false, pathParams: ['leagueId'] },
    { name: 'create_league', mutation: true, pathParams: [] },
    { name: 'future_op', mutation: true, pathParams: ['leagueId'], phases: ['drafting'] as const },
    { name: 'any_phase_op', mutation: true, pathParams: ['leagueId'] }
  ];

  it('keeps existing league mutations the caller may run now', () => {
    expect(leagueAllowedActions(ops, league(), COMMISSIONER, NOW)).toEqual(['any_phase_op', 'create_invite']);
    expect(leagueAllowedActions(ops, league({ phase: 'drafting' }), MEMBER, NOW)).toEqual([
      'any_phase_op',
      'future_op'
    ]);
    expect(leagueAllowedActions(ops, league(), OUTSIDER, NOW)).toEqual([]);
  });
});
