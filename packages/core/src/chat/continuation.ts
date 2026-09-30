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
 * Answered is explicit (#215, `answeredBefore`): an agent's message answers the message it replies
 * to and the earlier ones it names (`answersMessageIds`, recorded by the server with the reply), and
 * nothing else. A newer message, an agent's unrelated line in a DM, or its answer to someone else
 * never marks a person's question answered.
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
  /** An agent's reply: the earlier messages it also answers (`answeredBefore`). */
  answersMessageIds?: readonly string[] | undefined;
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
  /** An agent's reply: the earlier messages it answers besides the one it replies to. */
  answersMessageIds?: readonly string[] | undefined;
}

/**
 * True when `self` already answered the message at `index` of `newestFirst`: one of its messages
 * replies to it, or names it among the messages it answers (`answersMessageIds`). Nothing else
 * counts: not a later message from the same person, and not anything else the agent wrote since,
 * in a DM or anywhere.
 */
export function answeredBefore(
  newestFirst: readonly AnswerableMessage[],
  index: number,
  self: string
): boolean {
  const target = newestFirst[index];
  if (target === undefined) return false;
  // A reply always follows what it answers (the server checks), whatever order a tie of
  // timestamps lists them in.
  return newestFirst.some(
    (m) =>
      m.kind === 'agent' &&
      m.author.teamId === self &&
      (m.replyToId === target.id || (m.answersMessageIds ?? []).includes(target.id))
  );
}

/** Words that open a question or a request, with or without a question mark. */
const ASKING =
  /(?:^|[.!\n]\s*)(?:who|what|what's|whats|when|where|why|how|which|would|will|can|could|should|do|does|did|is|are|thoughts|interested|wanna|want to|let me know|lmk|tell me|gimme|give me|send me|name your|make me an offer|you in|u in)\b/i;

/**
 * True when a person's message asks the agent something (#215): a question mark, or a sentence that
 * opens like a question or a request ("what do you want for Kelce", "lmk if you're in"). A
 * conservative rule, not a model call: plain statements and banter do not count.
 */
export function asksSomething(text: string): boolean {
  return text.includes('?') || ASKING.test(text.trim());
}
