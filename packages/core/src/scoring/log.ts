import { roundPoints, scorePlayer, type ScoringSource, type StatLine } from './engine.js';
import type { ScoringSettings } from './settings.js';

/**
 * The matchup scoring log (#162). Live stats arrive as a player's whole stat line every couple of
 * minutes; each time it changes, that is a scoring event. Events are stored once per week for every
 * league (the full stat line after the change), and each league scores them with its own rules at
 * read time: an event's points are score(line after) − score(line before), where "before" is the
 * player's previous event (or an empty line for his first one that week). The points therefore
 * telescope: a player's event points always add up to exactly his week score.
 */

/** Where an event came from: a live stats read, or the official final's stat corrections (#80). */
export type ScoringEventKind = 'live' | 'correction';

export interface ScoringEvent {
  playerId: string;
  /** ISO time the change was seen; events of a player are ordered by it. */
  at: string;
  kind: ScoringEventKind;
  /** The player's whole stat line after the change. */
  stats: StatLine;
}

export interface StatChange {
  stat: string;
  /** after − before, cleaned of float noise. */
  delta: number;
}

export interface ScoredEvent {
  event: ScoringEvent;
  /** The changed stats the league scores, sorted by stat key. */
  changes: StatChange[];
  /** Points this change was worth under the league's rules (2 decimals, may be negative). */
  points: number;
  /** A touchdown was scored (any `*_td` stat went up). */
  touchdown: boolean;
  /** "+1 rec, +18 rec yds, +1 rec TD". Empty when no scored stat changed. */
  summary: string;
}

/**
 * Stats that change on every play without being scored themselves: Sleeper's precomputed points and
 * the games and snap counts. A line where only these moved is not an event.
 */
const VOLATILE_STATS = new Set(['pts_std', 'pts_ppr', 'pts_half_ppr', 'gp', 'gs', 'gms_active']);

function isVolatile(stat: string): boolean {
  return VOLATILE_STATS.has(stat) || stat.endsWith('_snp');
}

