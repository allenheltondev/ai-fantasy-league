import { nextKickoff } from '@fantasy/core';
import type { Principal } from '../auth/principal.js';
import { ApiError, type ErrorCode } from '../errors.js';
import { LEAGUE_PHASES, type League, type LeaguePhase, type Team } from '../repos/types.js';

/**
 * The league phase machine and the rules for which actions a caller may take right now. Everything
 * here is pure: callers pass the league, its teams, the caller, and `now` from `ctx.clock`.
 */

export { LEAGUE_PHASES, type LeaguePhase };

/** The only forward move from each phase. `complete` is final. */
export const NEXT_PHASE: Readonly<Record<LeaguePhase, LeaguePhase | null>> = {
  setup: 'drafting',
  drafting: 'regular_season',
  regular_season: 'playoffs',
  playoffs: 'complete',
  complete: null
};

export function phaseIndex(phase: LeaguePhase): number {
  return LEAGUE_PHASES.indexOf(phase);
}

/** Phases only move forward, one step at a time. */
export function canTransition(from: LeaguePhase, to: LeaguePhase): boolean {
  return NEXT_PHASE[from] === to;
}

/** Moves a league to its next phase, or throws PHASE_NOT_ALLOWED for any other move. */
export function transitionPhase(league: League, to: LeaguePhase, now: Date): League {
  if (!canTransition(league.phase, to)) {
    const next = NEXT_PHASE[league.phase];
    throw new ApiError('PHASE_NOT_ALLOWED', `A league cannot move from "${league.phase}" to "${to}".`, {
      fix:
        next === null
          ? 'The league is complete; it cannot change phase again.'
          : `The only next phase from "${league.phase}" is "${next}".`,
      details: { phase: league.phase, requested: to }
    });
  }
  return { ...league, phase: to, updatedAt: now.toISOString() };
}

/** Before the draft: seats, invites, and every setting can still change. */
export function isPreDraft(league: Pick<League, 'phase'>): boolean {
  return league.phase === 'setup';
}

/** Regular season or playoffs: lineups, waivers, and scoring are live. */
export function isInSeason(league: Pick<League, 'phase'>): boolean {
  return league.phase === 'regular_season' || league.phase === 'playoffs';
}

// ---------------------------------------------------------------------------
// Sub-phase flags
// ---------------------------------------------------------------------------

export interface PhaseFlags {
  /** Waiver claims and free-agent adds are accepted. */
  waiversOpen: boolean;
  /** Some of the current week's games have not kicked off yet, so those players' slots can still change. */
  preLock: boolean;
  /** No more trades can process this season. */
  tradeDeadlinePassed: boolean;
}

const before = (now: Date, at: string | null) => at === null || now.getTime() < new Date(at).getTime();

export function phaseFlags(league: League, now: Date): PhaseFlags {
  const inSeason = isInSeason(league);
  const deadlineWeek = league.settings.trades.deadlineWeek;
  const deadlineAt = league.deadlines.tradeDeadlineAt;
  const tradeDeadlinePassed =
    league.phase === 'playoffs' ||
    league.phase === 'complete' ||
    (league.phase === 'regular_season' &&
      ((league.week !== null && league.week > deadlineWeek) ||
        (deadlineAt !== null && !before(now, deadlineAt))));
  return {
    waiversOpen: inSeason,
    preLock: inSeason && before(now, nextLineupLock(league, now)),
    tradeDeadlinePassed
  };
}

/**
 * The next lineup lock at `now`: the week's next kickoff still ahead (`deadlines.lineupLocksAt`),
 * so after Thursday night it moves on to Sunday. Leagues without the list fall back to the week's
 * first kickoff; with every game kicked off it is that last kickoff, already passed.
 */
