import { describe, expect, it } from 'vitest';
import { fixturePlayers } from './fixtures.js';
import type { Player } from './model.js';
import { NewsTagger } from './tagging.js';

const joshAllenLb: Player = {
  id: 'jallen-lb',
  name: 'Josh Allen',
  firstName: 'Josh',
  lastName: 'Allen',
  team: 'JAX',
  position: 'DEF',
  status: 'active',
  injuryStatus: null,
  aliases: [],
  rank: null,
  updatedAt: 'x'
};
const joshAllenOther: Player = { ...joshAllenLb, id: 'jallen-2', position: 'QB', team: 'NYJ' };
const tagger = new NewsTagger([...fixturePlayers, joshAllenLb, joshAllenOther]);

describe('NewsTagger', () => {
  it('tags full player names (with punctuation and suffixes) and adds their teams', () => {
    expect(
      tagger.tag("Ja'Marr Chase and Amon-Ra St. Brown lead Week 1; Marvin Harrison Jr. questionable")
    ).toEqual({
      playerIds: ['fx-arsb', 'fx-chase', 'fx-mhj'],
      teams: ['ARI', 'CIN', 'DET']
    });
  });

  it('tags teams by nickname, alias, or city plus nickname, but not by city alone', () => {
    expect(tagger.tag('Niners edge the Kansas City Chiefs; New York waits')).toEqual({
      playerIds: [],
      teams: ['KC', 'SF']
    });
  });

  it('skips last names alone and team defenses', () => {
    expect(tagger.tag('McCaffrey returns as the 49ers D/ST dominates')).toEqual({
      playerIds: [],
      teams: ['SF']
    });
  });

  it('uses mentioned or hinted teams to break a shared name, and skips it otherwise', () => {
    expect(tagger.tag('Josh Allen throws for 300 as the Bills win').playerIds).toEqual(['fx-jallen']);
    expect(tagger.tag('Josh Allen is questionable').playerIds).toEqual([]);
    expect(tagger.tag('Josh Allen is questionable', ['NYJ'])).toEqual({
      playerIds: ['jallen-2'],
      teams: ['NYJ']
    });
  });

  it('handles empty text', () => {
    expect(tagger.tag('')).toEqual({ playerIds: [], teams: [] });
  });
});
