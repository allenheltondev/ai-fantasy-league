import { POSITIONS, WILL_NOT_PLAY_STATUSES, type PlayerStatus, type Position } from '../rules/positions.js';
import type { LeagueSettings } from '../rules/settings.js';
import {
  computeStandings,
  formatRecord,
  matchupResult,
  type FinalizedMatchup,
  type StandingsRow
} from '../standings/standings.js';
import { waiverMinGain } from './behavior.js';
import { checkInTradeChance } from './check-in.js';
import type { ResolvedAgentConfig } from './seat-config.js';

/**
 * Situational adaptation (#217, first slice): a compact, authoritative read of a manager's
 * competitive stakes and roster health, and a bounded composition of it onto the archetype.
 *
 * - Inputs are finalized results only (never live scores), the league's own settings, and the
 *   roster's injury designations, so a swing during Sunday's games cannot move it and a replay at
 *   the same simulated time computes the same state. Callers pass only what existed at decision time.
 * - Clinched and eliminated are exact: they come from sufficient conditions that no remaining result
 *   can undo. Every other label is a bounded heuristic and says so (`basis`). There are no playoff
 *   probabilities, and before `SITUATION_RULES.minGames` final games there is no label at all.
 * - Hysteresis: a heuristic label must hold for `confirmWeeks` consecutive finalized weeks before
 *   behavior follows it. The state is a pure function of the season's final results, so it needs no
 *   storage: `sinceWeek` and `previous` record when and from what the current label took effect.
 * - Composition (`composeBehavior`) moves three levers within fixed caps: the chance a check-in
 *   looks at the trade market, waiver aggressiveness (FAAB share and the claim threshold), and
 *   lineup risk tolerance for injury-designated players. It never touches trade cadence, accept
 *   edges, valuation floors, FAAB budgets, locks, action limits, or tool and research access.
 * - An eliminated team keeps the unchanged baseline: it still sets its best legal lineup and makes
 *   ordinary improvements. No level ever sells, dumps, or favors another team.
 */

export const URGENCY_LEVELS = [
  'baseline',
  'clinched',
  'contender',
  'bubble',
  'long_shot',
  'eliminated',
  'playoff_alive'
] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

/** How a label is known: `exact` cannot be undone by any remaining result; `none` is no label. */
export type SituationBasis = 'exact' | 'heuristic' | 'none';

/** How far ahead roster decisions look. */
export type PlanningHorizon = 'this_week' | 'next_few_weeks' | 'season' | 'playoff_weeks';

/** `short`: fewer available players than starting slots; `thin`: no healthy, undesignated backup. */
export type RosterPressure = 'short' | 'thin' | 'covered';

export type SituationReason =
  | 'not_in_season'
  | 'results_unavailable'
  | 'no_playoff_race'
  | 'early_season'
  | 'clinched'
  | 'eliminated'
  | 'regular_season_final'
  | 'in_playoff_position'
  | 'outside_playoff_position'
  | 'comfortable_cushion'
  | 'thin_cushion'
  | 'within_reach'
  | 'far_behind'
  | 'final_stretch'
  | 'awaiting_confirmation'
  | 'playoff_alive'
  | 'playoff_out';

/** Calibration starting points (#219): bounded, documented, and tested; refine with #211. */
export const SITUATION_RULES = {
  /** Final games a team must have before any heuristic label: a 2-0 start proves little. */
  minGames: 3,
  /** Wins (a tie is half) ahead of the first team out that make a playoff-position team a contender. */
  contenderCushion: 1.5,
  /** Wins behind the last playoff spot still counted as the bubble rather than a long shot. */
  bubbleGamesBack: 1.5,
  /** Remaining regular-season weeks at or below which the horizon shrinks to this week. */
  finalStretchWeeks: 2,
  /** Consecutive finalized weeks a heuristic label must hold before behavior follows it. */
  confirmWeeks: 2
} as const;