export function nextLineupLock(league: League, now: Date): string | null {
  const locks = league.deadlines.lineupLocksAt ?? [];
  if (locks.length === 0) return league.deadlines.nextLineupLockAt;
  return nextKickoff(locks, now) ?? (locks.at(-1) as string);
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

export type LeagueRole = 'commissioner' | 'member' | 'agent' | 'outsider';

/** The caller as the league sees them. */
export type Actor =
  | { kind: 'user'; userId: string; name: string; isCommissioner: boolean; team: Team | null }
  | { kind: 'agent'; agentId: string; team: Team | null }
  | { kind: 'anonymous' };

export function resolveActor(league: League, teams: readonly Team[], principal: Principal): Actor {
  switch (principal.type) {
    case 'user':
      return {
        kind: 'user',
        userId: principal.sub,
        name: principal.name,
        isCommissioner: league.commissionerId === principal.sub,
        team: teams.find((t) => t.ownerUserId === principal.sub) ?? null
      };
    case 'agent': {
      const team =
        principal.leagueId === league.id
          ? (teams.find((t) => t.id === principal.teamId && t.seatType === 'agent') ?? null)
          : null;
      return { kind: 'agent', agentId: principal.agentId, team };
    }
    case 'anonymous':
      return { kind: 'anonymous' };
  }
}

export function actorRoles(actor: Actor): LeagueRole[] {
  if (actor.kind === 'user') {
    const roles: LeagueRole[] = [];
    if (actor.isCommissioner) roles.push('commissioner');
    if (actor.team !== null) roles.push('member');
    return roles.length === 0 ? ['outsider'] : roles;
  }
  if (actor.kind === 'agent' && actor.team !== null) return ['agent'];
  return ['outsider'];
}

/** The team the caller manages, if any. */
export function actorTeam(actor: Actor): Team | null {
  return actor.kind === 'anonymous' ? null : actor.team;
}

export function isOutsider(actor: Actor): boolean {
  return actorRoles(actor).includes('outsider');
}

// ---------------------------------------------------------------------------
// Action rules
// ---------------------------------------------------------------------------

export interface ActionRule {
  phases: readonly LeaguePhase[];
  /** Any one of these roles may act. */
  roles: readonly LeagueRole[];
  /** Fix for a caller without one of the roles. */
  roleFix: string;
  /** Roles that may not act even when they also hold an allowed role. */
  deny?: { roles: readonly LeagueRole[]; message: string; fix: string };
  /** A sub-phase flag that must have this value. The error code defaults to PHASE_NOT_ALLOWED. */
  flag?: { name: keyof PhaseFlags; value: boolean; message: string; fix: string; code?: ErrorCode };
}

const ALL: readonly LeaguePhase[] = LEAGUE_PHASES;
const ACTIVE: readonly LeaguePhase[] = ['setup', 'drafting', 'regular_season', 'playoffs'];
const IN_SEASON: readonly LeaguePhase[] = ['regular_season', 'playoffs'];
const PLAYERS: readonly LeagueRole[] = ['member', 'agent'];
const COMMISSIONER_FIX =
  'Only the commissioner can do this. Ask the commissioner (see get_league) to make the change.';
const PLAYER_FIX = 'Only a team in this league can do this. Join with an invite link first (join_league).';

/**
 * Which league mutations are possible, by phase, role, and sub-phase flag. Reads are open to every
 * member in every phase and are not listed. Operations added later that have no rule here fall back
 * to their own `phases` (see `leagueAllowedActions`).
 */
export const ACTION_RULES: Readonly<Record<string, ActionRule>> = {
  update_league_settings: { phases: ACTIVE, roles: ['commissioner'], roleFix: COMMISSIONER_FIX },
  create_invite: { phases: ['setup'], roles: ['commissioner'], roleFix: COMMISSIONER_FIX },
  revoke_invite: { phases: ['setup'], roles: ['commissioner'], roleFix: COMMISSIONER_FIX },
  remove_member: { phases: ['setup'], roles: ['commissioner'], roleFix: COMMISSIONER_FIX },
  set_seat_type: { phases: ['setup'], roles: ['commissioner'], roleFix: COMMISSIONER_FIX },
  delete_league: { phases: ['setup'], roles: ['commissioner'], roleFix: COMMISSIONER_FIX },
  transfer_commissioner: { phases: ACTIVE, roles: ['commissioner'], roleFix: COMMISSIONER_FIX },
  configure_agent_seat: { phases: ACTIVE, roles: ['commissioner'], roleFix: COMMISSIONER_FIX },
  randomize_agent_seats: { phases: ['setup'], roles: ['commissioner'], roleFix: COMMISSIONER_FIX },
  leave_league: {
    phases: ['setup'],
    roles: ['member'],
    roleFix: 'Only a person who holds a seat in this league can leave it.',
    deny: {
      roles: ['commissioner'],
      message: 'The commissioner cannot leave the league.',
      fix: 'Hand the league to another member with transfer_commissioner first, or delete it with delete_league.'
    }
  },
  start_draft: { phases: ['setup'], roles: ['commissioner'], roleFix: COMMISSIONER_FIX },
  pause_draft: { phases: ['drafting'], roles: ['commissioner'], roleFix: COMMISSIONER_FIX },
  resume_draft: { phases: ['drafting'], roles: ['commissioner'], roleFix: COMMISSIONER_FIX },
  rename_team: {
    phases: ACTIVE,
    roles: ['member', 'agent', 'commissioner'],
    roleFix: 'Only a team owner, or the commissioner for teams without an owner, can rename a team.'
  },
  // Defaults for season operations other work streams add.
  make_draft_pick: { phases: ['drafting'], roles: PLAYERS, roleFix: PLAYER_FIX },
  set_draft_queue: { phases: ['setup', 'drafting'], roles: PLAYERS, roleFix: PLAYER_FIX },
  set_lineup: { phases: IN_SEASON, roles: PLAYERS, roleFix: PLAYER_FIX },
  drop_player: {
    phases: IN_SEASON,
    roles: PLAYERS,
    roleFix: PLAYER_FIX,
    flag: {
      name: 'waiversOpen',
      value: true,
      message: 'Roster moves are closed right now.',
      fix: 'Wait for waivers to open.'
    }
  },
  claim_waiver: {
    phases: IN_SEASON,
    roles: PLAYERS,
    roleFix: PLAYER_FIX,
    flag: {
      name: 'waiversOpen',
      value: true,
      message: 'Waivers are closed right now.',
      fix: 'Wait for waivers to open.'
    }
  },
  cancel_waiver_claim: { phases: IN_SEASON, roles: PLAYERS, roleFix: PLAYER_FIX },
  reorder_waiver_claims: { phases: IN_SEASON, roles: PLAYERS, roleFix: PLAYER_FIX },
  propose_trade: tradeRule(),
  counter_trade: tradeRule(),
  respond_to_trade: tradeRule(),
  withdraw_trade: { phases: IN_SEASON, roles: PLAYERS, roleFix: PLAYER_FIX },
  // A trade accepted before the deadline can still be under review when the playoffs start.
  vote_trade: {
    phases: IN_SEASON,
    roles: ['member', 'agent', 'commissioner'],
    roleFix: 'Only teams in this league (or the commissioner) can review trades.'
  },
  post_message: { phases: ALL, roles: ['member', 'agent', 'commissioner'], roleFix: PLAYER_FIX }
};

function tradeRule(): ActionRule {
  return {
    phases: ['regular_season'],
    roles: PLAYERS,
    roleFix: PLAYER_FIX,
    flag: {
      name: 'tradeDeadlinePassed',
      value: false,
      message: 'The trade deadline has passed.',
      fix: 'Trades are closed for the rest of the season; improve your roster through waivers instead.',
      code: 'TRADE_DEADLINE_PASSED'
    }
  };
}

/** Why `action` is not allowed right now, or null when it is. Unknown actions are never allowed. */
export function actionError(
  action: string,
  league: League,
  actor: Actor,
  now: Date,
  rules: Readonly<Record<string, ActionRule>> = ACTION_RULES
): ApiError | null {
  const rule = rules[action];
  if (rule === undefined) {
    return new ApiError('NOT_FOUND', `"${action}" is not a league action.`, {
      fix: 'Use one of the names in league.allowedActions.'
    });
  }
  const roles = actorRoles(actor);
  if (!roles.some((role) => rule.roles.includes(role))) {
    return new ApiError('FORBIDDEN', `You cannot call ${action} in this league.`, { fix: rule.roleFix });
  }
  if (rule.deny !== undefined && roles.some((role) => rule.deny?.roles.includes(role))) {
    return new ApiError('FORBIDDEN', rule.deny.message, { fix: rule.deny.fix });
  }
  if (!rule.phases.includes(league.phase)) return phaseError(action, league.phase, rule.phases);
  if (rule.flag !== undefined && phaseFlags(league, now)[rule.flag.name] !== rule.flag.value) {
    return new ApiError(rule.flag.code ?? 'PHASE_NOT_ALLOWED', rule.flag.message, {
      fix: rule.flag.fix,
      details: { phase: league.phase, flag: rule.flag.name }
    });
  }
  return null;
}

/** Throws the reason `action` is not allowed right now. */
export function assertAction(action: string, league: League, actor: Actor, now: Date): void {
  const error = actionError(action, league, actor, now);
  if (error !== null) throw error;
}

/** PHASE_NOT_ALLOWED with a fix that says whether to wait or that the moment has passed. */
export function phaseError(action: string, phase: LeaguePhase, allowed: readonly LeaguePhase[]): ApiError {
  const passed = allowed.every((p) => phaseIndex(p) < phaseIndex(phase));
  const list = allowed.join(', ');
  return new ApiError('PHASE_NOT_ALLOWED', `${action} is not allowed while the league is in "${phase}".`, {
    fix: passed
      ? `${action} is only possible while the league is in ${list}. This league has moved past that, so it can no longer be done.`
      : `Wait until the league is in one of: ${list}. The response's league.allowedActions lists what you can do now.`,
    details: { phase, allowedPhases: [...allowed] }
  });
}

/** League mutations with a rule that this caller may perform right now, sorted by name. */
export function allowedActions(league: League, actor: Actor, now: Date): string[] {
  return Object.keys(ACTION_RULES)
    .filter((name) => actionError(name, league, actor, now) === null)
    .sort();
}

/** The subset of an operation that decides whether it is a league action. */
export interface ActionOperation {
  name: string;
  mutation: boolean;
  pathParams: readonly string[];
  phases?: readonly LeaguePhase[];
}

/**
 * `allowedActions` limited to operations that exist, plus league mutations without a rule (from
 * other work streams) that pass their own `phases`. Outsiders get nothing.
 */
export function leagueAllowedActions(
  operations: readonly ActionOperation[],
  league: League,
  actor: Actor,
  now: Date
): string[] {
  if (isOutsider(actor)) return [];
  const ruled = new Set(allowedActions(league, actor, now));
  return operations
    .filter((op) => op.mutation && op.pathParams.includes('leagueId'))
    .filter((op) =>
      ACTION_RULES[op.name] === undefined
        ? op.phases === undefined || op.phases.includes(league.phase)
        : ruled.has(op.name)
    )
    .map((op) => op.name)
    .sort();
}
