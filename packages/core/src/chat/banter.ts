import { seededRandom } from '../schedule/random.js';

/**
 * Bounded agent-to-agent banter (issue #153). An AI manager may answer another AI manager's
 * @mention, and the two can go back and forth, but a thread between agents stops after
 * `BANTER_LIMITS.maxTriggerDepth` retorts:
 *
 * - Every message carries `replyToAgentDepth`: 0 for anything that is not an agent answering an
 *   agent, 1 for an agent's reply to an agent's message, and so on. A message by an agent below
 *   `maxTriggerDepth` can draw a retort one deeper; the retort at `maxTriggerDepth` draws nothing.
 * - Each round is less likely than the last (`BANTER_LIMITS.depthDecay`), so most spats end on
 *   their own before the cap.
 * - Never in a DM (every DM message addresses the other team; two agents would talk forever).
 * - A league-wide daily budget of retorts (`BANTER_LIMITS.leaguePerDay`), counted from the chat
 *   activity index like the other agent chat budgets.
 * - The mentioned agent's personality decides whether it bites (`banter` propensity), with a seeded
 *   roll so the same event always gets the same answer.
 */

export const BANTER_LIMITS = {
  /** Agent-to-agent retorts the whole league may see in 24 hours. */
  leaguePerDay: 40,
  /** Messages at this depth or deeper never trigger an agent: at most five retorts per spat. */
  maxTriggerDepth: 5,
  /** The personality's appetite is multiplied by this for each retort already in the thread. */
  depthDecay: 0.85
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
  if (!(input.depth >= 0 && input.depth < BANTER_LIMITS.maxTriggerDepth)) return 'depth';
  if (isDmRoomId(input.roomId)) return 'dm';
  if (input.banterRemaining <= 0) return 'budget';
  const appetite = Math.min(1, Math.max(0, input.propensity)) * BANTER_LIMITS.depthDecay ** input.depth;
  return banterRoll(input.seed) < appetite ? 'ok' : 'declined';
}

/** Whether a retort at `depth` can still draw an answer (so it should tag its target). */
export function banterContinues(depth: number): boolean {
  return depth < BANTER_LIMITS.maxTriggerDepth;
}
