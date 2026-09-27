import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixturePlayers } from './fixtures.js';
import { levenshtein, matchPlayers, normalizeName, parseQuery, SCORE, scoreName } from './match.js';
import type { Player } from './model.js';

const byId = (id: string): Player => {
  const player = fixturePlayers.find((p) => p.id === id);
  if (player === undefined) throw new Error(id);
  return player;
};

describe('normalizeName', () => {
  it.each([
    ["Ja'Marr Chase", 'jamarr chase'],
    ['A.J. Brown', 'aj brown'],
    ['Amon-Ra St. Brown', 'amon ra st brown'],
    ['Marvin Harrison Jr.', 'marvin harrison'],
    ['Kenneth Walker III', 'kenneth walker'],
    ['  José   Núñez ', 'jose nunez'],
    ['San Francisco D/ST', 'san francisco d st']
  ])('%s -> %s', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it('is idempotent', () => {
    fc.assert(fc.property(fc.string(), (s) => normalizeName(normalizeName(s)) === normalizeName(s)));
  });
});

describe('parseQuery', () => {
  it('pulls team and position hints out of multi-word queries', () => {
    expect(parseQuery({ query: 'mccaffrey sf' })).toEqual({
      text: 'mccaffrey',
      team: 'SF',
      position: undefined
    });
    expect(parseQuery({ query: 'allen qb' })).toEqual({ text: 'allen', team: undefined, position: 'QB' });
    expect(parseQuery({ query: 'niners dst' })).toEqual({ text: 'niners', team: undefined, position: 'DEF' });
  });

  it('treats a lone token as a name and keeps explicit filters', () => {
    expect(parseQuery({ query: 'sf' })).toEqual({ text: 'sf', team: undefined, position: undefined });
    expect(parseQuery({ query: 'hill no', team: 'mia' })).toEqual({
      text: 'hill no',
      team: 'MIA',
      position: undefined
    });
    expect(parseQuery({})).toEqual({ text: '', team: undefined, position: undefined });
  });
});

describe('scoreName', () => {
  const cmc = byId('fx-cmc');
  it('ranks exact names and aliases highest', () => {
    expect(scoreName(cmc, 'christian mccaffrey')).toBe(SCORE.exact);
    expect(scoreName(cmc, 'cmc')).toBe(SCORE.exact);
  });
  it('scores last names, prefixes, token prefixes, and typos', () => {
    expect(scoreName(cmc, 'mccaffrey')).toBe(SCORE.lastName);
    expect(scoreName(cmc, 'christian mc')).toBe(SCORE.prefix);
    expect(scoreName(cmc, 'chr mcc')).toBe(SCORE.tokenPrefix);
    expect(scoreName(cmc, 'mccafrey')).toBe(SCORE.fuzzy);
    expect(scoreName(cmc, 'christian mcaffrey')).toBe(SCORE.fuzzy);
    expect(scoreName(cmc, 'zzz')).toBe(0);
    expect(scoreName(cmc, 'mcfry')).toBe(0);
  });
});

describe('matchPlayers', () => {
  it('orders by score, then rank, then name', () => {
    const ids = matchPlayers(fixturePlayers, { query: 'williams' }).map((m) => m.player.id);
    expect(ids).toEqual(['fx-kyrenw', 'fx-jamesonw', 'fx-javontew', 'fx-mikew']);
  });

  it('applies filters and lists everything for an empty query', () => {
    const qbs = matchPlayers(fixturePlayers, { position: 'QB' });
    expect(qbs.every((m) => m.player.position === 'QB')).toBe(true);
    expect(qbs[0]?.player.id).toBe('fx-lamar');
    expect(matchPlayers(fixturePlayers, { query: 'hill', team: 'NO' }).map((m) => m.player.id)).toEqual([
      'fx-taysom'
    ]);
  });

  it('sorts unranked players last', () => {
    const kickers = matchPlayers(fixturePlayers, { position: 'K' }).map((m) => m.player.id);
    expect(kickers).toEqual(['fx-butker', 'fx-tucker']);
  });

  it('breaks full ties by name', () => {
    const twins = [
      { ...byId('fx-mikew'), id: 'b', name: 'Zed Twin', rank: null },
      { ...byId('fx-mikew'), id: 'a', name: 'Abe Twin', rank: null }
    ];
    expect(matchPlayers(twins, {}).map((m) => m.player.id)).toEqual(['a', 'b']);
  });
});

describe('levenshtein', () => {
  it('computes edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });

  it('is symmetric', () => {
    fc.assert(fc.property(fc.string(), fc.string(), (a, b) => levenshtein(a, b) === levenshtein(b, a)));
  });
});
