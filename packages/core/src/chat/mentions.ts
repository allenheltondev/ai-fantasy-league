/**
 * Chat @mentions (issue #69). A mention is `@` followed by one of a team's names: the team name,
 * the manager's name, or the team id. Matching is case-insensitive and takes the longest name that
 * fits, so `@Big Tuna FC` beats `@Big Tuna` when both are teams. A name only counts when it ends at
 * a word boundary, and an `@` inside a word (an email address) is not a mention.
 */

export interface MentionTarget {
  teamId: string;
  /** Every name the team answers to. Blank names are ignored. */
  names: readonly string[];
}

export interface Mention {
  teamId: string;
  /** Index of the `@`. */
  start: number;
  /** Index just past the name. */
  end: number;
  /** The mention as written, including the `@`. */
  text: string;
}

const WORD = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD.test(ch);
}

/** Every mention in `text`, in order, never overlapping. */
export function findMentions(text: string, targets: readonly MentionTarget[]): Mention[] {
  const candidates = targets
    .flatMap((t) => t.names.map((name) => ({ teamId: t.teamId, name: name.trim().toLowerCase() })))
    .filter((c) => c.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const mentions: Mention[] = [];
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('@', i);
    if (at < 0) break;
    i = at + 1;
    if (isWordChar(text[at - 1])) continue;
    // Compare slice by slice: lower-casing the whole text can shift indexes for some scripts.
    const match = candidates.find(
      (c) =>
        text.slice(at + 1, at + 1 + c.name.length).toLowerCase() === c.name &&
        !isWordChar(text[at + 1 + c.name.length])
    );
    if (match === undefined) continue;
    const end = at + 1 + match.name.length;
    mentions.push({ teamId: match.teamId, start: at, end, text: text.slice(at, end) });
    i = end;
  }
  return mentions;
}

/** The distinct teams mentioned in `text`, in first-mention order. */
export function mentionedTeamIds(text: string, targets: readonly MentionTarget[]): string[] {
  return [...new Set(findMentions(text, targets).map((m) => m.teamId))];
}
