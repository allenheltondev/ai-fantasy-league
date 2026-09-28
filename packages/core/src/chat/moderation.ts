/**
 * Chat moderation (issue #112): one pass for every message, whether a person or an agent wrote it
 * (both post through `post_message`).
 *
 * - Control characters are stripped, along with zero-width and bidirectional-override characters
 *   that can hide or reorder text. Newlines and tabs stay, and runs of more than two blank lines
 *   collapse.
 * - A small blocklist refuses harassment. Trash talk about fantasy teams is fine; telling someone
 *   to hurt themselves is not. Matching ignores case, accents, and simple letter swaps
 *   (`k1ll`, `y0urself`).
 */

// C0 controls except \t and \n, DEL, C1 controls, zero-width characters, line/paragraph
// separators, and bidi overrides.
const INVISIBLE =
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Phrases (already normalized: lowercase letters and single spaces) that block a message. */
export const CHAT_BLOCKLIST: readonly string[] = [
  'kill yourself',
  'kys',
  'go die',
  'hang yourself',
  'neck yourself',
  'hope you die',
  'hope your family dies'
];

export type ModerationResult =
  { ok: true; text: string } | { ok: false; reason: 'empty' | 'blocked'; message: string; fix: string };

const LEET: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's'
};

/** Lowercase words only, for blocklist matching: accents dropped, simple letter swaps undone. */
export function normalizeForBlocklist(text: string): string {
  const words = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[013457@$]/g, (c) => LEET[c] as string)
    .replace(/[^a-z]+/g, ' ')
    .trim();
  return ` ${words} `;
}

/** Cleans a chat message, or says why it cannot be posted (with a fix written for a model). */
export function moderateChatText(
  raw: string,
  blocklist: readonly string[] = CHAT_BLOCKLIST
): ModerationResult {
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length === 0) {
    return {
      ok: false,
      reason: 'empty',
      message: 'The message has no visible text.',
      fix: 'Write the message with ordinary visible characters; control and invisible characters are removed.'
    };
  }
  const normalized = normalizeForBlocklist(text);
  if (blocklist.some((phrase) => normalized.includes(` ${phrase} `))) {
    return {
      ok: false,
      reason: 'blocked',
      message: 'The message breaks the league chat rules.',
      fix: 'Rewrite it without telling anyone to hurt themselves or wishing harm on them. Trash talk about teams, picks, and results is fine.'
    };
  }
  return { ok: true, text };
}