export interface SituationStanding {
  rank: number;
  record: string;
  gamesPlayed: number;
  /** Wins (a tie is half) ahead of the first team out (positive) or behind the last spot (negative). */
  cushion: number;
  playoffTeams: number;
}

export interface SituationalState {
  schemaVersion: 1;
  /** The league week the state was computed for. */
  week: number | null;
  /** The last finalized regular-season week it reads; null before any. */
  throughWeek: number | null;
  /** Regular-season weeks not yet final. */
  remainingWeeks: number | null;
  urgency: UrgencyLevel;
  basis: SituationBasis;
  reasons: SituationReason[];
  /** The finalized week the current label took effect, and the label before it. */
  sinceWeek: number | null;
  previous: UrgencyLevel | null;
  /** A different heuristic label seen in the latest week, waiting for confirmation. */
  pending: UrgencyLevel | null;
  horizon: PlanningHorizon;
  standing: SituationStanding | null;
  /** Per position with a dedicated starting slot; empty when the roster was unavailable. */
  pressure: Partial<Record<Position, RosterPressure>>;
}

export interface SituationRosterPlayer {
  position: Position;
  status: PlayerStatus;
}

export interface SituationInput {
  teamId: string;
  settings: Pick<LeagueSettings, 'schedule' | 'playoffs' | 'roster'>;
  phase: string;
  week: number | null;
  /** Every team in the league, so teams without a final game still rank. */
  teamIds: readonly string[];
  /**
   * Finalized games (regular season and playoffs) known at decision time; null when they could not
   * be read. Live or scheduled games must not be passed.
   */
  finalized: readonly (FinalizedMatchup & { kind: 'regular' | 'playoff' })[] | null;
  /** The team's players and their designations; null when unavailable. */
  roster: readonly SituationRosterPlayer[] | null;
  /** The standings coin-flip seed (the league's `scheduleSeed`). */
  standingsSeed?: string;
}

const points = (row: Pick<StandingsRow, 'wins' | 'ties'>) => row.wins + row.ties / 2;

/** Per-position pressure from designations alone: no projections or variance are invented. */
export function rosterPressure(
  settings: Pick<LeagueSettings, 'roster'>,
  roster: readonly SituationRosterPlayer[] | null
): Partial<Record<Position, RosterPressure>> {
  if (roster === null) return {};
  const out: Partial<Record<Position, RosterPressure>> = {};
  for (const position of POSITIONS) {
    const starters = settings.roster.slots[position] ?? 0;
    if (starters === 0) continue;
    const mine = roster.filter((p) => p.position === position);
    const available = mine.filter((p) => !WILL_NOT_PLAY_STATUSES.includes(p.status)).length;
    const healthy = mine.filter((p) => p.status === 'active').length;
    out[position] = available < starters ? 'short' : healthy <= starters ? 'thin' : 'covered';
  }
  return out;
}

interface Label {
  urgency: UrgencyLevel;
  basis: SituationBasis;
  reasons: SituationReason[];
  standing: SituationStanding | null;
}

const BASELINE = (reason: SituationReason): Label => ({
  urgency: 'baseline',
  basis: 'none',
  reasons: [reason],
  standing: null
});

