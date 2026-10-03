import { describe, expect, it } from 'vitest';
import { seasonUsage } from './current-form.js';

/** Usage from the nflverse numbers the official final adds to a week's stat line. */

describe('seasonUsage', () => {
  it('weighs a quarterback’s CPOE by attempts and leaves out what he never reported', () => {
    const usage = seasonUsage([
      {
        week: 1,
        stats: {
          gp: 1,
          pass_att: 30,
          nfv_tgt_share: 0,
          nfv_pass_air_yd: 240,
          nfv_pass_epa: 6,
          nfv_pass_cpoe: 4,
          nfv_rush_epa: 1
        }
      },
      {
        week: 2,
        stats: {
          gp: 1,
          pass_att: 10,
          nfv_tgt_share: 0,
          nfv_pass_air_yd: 40,
          nfv_pass_epa: -2,
          nfv_pass_cpoe: -8
        }
      },
      // A live line with no official numbers yet does not count.
      { week: 3, stats: { gp: 1, pass_att: 50 } }
    ]);
    expect(usage).toEqual({
      games: 2,
      throughWeek: 2,
      targetShare: null,
      airYardsShare: null,
      wopr: null,
      aDot: null,
      yacPerReception: null,
      receivingEpa: null,
      // 1 over two games.
      rushingEpa: 0.5,
      passingEpa: 2,
      // (4 × 30 − 8 × 10) / 40.
      cpoe: 1,
      // 280 air yards over 40 attempts.
      passingAdot: 7
    });
  });

  it('counts a receiver’s game without a target at a 0% share, and is null with no official game', () => {
    const usage = seasonUsage([
      {
        week: 1,
        stats: { gp: 1, rec_tgt: 8, rec: 6, nfv_tgt_share: 0.3, nfv_air_yd_share: 0.5, nfv_wopr: 0.8 }
      },
      { week: 2, stats: { gp: 1, nfv_tgt_share: 0, nfv_air_yd_share: 0, nfv_wopr: 0 } },
      // Not played: no game.
      { week: 3, stats: { nfv_tgt_share: 0 } }
    ]);
    expect(usage).toMatchObject({ games: 2, targetShare: 0.15, airYardsShare: 0.25, wopr: 0.4 });
    expect(seasonUsage([{ week: 1, stats: { gp: 1, rec: 3 } }])).toBeNull();
  });
});
