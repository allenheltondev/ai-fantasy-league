import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { findMentions, mentionedTeamIds, type MentionTarget } from './mentions.js';

const TEAMS: MentionTarget[] = [
  { teamId: 'team-1', names: ["Allen's Team", 'Allen', 'team-1'] },
  { teamId: 'team-2', names: ['Big Tuna', 'team-2'] },
  { teamId: 'team-3', names: ['Big Tuna FC', 'team-3', '  '] }
];

describe('findMentions', () => {
  it('finds team names, manager names, and team ids, case-insensitively', () => {
    const text = "hey @allen's team and @TEAM-2, also @Allen";
    expect(findMentions(text, TEAMS)).toEqual([
      { teamId: 'team-1', start: 4, end: 17, text: "@allen's team" },
      { teamId: 'team-2', start: 22, end: 29, text: '@TEAM-2' },
      { teamId: 'team-1', start: 36, end: 42, text: '@Allen' }
    ]);
    expect(mentionedTeamIds(text, TEAMS)).toEqual(['team-1', 'team-2']);
  });

  it('prefers the longest name', () => {
    expect(mentionedTeamIds('@Big Tuna FC is scared of @big tuna!', TEAMS)).toEqual(['team-3', 'team-2']);
  });

  it('needs a word boundary after the name and ignores @ inside words', () => {
    expect(findMentions('@Allenby and allen@example.com and @', TEAMS)).toEqual([]);
    expect(mentionedTeamIds('@nobody here', TEAMS)).toEqual([]);
    expect(mentionedTeamIds('(@Allen)', TEAMS)).toEqual(['team-1']);
  });

  it('never reports overlapping or out-of-order mentions', () => {
    const word = fc.constantFrom('@', 'Allen', 'big', 'tuna', 'FC', ' ', '@Big Tuna', 'x@', "'s", 'team-3');
    fc.assert(
      fc.property(fc.array(word, { maxLength: 30 }), (parts) => {
        const text = parts.join('');
        const found = findMentions(text, TEAMS);
        for (let i = 0; i < found.length; i++) {
          const m = found[i]!;
          expect(text.slice(m.start, m.end)).toBe(m.text);
          expect(m.text.startsWith('@')).toBe(true);
          if (i > 0) expect(m.start).toBeGreaterThanOrEqual(found[i - 1]!.end);
        }
      })
    );
  });

  it('finds every team mentioned by its own name in free text', () => {
    const plain = fc.stringMatching(/^[a-z ,.!?]{0,20}$/);
    fc.assert(
      fc.property(fc.array(fc.tuple(plain, fc.constantFrom(...TEAMS)), { maxLength: 6 }), (pieces) => {
        const text = pieces.map(([before, team]) => `${before} @${team.names[0]} `).join('');
        expect(mentionedTeamIds(text, TEAMS)).toEqual([...new Set(pieces.map(([, team]) => team.teamId))]);
      })
    );
  });

  it('finds nothing in text without an @', () => {
    fc.assert(
      fc.property(
        fc.string().map((s) => s.replaceAll('@', '')),
        (text) => {
          expect(findMentions(text, TEAMS)).toEqual([]);
        }
      )
    );
  });
});