/** The regular-season label from the final games through `throughWeek` (null: none yet). */
function regularSeasonLabel(
  input: SituationInput,
  games: readonly FinalizedMatchup[],
  throughWeek: number | null
) {
  const { startWeek, regularSeasonEndWeek } = input.settings.schedule;
  const teams = input.settings.playoffs.teams;
  const remaining = regularSeasonEndWeek - Math.max(throughWeek ?? startWeek - 1, startWeek - 1);
  const rows = computeStandings(
    input.settings,
    games.filter((g) => throughWeek !== null && g.week <= throughWeek),
    { teamIds: input.teamIds, ...(input.standingsSeed === undefined ? {} : { seed: input.standingsSeed }) }
  );
  const me = rows.find((r) => r.teamId === input.teamId);
  if (me === undefined) return { label: BASELINE('results_unavailable'), remaining };
  const others = rows.filter((r) => r.teamId !== input.teamId);
  // Against the first team out when in position, else the last team in (a race always has both).
  const cushion = points(me) - points(rows[me.rank <= teams ? teams : teams - 1] as StandingsRow);
  const standing: SituationStanding = {
    rank: me.rank,
    record: formatRecord(me),
    gamesPlayed: me.gamesPlayed,
    cushion,
    playoffTeams: teams
  };
  const exact = (urgency: UrgencyLevel, reasons: SituationReason[]): Label => ({
    urgency,
    basis: 'exact',
    reasons,
    standing
  });
  // Sufficient conditions only: a team no remaining result can pull level with, or pass.
  if (remaining <= 0)
    return {
      label: exact(me.rank <= teams ? 'clinched' : 'eliminated', [
        'regular_season_final',
        me.rank <= teams ? 'clinched' : 'eliminated'
      ]),
      remaining: 0
    };
  if (others.filter((o) => points(o) > points(me) + remaining).length >= teams)
    return { label: exact('eliminated', ['eliminated']), remaining };
  if (others.filter((o) => points(o) + remaining >= points(me)).length < teams)
    return { label: exact('clinched', ['clinched']), remaining };
  if (me.gamesPlayed < SITUATION_RULES.minGames) return { label: BASELINE('early_season'), remaining };
  const heuristic = (urgency: UrgencyLevel, reasons: SituationReason[]): Label => ({
    urgency,
    basis: 'heuristic',
    reasons,
    standing
  });
  if (me.rank <= teams)
    return {
      label:
        cushion >= SITUATION_RULES.contenderCushion
          ? heuristic('contender', ['in_playoff_position', 'comfortable_cushion'])
          : heuristic('bubble', ['in_playoff_position', 'thin_cushion']),
      remaining
    };
  return {
    label:
      -cushion <= Math.min(SITUATION_RULES.bubbleGamesBack, remaining)
        ? heuristic('bubble', ['outside_playoff_position', 'within_reach'])
        : heuristic('long_shot', ['outside_playoff_position', 'far_behind']),
    remaining
  };
}

/** Playoff weeks: seeded teams stay alive until they lose (a tie goes to the better seed). */
function playoffLabel(
  input: SituationInput,
  regular: readonly FinalizedMatchup[],
  playoff: readonly FinalizedMatchup[]
) {
  const rows = computeStandings(input.settings, regular, {
    teamIds: input.teamIds,
    ...(input.standingsSeed === undefined ? {} : { seed: input.standingsSeed })
  });
  const rank = new Map(rows.map((r) => [r.teamId, r.rank]));
  const mine = rank.get(input.teamId);
  const teams = input.settings.playoffs.teams;
  if (mine === undefined) return BASELINE('results_unavailable');
  const lost = playoff.some((g) => {
    const home = g.homeTeamId === input.teamId;
    if (!home && g.awayTeamId !== input.teamId) return false;
    const other = rank.get(home ? g.awayTeamId : g.homeTeamId) ?? Number.POSITIVE_INFINITY;
    const result = matchupResult(g.homeScore, g.awayScore);
    const mineResult = home ? result.home : result.away;
    return mineResult === 'L' || (mineResult === 'T' && other < mine);
  });
  const alive = mine <= teams && !lost;
  return {
    urgency: alive ? 'playoff_alive' : 'eliminated',
    basis: 'exact',
    reasons: [alive ? 'playoff_alive' : 'playoff_out'],
    standing: null
  } satisfies Label;
}

function horizonFor(urgency: UrgencyLevel, reasons: readonly SituationReason[]): PlanningHorizon {
  switch (urgency) {
    case 'clinched':
      return 'playoff_weeks';
    case 'bubble':
      return reasons.includes('final_stretch') ? 'this_week' : 'next_few_weeks';
    case 'long_shot':
    case 'eliminated':
    case 'playoff_alive':
      return 'this_week';
    default:
      return 'season';
  }
}

