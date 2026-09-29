import type { SocialActBook } from '@fantasy/core';
import { seatTenureStart, type Services } from '@fantasy/server';

/**
 * The agent's social-act history (#218; the selector and its rules are core `social-acts.ts`, ADR
 * 008): one bounded row per league, agent, and seat tenure, written with the same revision check
 * as the agenda and commitments, so a new occupant starts with none and two tasks writing at once
 * both land. Operational state: it never reaches a prompt or memory.
 */
export interface SocialActAccess {
  /** The current occupant's tenure; null when the seat is no longer an agent's. */
  tenure(): Promise<string | null>;
  read(tenure: string): Promise<SocialActBook>;
  update(tenure: string, change: (book: SocialActBook) => SocialActBook): Promise<SocialActBook>;
}

export function socialActAccess(
  services: Services,
  leagueId: string,
  agentId: string,
  teamId: string
): SocialActAccess {
  const { agents } = services.repos;
  return {
    async tenure() {
      const team = await services.repos.teams.get(leagueId, teamId);
      return team?.seatType === 'agent' ? seatTenureStart(team) : null;
    },
    read: (tenure) => agents.getSocialActs(leagueId, agentId, tenure),
    update: (tenure, change) => agents.updateSocialActs(leagueId, agentId, tenure, change)
  };
}
