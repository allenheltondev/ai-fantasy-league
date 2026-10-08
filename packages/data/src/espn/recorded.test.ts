import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURES, fixtureJson } from '../../test/helpers.js';
import { espnTeam, normalizeScoreboard } from './normalize.js';
import { espnEventSchema, espnScoreboardSchema } from './schemas.js';

/**
 * Real ESPN scoreboards recorded by the Record fixtures workflow (`espn_scoreboard`, or
 * `node scripts/record-fixtures.mjs --espn-scoreboard <season> <week>`) land in `fixtures/espn/`;
 * the hand-authored week the unit tests pin is in `fixtures/espn/hand-authored/`. Every recorded
 * week must parse game by game and map ESPN's team codes to ours, so a recording that drifts from
 * what `normalizeScoreboard` reads fails here. Recording more weeks widens this test with no code
 * change.
 */

const SCOREBOARD = /^scoreboard_(regular|post)_\d{4}_\d{1,2}\.json$/;
const scoreboards = (dir: string) =>
  readdirSync(new URL(dir, FIXTURES))
    .filter((f) => SCOREBOARD.test(f))
    .map((f) => `${dir}${f}`);
const recorded = scoreboards('espn/');
const handAuthored = scoreboards('espn/hand-authored/');

describe('recorded ESPN scoreboards', () => {
  it('keeps the hand-authored week apart from the recordings', () => {
    expect(handAuthored).toEqual(['espn/hand-authored/scoreboard_regular_2026_4.json']);
  });

  it('parses every game of every recorded week and maps its teams', () => {
    for (const file of [...recorded, ...handAuthored]) {
      const board = espnScoreboardSchema.parse(fixtureJson(file));
      expect(board.events.length, file).toBeGreaterThan(0);
      const issues = board.events.flatMap((raw, i) => {
        const parsed = espnEventSchema.safeParse(raw);
        return parsed.success
          ? []
          : parsed.error.issues.map((issue) => `events.${i}.${issue.path.join('.')}`);
      });
      expect(issues, file).toEqual([]);
      const games = normalizeScoreboard(board, { games: [], asOf: new Date('2026-10-04T18:30:00.000Z') });
      expect(games, file).toHaveLength(board.events.length);
      // The regular season has only the 32 teams (the postseason's Pro Bowl has AFC and NFC).
      if (file.includes('scoreboard_regular_')) {
        for (const g of games) expect([g.homeTeam, g.awayTeam], `${file} ${g.espnId}`).not.toContain(null);
      }
    }
  });

  it('maps the codes ESPN uses and leaves the all-star teams unmapped', () => {
    expect(espnTeam('WSH')).toBe('WAS');
    expect(espnTeam('AFC')).toBeNull();
  });
});