/**
 * The manager's situation, recomputed from finalized results with hysteresis (see the top of this
 * file). Deterministic: the same inputs always give the same state, whatever order events arrived in.
 */
export function computeSituation(input: SituationInput): SituationalState {
  const pressure = rosterPressure(input.settings, input.roster);
  const base = {
    schemaVersion: 1 as const,
    week: input.week,
    sinceWeek: null,
    previous: null,
    pending: null,
    pressure
  };
  const done = (label: Label, extra: Partial<SituationalState> = {}): SituationalState => ({
    ...base,
    throughWeek: null,
    remainingWeeks: null,
    urgency: label.urgency,
    basis: label.basis,
    reasons: label.reasons,
    horizon: horizonFor(label.urgency, label.reasons),
    standing: label.standing,
    ...extra
  });
  if (input.phase !== 'regular_season' && input.phase !== 'playoffs') return done(BASELINE('not_in_season'));
  if (input.finalized === null) return done(BASELINE('results_unavailable'));
  // Every team qualifies: there is no race to read, only seeding, which this slice leaves alone.
  if (input.settings.playoffs.teams >= input.teamIds.length && input.phase === 'regular_season')
    return done(BASELINE('no_playoff_race'));
  const { startWeek, regularSeasonEndWeek } = input.settings.schedule;
  // Never a game from the future of the decision: a replay passes only what was final then.
  // A redelivered or corrected game counts once, with its latest score.
  const byGame = new Map(input.finalized.map((g) => [`${g.week}:${g.homeTeamId}:${g.awayTeamId}`, g]));
  const known = [...byGame.values()].filter((g) => input.week === null || g.week <= input.week);
  const regular = known.filter(
    (g) => g.kind === 'regular' && g.week >= startWeek && g.week <= regularSeasonEndWeek
  );
  const weeks = [...new Set(regular.map((g) => g.week))].sort((a, b) => a - b);
  const throughWeek = weeks.at(-1) ?? null;

  if (input.phase === 'playoffs') {
    const label = playoffLabel(
      input,
      regular,
      known.filter((g) => g.kind === 'playoff')
    );
    return done(label, { throughWeek, remainingWeeks: 0 });
  }

  // Walk the finalized weeks in order: exact labels apply at once, heuristic ones need confirming.
  let current = regularSeasonLabel(input, regular, null);
  let effective = current.label;
  let sinceWeek: number | null = null;
  let previous: UrgencyLevel | null = null;
  let candidate: UrgencyLevel | null = null;
  let streak = 0;
  for (const week of weeks) {
    current = regularSeasonLabel(input, regular, week);
    const label = current.label;
    if (label.urgency === effective.urgency) {
      effective = label;
      candidate = null;
      continue;
    }
    streak = label.urgency === candidate ? streak + 1 : 1;
    candidate = label.urgency;
    if (label.basis !== 'heuristic' || streak >= SITUATION_RULES.confirmWeeks) {
      previous = effective.urgency;
      effective = label;
      sinceWeek = week;
      candidate = null;
    }
  }
  const pending = current.label.urgency !== effective.urgency ? current.label.urgency : null;
  // The latest week decides the stretch, even while a label change waits for confirmation.
  const stretch = effective.basis === 'heuristic' && current.remaining <= SITUATION_RULES.finalStretchWeeks;
  return done(
    {
      ...effective,
      reasons: [
        ...effective.reasons,
        ...(stretch ? (['final_stretch'] as const) : []),
        ...(pending === null ? [] : (['awaiting_confirmation'] as const))
      ],
      standing: current.label.standing
    },
    { throughWeek, remainingWeeks: current.remaining, sinceWeek, previous, pending }
  );
}

/** A lever's situational adjustment, added to the archetype's value and then clamped to 0-1. */
export interface SituationalModifiers {
  /** Added to the check-in's chance to look at the trade market (`checkInTradeChance`). */
  tradeLook: number;
  /** Added to waiver aggressiveness: the FAAB share (`suggestFaabBid`) and claim bar (`waiverMinGain`). */
  waiverAggressiveness: number;
  /** Added to lineup risk tolerance for injury-designated players (`lineupProjection`). */
  riskTolerance: number;
}

