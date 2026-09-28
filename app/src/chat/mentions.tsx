import { useId, useState, type ReactNode } from 'react';
import { AgentAvatar, hashSeed } from '../components/AgentAvatar';
import { initials } from '../features/home/TeamBadge';
import type { ChatTeam } from './api';

/**
 * Who you can talk to in chat (#177): the teams a message may @mention, shown by their manager
 * (a person, or an AI manager with its avatar and personality), and the mentions in messages.
 */

const MAX_SUGGESTIONS = 8;

/** An AI manager plays this team (#159). Older team lists only say so through the avatar seed. */
export function isAiManaged(team: ChatTeam): boolean {
  return team.ai ?? team.avatarSeed !== undefined;
}

/** Who manages the team: the person or the AI manager, else the team itself. */
export function managerName(team: ChatTeam): string {
  const name = team.ownerName?.trim() ?? '';
  return name.length > 0 ? name : team.name;
}

/**
 * The name a mention of `team` is written with: `@<Manager Name>`, which the server resolves to the
 * team (#161). The team name stands in when the manager's name would also match another team.
 */
export function mentionName(team: ChatTeam, teams: readonly ChatTeam[]): string {
  const name = managerName(team);
  const lower = name.toLowerCase();
  const taken = teams.some(
    (t) =>
      t.id !== team.id &&
      (t.name.toLowerCase() === lower || (t.ownerName ?? '').trim().toLowerCase() === lower)
  );
  return taken ? team.name : name;
}

/** AI managers first, otherwise in the league's order. */
function aiFirst(teams: readonly ChatTeam[]): ChatTeam[] {
  return [...teams].sort((a, b) => Number(isAiManaged(b)) - Number(isAiManaged(a)));
}

/** `query` starts `text` or one of its words. */
function startsAWord(text: string | null | undefined, query: string): boolean {
  return ` ${(text ?? '').toLowerCase()}`.includes(` ${query}`);
}

/**
 * Teams whose manager, team name, or personality starts (a word) with what was typed; AI managers
 * first when nothing is typed yet. A name typed in full needs no suggestion.
 */
export function suggestTeams(teams: readonly ChatTeam[], query: string): ChatTeam[] {
  const q = query.toLowerCase();
  const typed = q.trimEnd();
  const matches = teams
    .filter((t) => t.name.toLowerCase() !== typed && managerName(t).toLowerCase() !== typed)
    .filter((t) => startsAWord(managerName(t), q) || startsAWord(t.name, q) || startsAWord(t.personality, q));
  return (q.length === 0 ? aiFirst(matches) : matches).slice(0, MAX_SUGGESTIONS);
}

/** Who may be mentioned in a room, AI managers first: in a DM, only the other team. */
export function roomMembers(
  teams: readonly ChatTeam[],
  room: { kind: string; teamIds: readonly string[] },
  yourTeamId: string | null
): ChatTeam[] {
  if (room.kind !== 'dm') return aiFirst(teams);
  return teams.filter((t) => room.teamIds.includes(t.id) && t.id !== yourTeamId);
}

const TONES = [
  'bg-primary-100 text-primary-800',
  'bg-success-100 text-success-800',
  'bg-warning-100 text-warning-800',
  'bg-secondary-100 text-secondary-800'
] as const;

/** An AI manager's avatar, or a person's initials. Decorative: the name is always beside it. */
export function TeamFace({ team, size = 20 }: { team: ChatTeam; size?: number }) {
  if (team.avatarSeed !== undefined) {
    return (
      <span aria-hidden="true" className="inline-flex shrink-0">
        <AgentAvatar seed={team.avatarSeed} label="" size={size} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-testid="initials-avatar"
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.42)) }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${
        TONES[hashSeed(team.id) % TONES.length]
      }`}
    >
      {initials(managerName(team))}
    </span>
  );
}

/** The "AI" badge, with the personality the manager plays. */
export function AiBadge({ team }: { team: ChatTeam }) {
  if (!isAiManaged(team)) return null;
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1 text-xs">
      <span className="rounded bg-primary-100 px-1 font-medium text-primary-800">AI</span>
      {team.personality ? <span className="truncate text-muted-foreground">{team.personality}</span> : null}
    </span>
  );
}

/** How a team reads to a screen reader: "Marcus Hale, Robo Ballers, AI manager, The Spreadsheet". */
export function describeTeam(team: ChatTeam): string {
  const who = managerName(team);
  const parts = [who, ...(who === team.name ? [] : [team.name])];
  if (isAiManaged(team)) parts.push('AI manager', ...(team.personality ? [team.personality] : []));
  return parts.join(', ');
}

/** Every name a team answers to in chat, as the server matches them. */
function namesOf(team: ChatTeam): string[] {
  return [team.name, team.ownerName ?? '', team.id].filter((n) => n.trim().length > 0);
}

/** Wraps @mentions of known teams (by name, manager, or id) in a mark that names the manager. */
export function highlightMentions(text: string, teams: readonly ChatTeam[]): ReactNode[] {
  const byName = new Map<string, ChatTeam>();
  for (const team of teams) {
    for (const name of namesOf(team)) {
      if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), team);
    }
  }
  const names = [...byName.keys()]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (names.length === 0) return [text];
  const pattern = new RegExp(`(@(?:${names.join('|')}))(?![\\p{L}\\p{N}_])`, 'giu');
  return text
    .split(pattern)
    .map((part, i) =>
      i % 2 === 1 ? (
        <MentionMark key={i} text={part} team={byName.get(part.slice(1).toLowerCase()) as ChatTeam} />
      ) : (
        part
      )
    );
}

/** A highlighted mention: hover or focus it to see who it reaches. */
function MentionMark({ text, team }: { text: string; team: ChatTeam }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <strong
        tabIndex={0}
        data-team-id={team.id}
        aria-describedby={open ? id : undefined}
        className="rounded font-semibold text-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        {text}
      </strong>
      {open ? (
        <span
          id={id}
          role="tooltip"
          className="absolute bottom-full left-0 z-10 mb-1 flex w-max max-w-[16rem] items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-sm font-normal text-foreground shadow"
        >
          <TeamFace team={team} size={24} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{managerName(team)}</span>
            <span className="flex min-w-0 items-baseline gap-1">
              {managerName(team) === team.name ? null : (
                <span className="truncate text-xs text-muted-foreground">{team.name}</span>
              )}
              <AiBadge team={team} />
            </span>
          </span>
        </span>
      ) : null}
    </span>
  );
}
