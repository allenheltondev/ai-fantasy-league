import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS, ACHIEVEMENT_IDS, seasonAchievements, weekAchievements } from './achievements.js';
import { headToHead, seasonRecords, type PlayedGame } from './records.js';

const game = (
  week: number,
  homeTeamId: string,
  awayTeamId: string,
  homeScore: number,
  awayScore: number,
  kind: PlayedGame['kind'] = 'regular'
): PlayedGame => ({ week, kind, homeTeamId, awayTeamId, homeScore, awayScore });

const games = [
  game(1, 'a', 'b', 120.5, 60),
  game(1, 'c', 'd', 90, 90),
  game(2, 'b', 'a', 101, 100),
  game(2, 'd', 'c', 150, 70.25),
  game(3, 'a', 'd', 150, 80, 'playoff')
];

describe('seasonRecords', () => {
  it('finds the high and low scores, the biggest blowout, and the closest game', () => {
    expect(seasonRecords(games)).toEqual({
      highestScore: { teamId: 'd', week: 2, points: 150 },
      lowestScore: { teamId: 'b', week: 1, points: 60 },
      biggestBlowout: {
        week: 2,
        kind: 'regular',
        winnerTeamId: 'd',
        loserTeamId: 'c',
        winnerScore: 150,
        loserScore: 70.25,
        margin: 79.75
      },
      closestGame: expect.objectContaining({ week: 2, winnerTeamId: 'b', margin: 1 })
    });
  });

  it('is empty without games', () => {
    expect(seasonRecords([])).toEqual({
      highestScore: null,
      lowestScore: null,
      biggestBlowout: null,
      closestGame: null
    });
  });
});

describe('headToHead', () => {
  it('totals each pair from the first team id', () => {
    expect(headToHead(games)).toEqual([
      { teamId: 'a', opponentId: 'b', wins: 1, losses: 1, ties: 0, pointsFor: 220.5, pointsAgainst: 161 },
      { teamId: 'a', opponentId: 'd', wins: 1, losses: 0, ties: 0, pointsFor: 150, pointsAgainst: 80 },
      { teamId: 'c', opponentId: 'd', wins: 0, losses: 1, ties: 1, pointsFor: 160.25, pointsAgainst: 240 }
    ]);
  });
});

describe('achievements', () => {
  it('awards the week top score (ties share it) and blowouts', () => {
    expect(weekAchievements(1, games)).toEqual([
      { achievementId: 'weekly-high-score', teamId: 'a', week: 1, reason: '120.5 points, the most in week 1' },
      { achievementId: 'blowout-win', teamId: 'a', week: 1, reason: 'Won by 60.5 in week 1' }
    ]);
    const tied = weekAchievements(4, [game(4, 'a', 'b', 100, 100), game(4, 'c', 'd', 1, 150)]);
    expect(tied.map((a) => [a.achievementId, a.teamId])).toEqual([
      ['weekly-high-score', 'd'],
      ['blowout-win', 'd']
    ]);
    expect(weekAchievements(9, games)).toEqual([]);
    expect(weekAchievements(5, [game(5, 'a', 'b', 0, 0)])).toEqual([]);
  });

  it('awards the champions and the season high at the end of the season', () => {
    expect(
      seasonAchievements({ championTeamId: 'a', consolationChampionTeamId: 'c', games }).map((a) => [
        a.achievementId,
        a.teamId
      ])
    ).toEqual([
      ['league-champion', 'a'],
      ['consolation-champion', 'c'],
      ['season-high-score', 'd']
    ]);
    expect(seasonAchievements({ championTeamId: null, consolationChampionTeamId: null, games: [] })).toEqual([]);
  });

  it('defines every achievement with a stable badge action', () => {
    for (const id of ACHIEVEMENT_IDS) {
      expect(ACHIEVEMENTS[id].id).toBe(id);
      expect(ACHIEVEMENTS[id].badgeAction).toMatch(/^fantasy\.[a-z_]+\.[a-z_]+$/);
    }
  });
});