/** Hard caps on the summed adjustments: a situation bends an archetype, never replaces it. */
export const MODIFIER_CAPS: Readonly<Record<keyof SituationalModifiers, { min: number; max: number }>> = {
  tradeLook: { min: -0.1, max: 0.15 },
  waiverAggressiveness: { min: -0.1, max: 0.15 },
  riskTolerance: { min: -0.1, max: 0.1 }
};

const NONE: SituationalModifiers = { tradeLook: 0, waiverAggressiveness: 0, riskTolerance: 0 };

/**
 * Starting policies to evaluate (#211), not claims that every trailing team should gamble. An
 * eliminated team and the baseline keep the archetype unchanged.
 */
export const URGENCY_MODIFIERS: Readonly<Record<UrgencyLevel, SituationalModifiers>> = {
  baseline: NONE,
  clinched: { tradeLook: -0.05, waiverAggressiveness: -0.05, riskTolerance: -0.05 },
  contender: { tradeLook: 0, waiverAggressiveness: 0, riskTolerance: -0.05 },
  bubble: { tradeLook: 0.1, waiverAggressiveness: 0.1, riskTolerance: 0.05 },
  long_shot: { tradeLook: 0.15, waiverAggressiveness: 0.1, riskTolerance: 0.1 },
  eliminated: NONE,
  playoff_alive: { tradeLook: 0, waiverAggressiveness: 0.1, riskTolerance: 0.05 }
};

/** Extra waiver effort while a position cannot field its starters (an injury crisis). */
export const SHORT_POSITION_WAIVER_BOOST = 0.05;

/** Levels that protect depth at thin positions: they plan beyond this week. */
const DEPTH_PRESERVING: ReadonlySet<UrgencyLevel> = new Set(['clinched', 'contender']);

export interface EffectiveBehavior {
  urgency: UrgencyLevel;
  basis: SituationBasis;
  horizon: PlanningHorizon;
  /** The capped adjustments actually applied. */
  modifiers: SituationalModifiers;
  tradeLookChance: number;
  waiverAggressiveness: number;
  waiverMinGain: number;
  riskTolerance: number;
  /** Positions whose last healthy bodies are not dropped or traded away for another position. */
  protectDepth: Position[];
  /** Base to effective, one line per lever that moved, with why. */
  explanation: string[];
}

const clamp = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Base archetype + bounded situational modifiers = effective behavior. Without a situation (it
 * could not be read) the result is exactly the archetype's baseline. Trade cadence, accept edges,
 * valuation floors, FAAB limits, locks, action limits, and tools are not inputs and cannot change.
 */
