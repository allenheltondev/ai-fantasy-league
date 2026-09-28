import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CHAT_BLOCKLIST, moderateChatText, normalizeForBlocklist } from './moderation.js';

const CONTROL = new RegExp('[\\u0000-\\u0008\\u000B-\\u001F\\u007F]');

describe('moderateChatText', () => {
  it('strips control, zero-width, and bidi characters but keeps newlines and tabs', () => {
    expect(moderateChatText('  hi\u0000 there​‮!\r\n\tok\n\n\n\nbye\u0007 ')).toEqual({
      ok: true,
      text: 'hi there!\n\tok\n\nbye'
    });
  });

  it('refuses messages with no visible text', () => {
    expect(moderateChatText('\u0000​ \n')).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('blocks harassment through case, accents, and letter swaps, but not trash talk', () => {
    for (const text of ['KYS', 'just go die', 'k1ll y0urself lol', 'hópe you die', 'Kill-Yourself!']) {
      expect(moderateChatText(text)).toMatchObject({ ok: false, reason: 'blocked' });
    }
    expect((moderateChatText('kys') as { fix: string }).fix).toMatch(/Rewrite/);
    for (const text of ['Your team is going to die out there', 'skys the limit', 'I will crush you in week 5']) {
      expect(moderateChatText(text)).toMatchObject({ ok: true });
    }
    expect(moderateChatText('custom bad word', ['bad word'])).toMatchObject({ ok: false });
  });

  it('normalizes to spaced lowercase words', () => {
    expect(normalizeForBlocklist('Héllo, W0RLD!!')).toBe(' hello world ');
    expect(CHAT_BLOCKLIST.every((p) => normalizeForBlocklist(p) === ` ${p} `)).toBe(true);
  });

  it('property: the output has no control characters, never grows, and is trimmed', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (raw) => {
        const result = moderateChatText(raw);
        if (!result.ok) return;
        expect(result.text).not.toMatch(CONTROL);
        expect(result.text.length).toBeLessThanOrEqual(raw.length);
        expect(result.text).toBe(result.text.trim());
      })
    );
  });
});
