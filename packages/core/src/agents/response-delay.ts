import { z } from 'zod';
import { seededRandom } from '../schedule/random.js';

/**
 * Human-like response delays (issue #189). A person does not answer a trade offer the instant it
 * lands, so an AI manager waits a little before it acts on a trigger: a right-skewed (log-normal)
 * delay sized by the kind of event, scaled by the difficulty's `responseDelay.multiplier`, with a
 * chance (`immediateChance`) of answering right away. Stronger tiers are sharper and quicker.
 *
 * The delay never runs into a deadline: it is clamped to a share of the time left before one (a
 * trade offer's `expiresAt`, the waiver run, the next lineup lock, the pick clock), so a delayed
 * agent still answers in time. The roll is seeded by `(eventId, teamId)`, so a replayed or
 * redelivered event gets the same delay.
 *
 * Pure: the router passes `now`; nothing here reads a clock.
 */

/** The difficulty lever: how slow an agent is, and how often it answers at once. */
export const ResponseDelayLeverSchema = z.strictObject({
  /** Scales the class's median and cap: 1 is a typical manager, 0 always answers at once. */
  multiplier: z.number().min(0).max(5),
  /** Chance (0-1) of answering with no delay at all. */
  immediateChance: z.number().min(0).max(1)
});
export type ResponseDelayLever = z.infer<typeof ResponseDelayLeverSchema>;

/** No delay at all: what the router uses when delays are turned off (local dev, e2e, the sim). */
export const IMMEDIATE_RESPONSE: ResponseDelayLever = { multiplier: 0, immediateChance: 1 };

export const RESPONSE_DELAY_CLASSES = ['trade', 'roster', 'deadline', 'post_draft'] as const;
export type ResponseDelayClass = (typeof RESPONSE_DELAY_CLASSES)[number];

export interface ResponseDelayProfile {
  /** Median delay before the multiplier. */
  medianMs: number;
  /** Longest delay before the multiplier. */
  capMs: number;
  /** At most this share of the time left before a deadline (leaves the task room to run). */
  deadlineShare: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * Base median and cap per event class, before the multiplier.
 *
 * - trade: Trade Proposed / Countered. Clamped to half the time left before `expiresAt`.
 * - roster: Waiver Window Opened, Player News Alert, Player Status Changed, Week Rolled Over,
 *   Manager Check-In (clamped to half the time before the next check-in).
 *   Clamped to half the time left before the waiver run or the next lineup lock.
 * - deadline: Draft Turn Started: a short think time, at most 40% of the pick clock. Without a
 *   deadline the class is immediate (Lineup Lock Approaching and Trade Accepted never wait).
 * - post_draft: jitter added on top of the post-draft kickoff stagger.
 */
export const RESPONSE_DELAY_PROFILES: Readonly<Record<ResponseDelayClass, ResponseDelayProfile>> = {
  trade: { medianMs: 45 * MINUTE, capMs: 8 * HOUR, deadlineShare: 0.5 },
  roster: { medianMs: 90 * MINUTE, capMs: 12 * HOUR, deadlineShare: 0.5 },
  deadline: { medianMs: 5 * SECOND, capMs: 2 * MINUTE, deadlineShare: 0.4 },
  post_draft: { medianMs: 10 * SECOND, capMs: 40 * SECOND, deadlineShare: 0.5 }
};

/** Spread of the log-normal: a σ of 1 puts about a sixth of the delays past 2.7× the median. */
const SIGMA = 1;

export interface ResponseDelayInput {
  eventClass: ResponseDelayClass;
  /** The seed: `${eventId}:${teamId}`, so a replayed event gets the same delay. */
  seed: string;
  lever: ResponseDelayLever;
  now: Date;
  /** The latest the task may start by (null or absent: no deadline besides the cap). */
  deadline?: Date | string | null;
}

export interface ResponseDelay {
  /** Milliseconds to wait before the task runs; 0 runs it right away. */
  delayMs: number;
  /** Why it came out as it did: the immediate roll, the cap, the deadline clamp, or a plain sample. */
  reason: 'immediate' | 'sampled' | 'capped' | 'deadline';
}

/** A standard normal from two uniforms (Box-Muller). */
function normal(random: () => number): number {
  const u = Math.max(random(), Number.MIN_VALUE);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** The most a delay may be before `deadline`: its class's share of the time left, never below 0. */
export function deadlineLimitMs(
  eventClass: ResponseDelayClass,
  now: Date,
  deadline: Date | string | null | undefined
): number {
  if (deadline === undefined || deadline === null) return Number.POSITIVE_INFINITY;
  const at = typeof deadline === 'string' ? Date.parse(deadline) : deadline.getTime();
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((at - now.getTime()) * RESPONSE_DELAY_PROFILES[eventClass].deadlineShare));
}

/**
 * How long an agent waits before acting on a trigger. Always in [0, cap × multiplier], never past
 * the deadline clamp, and the same for the same seed. The `deadline` class is immediate unless a
 * deadline (the pick clock) bounds it.
 */
export function responseDelay(input: ResponseDelayInput): ResponseDelay {
  const { eventClass, lever } = input;
  const random = seededRandom(`response-delay:${input.seed}`);
  const noDeadline = input.deadline === undefined || input.deadline === null;
  if (random() < lever.immediateChance || lever.multiplier <= 0 || (eventClass === 'deadline' && noDeadline))
    return { delayMs: 0, reason: 'immediate' };
  const profile = RESPONSE_DELAY_PROFILES[eventClass];
  const scale = lever.multiplier;
  const sampled = profile.medianMs * scale * Math.exp(SIGMA * normal(random));
  const cap = profile.capMs * scale;
  const limit = deadlineLimitMs(eventClass, input.now, input.deadline);
  const unclamped = Math.min(sampled, cap);
  const reason = limit < unclamped ? 'deadline' : cap < sampled ? 'capped' : 'sampled';
  return { delayMs: Math.floor(Math.min(unclamped, limit)), reason };
}
