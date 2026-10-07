/**
 * Repetition in an agent's chat: a new message that mostly restates one of the agent's own earlier
 * messages (the same jab, the same stat, the same closing line) reads like a bot on a loop. The
 * prompt shows the agent its recent lines and asks for a fresh angle; this is the backstop, run on
 * the finished message before it is posted.
 *
 * Two tests, on lowercased words with punctuation stripped:
 * - Overlap: at least `overlapShare` of the new message's word trigrams appear in one earlier
 *   message (a reworded copy). Only for a message of `minTrigrams` or more: a short quip shares a
 *   catchphrase by design.
 * - A shared run of `sharedRun` or more words in a row (a recycled catchphrase or sentence).
 */

export const REPETITION_LIMITS = {
  /** Share of the new message's word trigrams found in one earlier message. */
  overlapShare: 0.5,
  /** Trigrams a message needs before the overlap test applies. */
  minTrigrams: 6,
  /** Consecutive words shared with one earlier message. */
  sharedRun: 8
} as const;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/@\S+/g, ' ')
    .replace(/[^\p{L}\p{N}.'\s]+/gu, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function trigrams(ws: readonly string[]): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + 2 < ws.length; i++) grams.add(`${ws[i]} ${ws[i + 1]} ${ws[i + 2]}`);
  return grams;
}

/** The longest run of words `a` and `b` share in a row. */
function longestRun(a: readonly string[], b: readonly string[]): number {
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        row[j] = (prev[j - 1] as number) + 1;
        if ((row[j] as number) > best) best = row[j] as number;
      }
    }
    prev = row;
  }
  return best;
}

/** True when `text` mostly repeats one of `earlier` (see the module comment). */
export function repeatsEarlier(text: string, earlier: readonly string[]): boolean {
  const ws = words(text);
  const grams = trigrams(ws);
  for (const before of earlier) {
    const bws = words(before);
    if (longestRun(ws, bws) >= REPETITION_LIMITS.sharedRun) return true;
    if (grams.size < REPETITION_LIMITS.minTrigrams) continue;
    const theirs = trigrams(bws);
    let shared = 0;
    for (const g of grams) if (theirs.has(g)) shared++;
    if (shared / grams.size >= REPETITION_LIMITS.overlapShare) return true;
  }
  return false;
}
