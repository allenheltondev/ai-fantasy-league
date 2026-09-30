/**
 * Conversation continuity: a person going back and forth with an AI manager does not have to
 * @tag it on every message. A person's message in a room that is not a DM, with no @mention at
 * all, is addressed to AI manager X (`continuationAddressee`) when:
 *
 * - X's message is the newest message in the room aimed at this person (a reply to one of their
 *   messages, or a mention of them; an agent's answer to a mention is a reply), and it was posted
 *   within `CONTINUATION_LIMITS.windowMs`;
 * - nobody has taken the conversation over since: the person has addressed nobody but X, nobody
 *   else has addressed X, and X has not turned to anyone else.
 *
 * Anything less certain infers nothing: an explicit mention always wins (and any mention at all
 * means no inference), agents never get implicit addressing (agent-to-agent banter stays
 * mention-only), and a DM already addresses the other team. The inferred addressee is carried apart
 * from the message's mentions, which stay the @mentions actually written.
 *
 * A reply covers everything its person said before it (`answeredBefore`): when an agent answers
 * the newest of a burst of messages, the earlier ones are answered too, so neither a reply nor a
 * check-in's hand-off answers them again.
 */

export const CONTINUATION_LIMITS = {
  /** How long an AI manager's last word to a person keeps their conversation open. */
  windowMs: 10 * 60_000,
  /** The room's newest messages read to find the exchange. */
  lookback: 30
} as const;

/** What the rules read of a message. */
export interface ContinuationMessage {
  id: string;
  kind: string;
  author: { teamId: string | null };
  mentionedTeamIds: readonly string[];
  /** The addressee inferred for a message with no mention (this rule, applied when it was posted). */
  addressedTeamIds?: readonly string[] | undefined;
  replyToId?: string | null | undefined;
  createdAt: string;
}

export interface ContinuationInput {
  /** The new message's author. */
  author: { kind: string; teamId: string | null };
  /** Teams the new message @mentions. */
  mentioned: readonly string[];
  /** Whether the room is a DM (every DM message already addresses the other team). */
  dm: boolean;
  /** The room's newest messages before the new one, newest first. */
  recent: readonly ContinuationMessage[];
  /** When the new message is posted. */
  now: string;
}

/**
 * The teams a message is aimed at: its mentions, its inferred addressee, and the author of the
 * message it replies to (when that is among `byId`), never its own author.
 */
export function aimedAt(
  message: ContinuationMessage,
  byId: ReadonlyMap<string, ContinuationMessage>
): string[] {
  const repliedTo =
    message.replyToId === undefined || message.replyToId === null
      ? null
      : (byId.get(message.replyToId)?.author.teamId ?? null);
  const ids = [
    ...message.mentionedTeamIds,
    ...(message.addressedTeamIds ?? []),
    ...(repliedTo === null ? [] : [repliedTo])
  ].filter((id) => id !== message.author.teamId);
  return [...new Set(ids)];
}

/** The AI manager a person's unmentioned message continues a conversation with, or null. */
export function continuationAddressee(input: ContinuationInput): string | null {
  const person = input.author.teamId;
  if (input.author.kind !== 'user' || person === null || input.dm || input.mentioned.length > 0) return null;
  const byId = new Map(input.recent.map((m) => [m.id, m]));
  const aims = input.recent.map((m) => (m.kind === 'system' ? [] : aimedAt(m, byId)));
  // The newest message someone else aimed at this person opens the exchange.
  const opened = input.recent.findIndex((m, i) => m.author.teamId !== person && aims[i]?.includes(person));
  const opener = input.recent[opened];
  if (opener === undefined || opener.kind !== 'agent' || opener.author.teamId === null) return null;
  if (Date.parse(opener.createdAt) < Date.parse(input.now) - CONTINUATION_LIMITS.windowMs) return null;
  const agent = opener.author.teamId;
  // Since then: the person addressed only the agent, nobody else addressed the agent, and the
  // agent turned to nobody else.
  const takenOver = input.recent.slice(0, opened).some((m, i) => {
    const aimed = aims[i] ?? [];
    if (m.author.teamId === person) return aimed.some((id) => id !== agent);
    if (m.author.teamId === agent) return aimed.length > 0;
    return aimed.includes(agent);
  });
  return takenOver ? null : agent;
}

/** What `answeredBefore` reads of a message. */
export interface AnswerableMessage {
  id: string;
  kind: string;
  author: { teamId: string | null };
  replyToId?: string | null | undefined;
}

/**
 * True when `self` already answered the message at `index` of `newestFirst`: one of its messages
 * replies to it, or to a later message by the same person (a reply covers everything its person
 * said before it, so a burst gets one answer), or, in a DM, it wrote anything since.
 */
export function answeredBefore(
  newestFirst: readonly AnswerableMessage[],
  index: number,
  self: string,
  dm: boolean
): boolean {
  const target = newestFirst[index];
  if (target === undefined) return false;
  const person = target.kind === 'user' ? target.author.teamId : null;
  const place = new Map(newestFirst.map((m, i) => [m.id, i]));
  return newestFirst.some((m, i) => {
    if (m.kind !== 'agent' || m.author.teamId !== self) return false;
    if (m.replyToId === target.id || (dm && i < index)) return true;
    if (person === null || m.replyToId === undefined || m.replyToId === null) return false;
    const at = place.get(m.replyToId);
    return at !== undefined && at < index && newestFirst[at]?.author.teamId === person;
  });
}
