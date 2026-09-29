import { describe, expect, it } from 'vitest';
import { yahooDefaultSettings } from '../rules/settings.js';
import type { FinalizedMatchup } from '../standings/standings.js';
import { tradeAppetite, waiverMinGain } from './behavior.js';
import { checkInTradeChance } from './check-in.js';
import { resolveAgentConfig } from './seat-config.js';
import {
  MODIFIER_CAPS,
  SHORT_POSITION_WAIVER_BOOST,
  SITUATION_RULES,
  URGENCY_LEVELS,
  composeBehavior,
  computeSituation,
  rosterPressure,
  situationPrompt,
  type SituationInput,
  type SituationRosterPlayer,
  type SituationalState
} from './situation.js';

type Game = FinalizedMatchup & { kind: 'regular' | 'playoff' };

const TEAMS = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'];
const settings = () => {
  const s = yahooDefaultSettings(8);
  s.playoffs = { ...s.playoffs, teams: 4, byes: 0, startWeek: 15, endWeek: 16 };
  return s;
};

/** A round robin (circle method): the stronger team wins unless `upset` says otherwise. */
function season(weeks: number, strength: (team: string, week: number) => number, from = 1): Game[] {
  const games: Game[] = [];
  for (let week = from; week < from + weeks; week++) {
    const rest = TEAMS.slice(1);
    const shift = (week - 1) % rest.length;
    const order = [TEAMS[0] as string, ...rest.slice(shift), ...rest.slice(0, shift)];
    for (let i = 0; i < order.length / 2; i++) {
      const home = order[i] as string;
      const away = order[order.length - 1 - i] as string;
      const homeWins = strength(home, week) >= strength(away, week);
      games.push({
        week,
        kind: 'regular',
        homeTeamId: home,
        awayTeamId: away,
        homeScore: homeWins ? 110 : 90,
        awayScore: homeWins ? 90 : 110
      });
    }
  }
  return games;
}

/** Strength by team number: t0 wins everything, t7 loses everything. */
const byIndex = (team: string) => 10 - Number(team.slice(1));

const healthy: SituationRosterPlayer[] = [
  { position: 'QB', status: 'active' },
  { position: 'QB', status: 'active' },
  ...Array.from({ length: 4 }, () => ({ position: 'RB' as const, status: 'active' as const })),
  ...Array.from({ length: 5 }, () => ({ position: 'WR' as const, status: 'active' as const })),
  { position: 'TE', status: 'active' },
  { position: 'K', status: 'active' },
  { position: 'K', status: 'active' },
  { position: 'DEF', status: 'active' },
  { position: 'DEF', status: 'active' }
];
const injured = healthy.map((p, i) =>
  p.position === 'RB' ? { ...p, status: i % 2 === 0 ? ('out' as const) : ('ir' as const) } : p
);

const input = (overrides: Partial<SituationInput> = {}): SituationInput => ({
  teamId: 't0',
  settings: settings(),
  phase: 'regular_season',
  week: 8,
  teamIds: TEAMS,
  finalized: season(7, byIndex),
  roster: healthy,
  standingsSeed: 'seed',
  ...overrides
});

