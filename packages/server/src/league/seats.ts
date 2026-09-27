import type { LeagueSettings } from '@fantasy/core';
import type { Team } from '../repos/types.js';

/** Seats: creation, the order open seats are claimed in, and giving a seat back to an agent. */

export function defaultTeamName(draftSlot: number): string {
  return `Team ${draftSlot}`;
}

export function isOpenSeat(team: Team): boolean {
  return team.ownerUserId === null;
}

/** `team-1`, `team-2`, ...: the next number no team uses. */
export function nextTeamId(teams: readonly Pick<Team, 'id'>[]): string {
  const used = new Set(teams.map((t) => t.id));
  let n = teams.length + 1;
  while (used.has(`team-${n}`)) n++;
  return `team-${n}`;
}

export function newTeam(input: {
  leagueId: string;
  id: string;
  draftSlot: number;
  settings: LeagueSettings;
  now: Date;
  owner?: { userId: string; name: string; teamName: string };
}): Team {
  const at = input.now.toISOString();
  return {
    id: input.id,
    leagueId: input.leagueId,
    name: input.owner?.teamName ?? defaultTeamName(input.draftSlot),
    seatType: input.owner === undefined ? 'agent' : 'human',
    ownerUserId: input.owner?.userId ?? null,
    ownerName: input.owner?.name ?? null,
    agentConfigId: null,
    draftSlot: input.draftSlot,
    faabRemaining: input.settings.waivers.faabBudget,
    waiverPriority: input.draftSlot,
    roster: [],
    createdAt: at,
    updatedAt: at,
    version: 1
  };
}

/** Seats a joining person can take: open human seats first (they were kept for invitees), then agent seats. */
export function claimableSeats(teams: readonly Team[]): Team[] {
  return teams
    .filter(isOpenSeat)
    .sort(
      (a, b) =>
        Number(b.seatType === 'human') - Number(a.seatType === 'human') ||
        a.draftSlot - b.draftSlot ||
        a.id.localeCompare(b.id)
    );
}

export function claimSeat(
  team: Team,
  owner: { userId: string; name: string },
  teamName: string,
  now: Date
): Team {
  return {
    ...team,
    seatType: 'human',
    ownerUserId: owner.userId,
    ownerName: owner.name,
    agentConfigId: null,
    name: teamName,
    updatedAt: now.toISOString()
  };
}

/** A person left or was removed: the seat goes back to an agent under its default name. */
export function vacateSeat(team: Team, now: Date): Team {
  return {
    ...team,
    seatType: 'agent',
    ownerUserId: null,
    ownerName: null,
    name: defaultTeamName(team.draftSlot),
    updatedAt: now.toISOString()
  };
}

/** Case- and space-insensitive name comparison, so "The Champs" and "the  champs" collide. */
export function sameTeamName(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}
