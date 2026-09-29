import { isGenericTeamName, type LeagueSettings, type NameSetBy } from '@fantasy/core';
import type { Team, TeamRename } from '../repos/types.js';

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
    nameSetBy: input.owner === undefined ? 'default' : 'owner',
    seatType: input.owner === undefined ? 'agent' : 'human',
    ownerUserId: input.owner?.userId ?? null,
    ownerName: input.owner?.name ?? null,
    agentConfigId: null,
    draftSlot: input.draftSlot,
    faabRemaining: input.settings.waivers.faabBudget,
    waiverPriority: input.draftSlot,
    roster: [],
    occupiedSince: at,
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
    nameSetBy: 'owner',
    // A new person plays the seat: the team's earlier DMs are not theirs.
    occupiedSince: now.toISOString(),
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
    nameSetBy: 'default',
    // An agent takes over: the person's DMs stay with the person.
    occupiedSince: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

/** Case- and space-insensitive name comparison, so "The Champs" and "the  champs" collide. */
export function sameTeamName(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

/** Renames a team keeps (#194): the newest, for the team page and the move board. */
export const TEAM_RENAME_HISTORY = 10;

/**
 * Who set the team's name. Teams stored before it was tracked: a generic name is the default, any
 * other name on a team a person holds is the owner's, and on a seat nobody holds it is left open
 * (`default`) for the AI manager.
 */
export function teamNameSetBy(team: Pick<Team, 'nameSetBy' | 'name' | 'ownerUserId'>): NameSetBy {
  if (team.nameSetBy !== undefined) return team.nameSetBy;
  return team.ownerUserId !== null && !isGenericTeamName(team.name) ? 'owner' : 'default';
}

/** The team under its new name, with who set it and the rename recorded. */
export function renamedTeam(team: Team, rename: Omit<TeamRename, 'from'>, nameSetBy: NameSetBy): Team {
  if (rename.to === team.name) return { ...team, nameSetBy };
  const renames = [...(team.renames ?? []), { from: team.name, ...rename }].slice(-TEAM_RENAME_HISTORY);
  return { ...team, name: rename.to, nameSetBy, renames };
}

/** The name the team had before its last rename, or null when it never was renamed. */
export function renamedFrom(team: Pick<Team, 'renames'>): string | null {
  return team.renames?.at(-1)?.from ?? null;
}