function num(line: StatLine | undefined, stat: string): number {
  const v = line?.[stat];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function clean(value: number): number {
  const cleaned = Math.round(value * 1e6) / 1e6;
  return cleaned === 0 ? 0 : cleaned;
}

/** Every stat whose value differs between two lines (a missing stat counts as 0), sorted by key. */
export function statChanges(before: StatLine | undefined, after: StatLine): StatChange[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  return [...keys]
    .sort()
    .map((stat) => ({ stat, delta: clean(num(after, stat) - num(before, stat)) }))
    .filter((c) => c.delta !== 0);
}

/**
 * Whether a newly fetched line is a scoring event against the stored one: some stat other than the
 * volatile ones changed. The first line of a player's week counts against an empty line.
 */
export function isScoringChange(before: StatLine | undefined, after: StatLine): boolean {
  return statChanges(before, after).some((c) => !isVolatile(c.stat));
}

function scoring(source: ScoringSource): ScoringSettings {
  return 'scoring' in source ? source.scoring : source;
}

/** The stats a league's rules give points for: a nonzero per-stat weight, or a tier rule. */
export function scoredStats(source: ScoringSource): Set<string> {
  const rules = scoring(source);
  return new Set([
    ...Object.entries(rules.perStat)
      .filter(([, weight]) => weight !== 0)
      .map(([stat]) => stat),
    ...rules.tiers.map((t) => t.stat)
  ]);
}

/** Points as whole cents, so sums of event points are exact. */
export function toCents(points: number): number {
  return Math.round(points * 100);
}

/** Adds point values exactly (in cents). */
export function sumPoints(points: readonly number[]): number {
  return roundPoints(points.reduce((acc, p) => acc + toCents(p), 0) / 100);
}

const isTouchdownStat = (stat: string) => stat.endsWith('_td');

/**
 * Scores one player's week of events with a league's rules, oldest first. Each event's points are
 * the change in his score from the previous event's line (an empty line before the first), so the
 * points sum to exactly `scorePlayer(settings, lastLine).points`. Events of other players are
 * rejected, since mixing players would break that sum.
 */
export function scorePlayerEvents(settings: ScoringSource, events: readonly ScoringEvent[]): ScoredEvent[] {
  const ordered = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const playerIds = new Set(ordered.map((e) => e.playerId));
  if (playerIds.size > 1) throw new Error('scorePlayerEvents takes one player’s events');
  const scored = scoredStats(settings);
  const out: ScoredEvent[] = [];
  let before: StatLine = {};
  let beforeCents = 0;
  for (const event of ordered) {
    const afterCents = toCents(scorePlayer(settings, event.stats).points);
    const changes = statChanges(before, event.stats).filter((c) => scored.has(c.stat));
    out.push({
      event,
      changes,
      points: roundPoints((afterCents - beforeCents) / 100),
      touchdown: changes.some((c) => isTouchdownStat(c.stat) && c.delta > 0),
      summary: describeChanges(changes)
    });
    before = event.stats;
    beforeCents = afterCents;
  }
  return out;
}

/** Short log labels, singular and plural. Unknown stats fall back to their key. */
export const LOG_STAT_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  pass_yd: ['pass yd', 'pass yds'],
  pass_td: ['pass TD', 'pass TDs'],
  pass_int: ['INT thrown', 'INTs thrown'],
  pass_2pt: ['pass 2-pt', 'pass 2-pts'],
  pass_cmp: ['completion', 'completions'],
  pass_att: ['pass attempt', 'pass attempts'],
  pass_inc: ['incompletion', 'incompletions'],
  pass_sack: ['sack taken', 'sacks taken'],
  pass_fd: ['passing 1st down', 'passing 1st downs'],
  rush_yd: ['rush yd', 'rush yds'],
  rush_td: ['rush TD', 'rush TDs'],
  rush_2pt: ['rush 2-pt', 'rush 2-pts'],
  rush_att: ['carry', 'carries'],
  rush_fd: ['rushing 1st down', 'rushing 1st downs'],
  rec: ['rec', 'rec'],
  rec_yd: ['rec yd', 'rec yds'],
  rec_td: ['rec TD', 'rec TDs'],
  rec_2pt: ['rec 2-pt', 'rec 2-pts'],
  rec_tgt: ['target', 'targets'],
  rec_fd: ['receiving 1st down', 'receiving 1st downs'],
  fum: ['fumble', 'fumbles'],
  fum_lost: ['fumble lost', 'fumbles lost'],
  fum_rec_td: ['fumble recovery TD', 'fumble recovery TDs'],
  st_td: ['return TD', 'return TDs'],
  kr_yd: ['kick return yd', 'kick return yds'],
  pr_yd: ['punt return yd', 'punt return yds'],
  fgm_0_19: ['FG (0-19)', 'FGs (0-19)'],
  fgm_20_29: ['FG (20-29)', 'FGs (20-29)'],
  fgm_30_39: ['FG (30-39)', 'FGs (30-39)'],
  fgm_40_49: ['FG (40-49)', 'FGs (40-49)'],
  fgm_50p: ['FG (50+)', 'FGs (50+)'],
  fgmiss_0_19: ['missed FG (0-19)', 'missed FGs (0-19)'],
  fgmiss_20_29: ['missed FG (20-29)', 'missed FGs (20-29)'],
  fgmiss_30_39: ['missed FG (30-39)', 'missed FGs (30-39)'],
  fgmiss_40_49: ['missed FG (40-49)', 'missed FGs (40-49)'],
  fgmiss_50p: ['missed FG (50+)', 'missed FGs (50+)'],
  fgm_yds: ['FG yd', 'FG yds'],
  xpm: ['XP', 'XPs'],
  xpmiss: ['missed XP', 'missed XPs'],
  sack: ['sack', 'sacks'],
  int: ['INT', 'INTs'],
  fum_rec: ['fumble recovery', 'fumble recoveries'],
  ff: ['forced fumble', 'forced fumbles'],
  def_td: ['defensive TD', 'defensive TDs'],
  def_st_td: ['special teams TD', 'special teams TDs'],
  def_st_fum_rec: ['special teams fumble recovery', 'special teams fumble recoveries'],
  def_2pt: ['2-pt return', '2-pt returns'],
  safe: ['safety', 'safeties'],
  blk_kick: ['blocked kick', 'blocked kicks'],
  def_4_and_stop: ['4th-down stop', '4th-down stops'],
  pts_allow: ['pt allowed', 'pts allowed'],
  yds_allow: ['yd allowed', 'yds allowed']
};

function label(stat: string, amount: number): string {
  const labels = LOG_STAT_LABELS[stat];
  if (labels === undefined) return stat;
  return Math.abs(amount) === 1 ? labels[0] : labels[1];
}

function formatAmount(delta: number): string {
  const abs = Math.abs(delta);
  const text = Number.isInteger(abs) ? String(abs) : String(Math.round(abs * 100) / 100);
  return `${delta > 0 ? '+' : '-'}${text}`;
}

/** "+1 rec, +18 rec yds, +1 rec TD": yards and catches first, touchdowns last. */
export function describeChanges(changes: readonly StatChange[]): string {
  const ordered = [...changes].sort(
    (a, b) =>
      Number(isTouchdownStat(a.stat)) - Number(isTouchdownStat(b.stat)) || order(a.stat) - order(b.stat)
  );
  return ordered.map((c) => `${formatAmount(c.delta)} ${label(c.stat, c.delta)}`).join(', ');
}

const LABEL_ORDER = Object.keys(LOG_STAT_LABELS);
function order(stat: string): number {
  const i = LABEL_ORDER.indexOf(stat);
  return i === -1 ? LABEL_ORDER.length : i;
}