export function composeBehavior(
  config: Pick<ResolvedAgentConfig, 'tradeFrequency' | 'waiverAggressiveness' | 'valuation'>,
  situation?: SituationalState
): EffectiveBehavior {
  const urgency = situation?.urgency ?? 'baseline';
  const short = Object.values(situation?.pressure ?? {}).includes('short');
  const raw = URGENCY_MODIFIERS[urgency];
  const modifiers: SituationalModifiers = {
    tradeLook: round2(clamp(raw.tradeLook, MODIFIER_CAPS.tradeLook.min, MODIFIER_CAPS.tradeLook.max)),
    waiverAggressiveness: round2(
      clamp(
        raw.waiverAggressiveness + (short ? SHORT_POSITION_WAIVER_BOOST : 0),
        MODIFIER_CAPS.waiverAggressiveness.min,
        MODIFIER_CAPS.waiverAggressiveness.max
      )
    ),
    riskTolerance: round2(
      clamp(raw.riskTolerance, MODIFIER_CAPS.riskTolerance.min, MODIFIER_CAPS.riskTolerance.max)
    )
  };
  const baseTrade = checkInTradeChance(config.tradeFrequency);
  const baseRisk = config.valuation.riskTolerance ?? 0.5;
  const tradeLookChance = round2(clamp(baseTrade + modifiers.tradeLook, 0, 1));
  const waiverAggressiveness = round2(
    clamp(config.waiverAggressiveness + modifiers.waiverAggressiveness, 0, 1)
  );
  const riskTolerance = round2(clamp(baseRisk + modifiers.riskTolerance, 0, 1));
  const protectDepth = DEPTH_PRESERVING.has(urgency)
    ? (Object.entries(situation?.pressure ?? {}) as [Position, RosterPressure][])
        .filter(([, p]) => p !== 'covered')
        .map(([position]) => position)
    : [];
  const why = `${urgency}${short ? ', short-handed' : ''}`;
  const moved = (name: string, from: number, to: number) =>
    from === to ? [] : [`${name} ${round2(from)} -> ${to} (${why})`];
  return {
    urgency,
    basis: situation?.basis ?? 'none',
    horizon: situation?.horizon ?? 'season',
    modifiers,
    tradeLookChance,
    waiverAggressiveness,
    waiverMinGain: waiverMinGain(waiverAggressiveness),
    riskTolerance,
    protectDepth,
    explanation: [
      ...moved('trade look chance', baseTrade, tradeLookChance),
      ...moved('waiver aggressiveness', config.waiverAggressiveness, waiverAggressiveness),
      ...moved('lineup risk tolerance', baseRisk, riskTolerance),
      ...(protectDepth.length === 0 ? [] : [`protect depth at ${protectDepth.join(', ')} (${urgency})`])
    ]
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const games = (n: number) => plural(Math.abs(n), 'game');

/**
 * The situation in words a manager could say in public: standings and injury designations are
 * league-visible, and nothing here names a bid, a bar, or a lever. Decision and chat prompts get the
 * same lines, so what the manager says matches what the deterministic code does.
 */
export function situationPrompt(state: SituationalState | undefined): string[] {
  if (state === undefined) return [];
  const s = state.standing;
  const left = state.remainingWeeks === null ? '' : ` with ${plural(state.remainingWeeks, 'week')} left`;
  const at = s === null ? '' : `${s.record}, ${ordinal(s.rank)}`;
  const guess = 'This is a read of the standings, not a certainty: do not claim otherwise.';
  const lines: string[] = [];
  switch (state.urgency) {
    case 'baseline':
      if (state.reasons.includes('early_season'))
        lines.push(
          'Too early to read the standings. Play your normal game, and do not talk as if the season is decided either way.'
        );
      break;
    case 'clinched':
      lines.push(
        `You have clinched a playoff spot${at === '' ? '' : ` (${at})`}. Keep your depth for the playoff weeks.`
      );
      break;
    case 'contender':
      lines.push(
        `You are ${at}, in a playoff spot ${games(s?.cushion ?? 0)} clear of the first team out${left}. ${guess} Plan for the whole season and protect your depth.`
      );
      break;
    case 'bubble':
      lines.push(
        `You are ${at}, on the playoff bubble${left}. ${guess} Points in the next few weeks matter most: lean toward immediate production.`
      );
      break;
    case 'long_shot':
      lines.push(
        `You are ${at}, ${games(s?.cushion ?? 0)} behind the last playoff spot${left}: a long shot, not eliminated. ${guess} Chase what helps this week.`
      );
      break;
    case 'eliminated':
      lines.push(
        'You cannot make the playoffs. Still start your best legal lineup every week and make only moves that improve your own team; never dump players or help another team.'
      );
      break;
    case 'playoff_alive':
      lines.push(
        'You are alive in the playoffs: this week is win or go home. Start your best lineup for this week.'
      );
      break;
  }
  const short = (Object.entries(state.pressure) as [Position, RosterPressure][])
    .filter(([, p]) => p === 'short')
    .map(([position]) => position);
  if (short.length > 0) lines.push(`Injuries leave you short at ${short.join(', ')} this week.`);
  return lines;
}

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${tail}`;
}