// One fixed personality across every scenario.
const config = resolveAgentConfig({ personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' });

describe('situational state from authoritative results', () => {
  it('falls back to the unchanged baseline without evidence', () => {
    for (const state of [
      computeSituation(input({ finalized: null })),
      computeSituation(input({ phase: 'drafting' })),
      computeSituation(input({ teamId: 'stranger', teamIds: TEAMS }))
    ]) {
      expect(state).toMatchObject({ urgency: 'baseline', basis: 'none', horizon: 'season' });
      expect(situationPrompt(state).length).toBeLessThanOrEqual(1);
    }
    expect(computeSituation(input({ finalized: null })).reasons).toEqual(['results_unavailable']);
    expect(computeSituation(input({ roster: null })).pressure).toEqual({});
    const baseline = composeBehavior(config);
    expect(baseline).toMatchObject({
      urgency: 'baseline',
      tradeLookChance: checkInTradeChance(config.tradeFrequency),
      waiverAggressiveness: config.waiverAggressiveness,
      waiverMinGain: waiverMinGain(config.waiverAggressiveness),
      riskTolerance: config.valuation.riskTolerance,
      protectDepth: [],
      explanation: []
    });
    expect(composeBehavior(config, computeSituation(input({ finalized: null, roster: null })))).toEqual(
      baseline
    );
    expect(situationPrompt(undefined)).toEqual([]);
    expect(situationPrompt(computeSituation(input({ finalized: null })))).toEqual([]);
    expect(situationPrompt(computeSituation(input({ finalized: null, roster: injured })))).toEqual([
      'Injuries leave you short at RB this week.'
    ]);
  });

  it('claims nothing early in the season, even for an unbeaten team', () => {
    for (const weeks of [0, 1, SITUATION_RULES.minGames - 1]) {
      const state = computeSituation(input({ finalized: season(weeks, byIndex), week: weeks + 1 }));
      expect(state).toMatchObject({ urgency: 'baseline', basis: 'none', reasons: ['early_season'] });
      expect(composeBehavior(config, state).modifiers).toEqual({
        tradeLook: 0,
        waiverAggressiveness: 0,
        riskTolerance: 0
      });
      expect(situationPrompt(state)[0]).toContain('Too early');
    }
    // The first heuristic label waits for a second week to confirm it.
    const first = computeSituation(input({ finalized: season(4, byIndex), week: 5 }));
    expect(first).toMatchObject({ urgency: 'baseline', pending: 'contender' });
    expect(first.reasons).toContain('awaiting_confirmation');
    expect(situationPrompt(first)[0]).toContain('Too early');
    expect(computeSituation(input({ finalized: season(5, byIndex), week: 6 }))).toMatchObject({
      urgency: 'contender',
      basis: 'heuristic',
      sinceWeek: 5,
      previous: 'baseline',
      pending: null
    });
  });

  it('gives one personality bounded, understandable differences as contender, bubble, and short-handed', () => {
    const contender = computeSituation(input());
    const bubble = computeSituation(input({ teamId: 't3' }));
    const longShot = computeSituation(input({ teamId: 't6', finalized: season(6, byIndex), week: 7 }));
    const crisis = computeSituation(input({ roster: injured }));
    expect(contender).toMatchObject({ urgency: 'contender', horizon: 'season', basis: 'heuristic' });
    expect(contender.standing).toMatchObject({ rank: 1, record: '7-0', cushion: 4 });
    expect(bubble).toMatchObject({ urgency: 'bubble', horizon: 'next_few_weeks' });
    expect(bubble.reasons).toEqual(['in_playoff_position', 'thin_cushion']);
    expect(longShot).toMatchObject({ urgency: 'long_shot', horizon: 'this_week' });
    expect(crisis.pressure.RB).toBe('short');
    expect(contender.pressure).toMatchObject({ RB: 'covered', QB: 'covered', TE: 'thin' });

    const [c, b, l, x] = [contender, bubble, longShot, crisis].map((s) => composeBehavior(config, s));
    // The contender plans ahead and protects thin spots; the bubble team chases this month.
    expect(c?.protectDepth).toEqual(['TE']);
    expect(b?.protectDepth).toEqual([]);
    expect(b!.tradeLookChance).toBeGreaterThan(c!.tradeLookChance);
    expect(b!.waiverAggressiveness).toBeGreaterThan(c!.waiverAggressiveness);
    expect(b!.waiverMinGain).toBeLessThan(c!.waiverMinGain);
    expect(b!.riskTolerance).toBeGreaterThan(c!.riskTolerance);
    expect(l!.tradeLookChance).toBeGreaterThanOrEqual(b!.tradeLookChance);
    // An injury crisis works the wire harder and guards the position it is short at.
    expect(x!.waiverAggressiveness).toBe(
      Math.round((c!.waiverAggressiveness + SHORT_POSITION_WAIVER_BOOST) * 100) / 100
    );
    expect(x!.protectDepth).toEqual(['RB', 'TE']);
    expect(x!.explanation.join(' ')).toContain('short-handed');
    for (const e of [c, b, l, x]) {
      expect(Math.abs(e!.tradeLookChance - checkInTradeChance(config.tradeFrequency))).toBeLessThanOrEqual(
        0.15 + 1e-9
      );
      expect(Math.abs(e!.waiverAggressiveness - config.waiverAggressiveness)).toBeLessThanOrEqual(
        0.15 + 1e-9
      );
      expect(Math.abs(e!.riskTolerance - (config.valuation.riskTolerance ?? 0.5))).toBeLessThanOrEqual(
        0.1 + 1e-9
      );
    }
    // The words match: the same state drives the prompt lines.
    expect(situationPrompt(contender)[0]).toContain('1st, in a playoff spot 4 games clear');
    expect(situationPrompt(bubble)[0]).toContain('4-3, 4th, on the playoff bubble with 7 weeks left');
    expect(situationPrompt(longShot)[0]).toContain('behind the last playoff spot');
    expect(situationPrompt(crisis)).toContain('Injuries leave you short at RB this week.');
    for (const line of [contender, bubble, longShot].flatMap(situationPrompt))
      expect(line).not.toMatch(/FAAB|\$|aggressiveness|tolerance/);
  });

  it('marks clinched and eliminated only when no remaining result can undo them', () => {
    const late = computeSituation(input({ finalized: season(12, byIndex), week: 13 }));
    expect(late).toMatchObject({ urgency: 'clinched', basis: 'exact', horizon: 'playoff_weeks' });
    const out = computeSituation(input({ teamId: 't7', finalized: season(12, byIndex), week: 13 }));
    expect(out).toMatchObject({ urgency: 'eliminated', basis: 'exact', horizon: 'this_week' });
    // Eliminated teams keep the unchanged baseline: no dumping, no tanking, no favors.
    expect(composeBehavior(config, out)).toMatchObject({
      modifiers: { tradeLook: 0, waiverAggressiveness: 0, riskTolerance: 0 },
      protectDepth: []
    });
    expect(situationPrompt(out)[0]).toContain('best legal lineup');
    expect(situationPrompt(late)[0]).toContain('clinched a playoff spot (12-0, 1st)');
    // The regular season over: rank alone decides, tiebreakers included.
    const final = computeSituation(input({ teamId: 't3', finalized: season(14, byIndex), week: 14 }));
    expect(final).toMatchObject({ urgency: 'clinched', remainingWeeks: 0 });
    expect(final.reasons).toContain('regular_season_final');
    expect(computeSituation(input({ teamId: 't4', finalized: season(14, byIndex), week: 14 })).urgency).toBe(
      'eliminated'
    );
    // A league where everyone makes the playoffs has no race to read: the baseline all season.
    const all = settings();
    all.playoffs.teams = 8;
    expect(computeSituation(input({ settings: all }))).toMatchObject({
      urgency: 'baseline',
      reasons: ['no_playoff_race']
    });
  });

  it('uses the final-stretch horizon for a late bubble team', () => {
    // t1 started 6-1, then lost every week: 5-7 and one game out with two weeks left.
    const slump = (team: string, week: number) => (team === 't1' && week >= 7 ? 0 : byIndex(team));
    const state = computeSituation(input({ teamId: 't1', finalized: season(12, slump), week: 13 }));
    expect(state).toMatchObject({ urgency: 'bubble', horizon: 'this_week', remainingWeeks: 2 });
    expect(state.reasons).toEqual(['outside_playoff_position', 'within_reach', 'final_stretch']);
  });

  it('handles mid-season starts and custom playoff sizes', () => {
    const custom = settings();
    custom.schedule.startWeek = 6;
    custom.playoffs.teams = 2;
    const games = season(4, byIndex, 6);
    const state = computeSituation(input({ settings: custom, finalized: games, week: 10, teamId: 't0' }));
    // 4-0 against a 3-1 runner-up for two seats: first labelled after three games, confirmed after four.
    expect(state).toMatchObject({ throughWeek: 9, remainingWeeks: 5, urgency: 'bubble', sinceWeek: 9 });
    // Games before the league's start week never count.
    expect(
      computeSituation(
        input({ settings: custom, finalized: [...season(5, byIndex), ...games], week: 10, teamId: 't0' })
      )
    ).toEqual(state);
  });

  it('follows the playoff bracket, where a tie goes to the better seed', () => {
    const regular = season(14, byIndex);
    const playoffs = (home: number, away: number): Game => ({
      week: 15,
      kind: 'playoff',
      homeTeamId: 't0',
      awayTeamId: 't3',
      homeScore: home,
      awayScore: away
    });
    const at = (teamId: string, games: Game[]) =>
      computeSituation(input({ phase: 'playoffs', week: 16, teamId, finalized: [...regular, ...games] }));
    expect(at('t3', [])).toMatchObject({ urgency: 'playoff_alive', basis: 'exact', horizon: 'this_week' });
    expect(at('t3', [playoffs(100, 90)])).toMatchObject({ urgency: 'eliminated', reasons: ['playoff_out'] });
    expect(at('t3', [playoffs(100, 100)]).urgency).toBe('eliminated');
    expect(at('t0', [playoffs(100, 100)]).urgency).toBe('playoff_alive');
    expect(at('t0', [playoffs(90, 100)]).urgency).toBe('eliminated');
    expect(at('t6', []).urgency).toBe('eliminated');
    expect(at('stranger', []).urgency).toBe('baseline');
    expect(situationPrompt(at('t3', []))[0]).toContain('win or go home');
    expect(composeBehavior(config, at('t3', [])).modifiers.waiverAggressiveness).toBeGreaterThan(0);
  });
});

describe('stability', () => {
  it('ignores live scores, look-ahead, duplicates, corrections replayed, and event order', () => {
    const games = season(8, byIndex);
    const base = computeSituation(input({ finalized: games, week: 9 }));
    const shuffled = [...games].reverse();
    expect(computeSituation(input({ finalized: shuffled, week: 9 }))).toEqual(base);
    expect(computeSituation(input({ finalized: [...games, ...games], week: 9 }))).toEqual(base);
    // A week-9 result that is not known at week 9's decision time (a replay's future) is ignored.
    const future = season(9, byIndex).filter((g) => g.week === 9);
    expect(computeSituation(input({ finalized: [...games, ...future], week: 8 }))).toEqual(
      computeSituation(input({ finalized: games, week: 8 }))
    );
    // A corrected score for the same game counts once, with the latest value.
    const corrected = games.map((g) => ({ ...g }));
    const flipped = { ...(corrected.find((g) => g.week === 8 && g.homeTeamId === 't0') as Game) };
    flipped.homeScore = 0;
    expect(computeSituation(input({ finalized: [...games, flipped], week: 9 })).standing?.record).toBe('7-1');
    expect(base.standing?.record).toBe('8-0');
  });

  it('needs two finalized weeks before a heuristic label changes behavior', () => {
    // t1 is a contender, loses one week, then recovers: no churn.
    const wobble = (team: string, week: number) => (team === 't1' && week === 7 ? 0 : byIndex(team));
    const oneWeek = computeSituation(input({ teamId: 't1', finalized: season(7, wobble), week: 8 }));
    const settled = computeSituation(input({ teamId: 't1', finalized: season(6, wobble), week: 7 }));
    expect(settled.urgency).toBe('contender');
    expect(oneWeek).toMatchObject({ urgency: 'contender', pending: 'bubble' });
    expect(oneWeek.reasons).toContain('awaiting_confirmation');
    expect(composeBehavior(config, oneWeek)).toEqual(composeBehavior(config, settled));
    expect(computeSituation(input({ teamId: 't1', finalized: season(8, wobble), week: 9 }))).toMatchObject({
      urgency: 'contender',
      pending: null
    });
    // Two bad weeks in a row do move it, and record when and from what.
    const slump = (team: string, week: number) => (team === 't1' && week >= 7 ? 0 : byIndex(team));
    const twoWeeks = computeSituation(input({ teamId: 't1', finalized: season(8, slump), week: 9 }));
    expect(twoWeeks).toMatchObject({ urgency: 'bubble', sinceWeek: 8, previous: 'contender', pending: null });
  });
});

describe('policy composition caps', () => {
  it('keeps every lever inside its cap and never changes trade cadence, edges, or counters', () => {
    const extremes = [0, 1].flatMap((w) =>
      [0, 1].map((t) => ({
        ...config,
        waiverAggressiveness: w,
        tradeFrequency: t,
        valuation: { riskTolerance: w }
      }))
    );
    for (const c of extremes)
      for (const urgency of URGENCY_LEVELS)
        for (const roster of [healthy, injured]) {
          const state: SituationalState = {
            ...computeSituation(input({ roster })),
            urgency
          };
          const e = composeBehavior(c, state);
          for (const [lever, cap] of Object.entries(MODIFIER_CAPS)) {
            const value = e.modifiers[lever as keyof typeof MODIFIER_CAPS];
            expect(value).toBeGreaterThanOrEqual(cap.min);
            expect(value).toBeLessThanOrEqual(cap.max);
          }
          for (const v of [e.tradeLookChance, e.waiverAggressiveness, e.riskTolerance]) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
          expect(e.waiverMinGain).toBe(waiverMinGain(e.waiverAggressiveness));
          // The trade appetite is read from the unchanged config everywhere.
          expect(tradeAppetite(c)).toEqual(tradeAppetite({ ...c }));
        }
  });

  it('counts designations only, never inventing variance from projections', () => {
    const s = settings();
    expect(
      rosterPressure(s, [
        { position: 'RB', status: 'active' },
        { position: 'RB', status: 'questionable' },
        { position: 'RB', status: 'doubtful' }
      ])
    ).toMatchObject({ RB: 'thin', QB: 'short' });
    expect(rosterPressure(s, [{ position: 'RB', status: 'suspended' }]).RB).toBe('short');
  });
});
