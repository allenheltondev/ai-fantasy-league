/**
 * Who is calling. Humans are `user` principals built only from a verified Cognito
 * ID token. Agents are `agent` principals created in-process by the agent runtime;
 * nothing on the HTTP path can produce one.
 */

export interface UserPrincipal {
  readonly type: 'user';
  readonly sub: string;
  readonly email: string | null;
  readonly name: string;
}

export interface AgentPrincipal {
  readonly type: 'agent';
  readonly agentId: string;
  readonly teamId: string;
  readonly leagueId: string;
}

export interface AnonymousPrincipal {
  readonly type: 'anonymous';
}

export type Principal = UserPrincipal | AgentPrincipal | AnonymousPrincipal;

export const ANONYMOUS: AnonymousPrincipal = Object.freeze({ type: 'anonymous' });

/** Called by the agent runtime (never by an HTTP adapter). */
export function agentPrincipal(input: { agentId: string; teamId: string; leagueId: string }): AgentPrincipal {
  return Object.freeze({
    type: 'agent',
    agentId: input.agentId,
    teamId: input.teamId,
    leagueId: input.leagueId
  });
}

/** A stable string for keys and audit rows: `user#<sub>`, `agent#<agentId>`, or `anonymous`. */
export function principalKey(principal: Principal): string {
  switch (principal.type) {
    case 'user':
      return `user#${principal.sub}`;
    case 'agent':
      return `agent#${principal.agentId}`;
    case 'anonymous':
      return 'anonymous';
  }
}
