import type { MentionTarget } from '@fantasy/core';
import type { ChatMessage } from '../../chat/model.js';
import type { ManagerLookup } from '../../league/managers.js';
import type { Actor } from '../../league/phase.js';
import type { Team } from '../../repos/types.js';

/** Every name a team answers to in chat: the team name, its manager (person or AI), and its id. */
export function mentionTargets(teams: readonly Team[], managers?: ManagerLookup): MentionTarget[] {
  return teams.map((team) => ({
    teamId: team.id,
    names: [team.name, team.ownerName ?? managers?.get(team.id)?.name ?? '', team.id]
  }));
}

/**
 * How the caller appears in chat. Only called after `requireMember`, so the caller is a person
 * (the commissioner or a seat holder) or one of the league's agents playing its team.
 */
export function chatAuthor(actor: Actor, managers?: ManagerLookup): Pick<ChatMessage, 'kind' | 'author'> {
  if (actor.kind === 'agent') {
    const team = actor.team as Team;
    const manager = managers?.get(team.id);
    return {
      kind: 'agent',
      author:
        manager === undefined
          ? { teamId: team.id, teamName: team.name, name: team.name }
          : { teamId: team.id, teamName: team.name, name: manager.name, avatarSeed: manager.avatarSeed }
    };
  }
  const user = actor as Extract<Actor, { kind: 'user' }>;
  return {
    kind: 'user',
    author: { teamId: user.team?.id ?? null, teamName: user.team?.name ?? null, name: user.name }
  };
}
