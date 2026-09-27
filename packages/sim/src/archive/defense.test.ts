import { scorePlayer, scoringPreset } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { csv, game } from '../../test/helpers.js';
import { DEFENSE_METHOD, TEAM_NAMES, TEAM_STATS_REQUIRED_COLUMNS, deriveDefenseLines } from './defense.js';

const HEADER = [
  ...TEAM_STATS_REQUIRED_COLUMNS,
  'sack_yards_lost',
  'def_punt_blocks',
  'def_fg_blocks',
  'def_pat_blocks',
  'def_2pt_made'
];
// season, week, team, season_type, opponent_team, def_sacks, def_interceptions, fumble_recovery_opp,
// def_tds, special_teams_tds, def_safeties, passing_yards, rushing_yards, sack_yards_lost, blocks x3, 2pt
const teamStats = csv(HEADER, [
  [2025, 1, 'KC', 'REG', 'LA', 4, 2, 1, 1, 1, 1, 250, 120, -20, 1, 0, 1, 0],
  [2025, 1, 'LA', 'REG', 'KC', 2, 0, 0, 0, 0, 0, 300, 90, -15, 0, 0, 0, 1],
  [2025, 19, 'KC', 'POST', 'BUF', 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]
]);

describe('deriveDefenseLines', () => {
  const schedule = [
    game(1, '2025-09-07T17:00:00.000Z', 'KC', 'LAR', [27, 10]),
    game(2, '2025-09-14T17:00:00.000Z', 'KC', 'BUF', null)
  ];

  it('maps nflverse team stats to Sleeper DEF keys and takes points allowed from the final score', () => {
    const lines = deriveDefenseLines(schedule, 2025, teamStats);
    expect([...lines.keys()]).toEqual([1]);
    expect(lines.get(1)?.get('KC')).toEqual({
      gp: 1,
      pts_allow: 10,
      sack: 4,
      int: 2,
      fum_rec: 1,
      def_td: 1,
      def_st_td: 1,
      safe: 1,
      blk_kick: 2,
      // the opponent (LA → LAR) passed for 300, lost 15 on sacks, and ran for 90
      yds_allow: 375
    });
    expect(lines.get(1)?.get('LAR')).toMatchObject({ pts_allow: 27, sack: 2, def_2pt: 1, yds_allow: 350 });
  });

  it('carries points allowed only when no team stats are supplied, and scores through the tiers', () => {
    const lines = deriveDefenseLines(schedule, 2025);
    expect(lines.get(1)?.get('KC')).toEqual({ gp: 1, pts_allow: 10 });
    expect(scorePlayer(scoringPreset(), lines.get(1)?.get('KC') ?? {}).points).toBe(4);
    const shutout = deriveDefenseLines([game(1, '2025-09-07T17:00:00.000Z', 'KC', 'LAR', [3, 0])], 2025);
    expect(scorePlayer(scoringPreset(), shutout.get(1)?.get('KC') ?? {}).points).toBe(10);
  });

  it('skips other seasons and non-final games', () => {
    expect(deriveDefenseLines(schedule, 2024, teamStats).size).toBe(0);
  });

  it('names all 32 teams and documents the method', () => {
    expect(Object.keys(TEAM_NAMES)).toHaveLength(32);
    expect(DEFENSE_METHOD).toContain('pts_allow');
  });
});
