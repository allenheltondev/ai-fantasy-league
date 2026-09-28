import type { MentionTarget } from '@fantasy/core';
import type { ChatMessage } from '../../chat/model.js';
import type { Actor } from '../../league/phase.js';
import type { Team } from '../../repos/types.js';

/** Every name a team answers to in chat: the team name, its manager, and its id. */
export function mentionTargets(teams: readonly Team[]): MentionTarget[] {
  return teams.map((team) => ({
    teamId: team.id,
    names: [team.name, team.ownerName ?? '', team.id]
  }));
}

/**
 * How the caller appears in chat. Only called after `requireMember`, so the caller is a person
 * (the commissioner or a seat holder) or one of the league's agents playing its team.
 */
export function chatAuthor(actor: Actor): Pick<ChatMessage, 'kind' | 'author'> {
  if (actor.kind === 'agent') {
    const team = actor.team as Team;
    return { kind: 'agent', author: { teamId: team.id, teamName: team.name, name: team.name } };
  }
  const user = actor as Extract<Actor, { kind: 'user' }>;
  return {
    kind: 'user',
    author: { teamId: user.team?.id ?? null, teamName: user.team?.name ?? null, name: user.name }
  };
}
