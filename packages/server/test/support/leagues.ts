import { yahooDefaultSettings } from '@fantasy/core';
import { newTeam } from '../../src/league/seats.js';
import { hashInviteToken } from '../../src/league/tokens.js';
import type { Invite, League, Repos, Team } from '../../src/repos/types.js';
import { league as leagueFixture, START } from './harness.js';

/** Test users. `signIdToken({ sub })` signs in as each. */
export const ALICE = { sub: 'alice', name: 'Alice', email: 'alice@example.com' };
export const BOB = { sub: 'bob', name: 'Bob', email: 'bob@example.com' };
export const CAROL = { sub: 'carol', name: 'Carol', email: 'carol@example.com' };

export interface SeededLeague {
  league: League;
  teams: Team[];
}

/**
 * Writes a league straight to the repositories: `owners[i]` holds seat i+1 (null leaves it an agent
 * seat), and the first owner is the commissioner.
 */
export async function seedLeague(
  repos: Repos,
  options: {
    id: string;
    owners: readonly ({ sub: string; name: string } | null)[];
    teamCount?: number;
    overrides?: Partial<League>;
  }
): Promise<SeededLeague> {
  const teamCount = options.teamCount ?? 8;
  const settings = yahooDefaultSettings(teamCount);
  const commissioner = options.owners[0] ?? { sub: 'nobody', name: 'Nobody' };
  const league = leagueFixture({
    id: options.id,
    settings,
    commissionerId: commissioner.sub,
    commissionerName: commissioner.name,
    createdBy: commissioner.sub,
    ...options.overrides
  });
  const now = new Date(START);
  const teams: Team[] = [];
  for (let slot = 1; slot <= teamCount; slot++) {
    const owner = options.owners[slot - 1] ?? null;
    teams.push(
      newTeam({
        leagueId: league.id,
        id: `team-${slot}`,
        draftSlot: slot,
        settings,
        now,
        ...(owner === null
          ? {}
          : { owner: { userId: owner.sub, name: owner.name, teamName: `${owner.name}'s Team` } })
      })
    );
  }
  await repos.teams.create(teams);
  for (const team of teams) {
    if (team.ownerUserId !== null) {
      await repos.members.add({
        leagueId: league.id,
        userId: team.ownerUserId,
        teamId: team.id,
        joinedAt: START
      });
    }
  }
  await repos.leagues.create(league);
  return { league, teams };
}

export async function seedInvite(
  repos: Repos,
  leagueId: string,
  token: string,
  overrides: Partial<Invite> = {}
): Promise<Invite> {
  const invite: Invite = {
    id: `inv-${hashInviteToken(token).slice(0, 12)}`,
    leagueId,
    tokenHash: hashInviteToken(token),
    email: null,
    maxUses: 1,
    uses: 0,
    expiresAt: '2026-09-17T12:00:00.000Z',
    revokedAt: null,
    createdBy: 'alice',
    createdAt: START,
    version: 1,
    ...overrides
  };
  await repos.invites.create(invite);
  return invite;
}

/** A well-formed token (22+ URL-safe characters) with a readable prefix. */
export const token = (label: string) => `${label}-${'x'.repeat(Math.max(0, 24 - label.length))}`;
