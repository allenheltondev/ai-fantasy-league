import { seededRandom } from '../schedule/random.js';

/**
 * Bounded agent-to-agent banter (issue #153). An AI manager may answer another AI manager's
 * @mention, but a thread between agents never grows past one retort:
 *
 * - Every message carries `replyToAgentDepth`: 0 for anything that is not an agent answering an
 *   agent, 1 for an agent's reply to an agent's message, and so on. Only a depth-0 message by an
 *   agent can draw an agent's retort, and that retort is depth 1, which draws nothing.
 * - Never in a DM (every DM message addresses the other team; two agents would talk forever).
 * - A league-wide daily budget of retorts (`BANTER_LIMITS.leaguePerDay`), counted from the chat
 *   activity index like the other agent chat budgets.
 * - The mentioned agent's personality decides whether it bites (`banter` propensity), with a seeded
 *   roll so the same event always gets the same answer.
 */

export const BANTER_LIMITS = {
  /** Agent-to-agent retorts the whole league may see in 24 hours. */
  leaguePerDay: 6,
  /** Messages at this depth or deeper never trigger an agent. */
  maxTriggerDepth: 1
} as const;

/** The agent-thread depth of a new message, from the message it replies to (null: not a reply). */
export function replyToAgentDepth(
  authorKind: string,
  repliedTo: { kind: string; replyToAgentDepth?: number | undefined } | null
): number {
  if (authorKind !== 'agent' || repliedTo === null || repliedTo.kind !== 'agent') return 0;
  return (repliedTo.replyToAgentDepth ?? 0) + 1;
}

/** True for a direct-message room id (`dm-<teamA>-<teamB>`); no other room id starts with `dm-`. */
export function isDmRoomId(roomId: string): boolean {
  return roomId.startsWith('dm-');
}

/** A deterministic roll in [0, 1) for a seed (the event and the team). */
export function banterRoll(seed: string): number {
  return seededRandom(`banter:${seed}`)();
}

export type BanterVerdict = 'ok' | 'depth' | 'dm' | 'budget' | 'declined';

export interface BanterInput {
  /** `replyToAgentDepth` of the agent's message that mentioned this agent. */
  depth: number;
  roomId: string;
  /** Retorts the league may still post today (`banterRemaining`). */
  banterRemaining: number;
  /** The mentioned agent's banter propensity, 0-1. */
  propensity: number;
  /** Seeds the roll: the event id and the mentioned team. */
  seed: string;
}

/** Whether a mentioned agent answers another agent, and if not, why. Checks run cheapest first. */
export function banterVerdict(input: BanterInput): BanterVerdict {
  if (!(input.depth === 0)) return 'depth';
  if (isDmRoomId(input.roomId)) return 'dm';
  if (input.banterRemaining <= 0) return 'budget';
  return banterRoll(input.seed) < Math.min(1, Math.max(0, input.propensity)) ? 'ok' : 'declined';
}
