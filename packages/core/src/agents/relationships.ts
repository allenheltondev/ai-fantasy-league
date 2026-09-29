import { tradeDirection, type AgentLeagueMemory, type ResultMemory, type TradeMemory } from './memory.js';

/**
 * How an agent gets along with each other team (#210): a small, bounded relationship model computed
 * from the agent's league records (matchup results and trades), so relationships can warm up, turn
 * into a rivalry, cool off, and be repaired, instead of only piling up grudges.
 *
 * Three dimensions, each from 0 to `BOND_MAX`, each fading with its own half-life:
 * - `warmth`: good history. A deal that went through fair adds it (and a vetoed deal both sides
 *   wanted adds a little).
 * - `rivalry`: competition without bad blood. Every game against them adds it, a close one more.
 * - `grudge`: bad blood. A blowout loss, an offer they turned down, or a trade they won by the
 *   agent's own numbers adds it. A fair deal repairs it (`REPAIR_ON_FAIR_TRADE`), and time heals it
 *   fastest of the three.
 *
 * Only records feed it: model-written notes and chat lines about a team are beliefs, shown beside
 * the relationship but never counted in it, so no chat message and no note can buy goodwill or pick
 * a fight. It is a pure function of the records and the time it is read, so a replay reads the same.
 * It is never stored: a corrected record (the official final after stat corrections) corrects the
 * relationship the next time it is read.
 *
 * What it may change (the design decision, also in `behavior.ts`): how the agent talks (the prompt
 * shows the stance), and which of the options the deterministic code already vetted the model picks
 * (a trade partner it likes, an offer it answers). It never moves a floor, a bar, or a legality check.
 */

export const BOND_MAX = 10;

/** Days for each dimension to halve on its own: grudges fade fastest, goodwill lasts longest. */
export const BOND_HALF_LIFE_DAYS = { grudge: 21, rivalry: 35, warmth: 49 } as const;

/** A game decided by less than this is a close one (it builds more rivalry). */
export const CLOSE_GAME_MARGIN = 10;
/** A loss by at least this much is a blowout (it leaves a little bad blood). */
export const BLOWOUT_LOSS_MARGIN = 30;
/** A done deal the agent lost by at least this much by its own trade value math: it feels fleeced. */
export const FLEECED_VALUE = 15;
/** Grudge a fair done deal takes away (the repair). */
export const REPAIR_ON_FAIR_TRADE = 2;

export type BondStance =
  'neutral' | 'on_good_terms' | 'friendly_rivals' | 'rivals' | 'wary' | 'grudge' | 'mending' | 'cooling';

export interface Bond {
  teamId: string;
  warmth: number;
  rivalry: number;
  grudge: number;
  /** The biggest grudge held at any point in the kept records (before later decay and repair). */
  peakGrudge: number;
  stance: BondStance;
  /** What happened between them, newest first (from records only). */
  reasons: string[];
  /** When the latest record with this team happened. */
  at: string;
}

/** One record's effect on a relationship. */
interface Moment {
  teamId: string;
  at: string;
  warmth: number;
  rivalry: number;
  grudge: number;
  repair: number;
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const clampBond = (x: number) => Math.min(BOND_MAX, Math.max(0, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

function decay(value: number, fromIso: string, toIso: string, halfLifeDays: number): number {
  const days = (Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS;
  if (!Number.isFinite(days) || days <= 0) return value;
  return value * 0.5 ** (days / halfLifeDays);
}

function resultMoment(r: ResultMemory): Moment {
  const margin = round2(r.pointsFor - r.pointsAgainst);
  const close = Math.abs(margin) < CLOSE_GAME_MARGIN;
  const verb =
    margin > 0
      ? close
        ? 'edged'
        : 'beat'
      : margin < 0
        ? close
          ? 'lost a close one to'
          : 'lost to'
        : 'tied';
  return {
    teamId: r.teamId,
    at: r.at,
    warmth: 0,
    rivalry: close ? 2 : 1,
    grudge: margin <= -BLOWOUT_LOSS_MARGIN ? 1.5 : 0,
    repair: 0,
    reason: `week ${r.week} you ${verb} them ${r.pointsFor}-${r.pointsAgainst}${r.corrected === true ? ' (after stat corrections)' : ''}`
  };
}

function tradeMoment(t: TradeMemory): Moment | null {
  const base = { teamId: t.teamId, at: t.at, warmth: 0, rivalry: 0, grudge: 0, repair: 0 };
  const outgoing = tradeDirection(t) === 'outgoing';
  switch (t.outcome) {
    case 'rejected':
      return outgoing ? { ...base, grudge: 1, reason: 'they turned down your offer' } : null;
    case 'expired':
      return outgoing ? { ...base, grudge: 0.5, reason: 'they let your offer expire' } : null;
    case 'countered':
      return { ...base, rivalry: 0.5, reason: 'you haggled over a trade' };
    case 'vetoed':
      return { ...base, warmth: 1, reason: 'the league vetoed a deal you both wanted' };
    case 'accepted':
    case 'processed':
      if (t.value !== undefined && t.value <= -FLEECED_VALUE)
        return { ...base, warmth: 0.5, grudge: 2, reason: 'they won a trade off you by your own numbers' };
      return { ...base, warmth: 2, repair: REPAIR_ON_FAIR_TRADE, reason: 'a fair trade went through' };
    default:
      return null;
  }
}

/** The records' effect on each relationship, oldest first (ties broken by team and reason). */
function moments(memory: AgentLeagueMemory): Moment[] {
  const all: Moment[] = [
    // Grudges stored before #210: a starting grudge that decays like any other.
    ...memory.rivals.map((r) => ({
      teamId: r.teamId,
      at: r.at,
      warmth: 0,
      rivalry: 0,
      grudge: Math.min(r.grudge, BOND_MAX / 2),
      repair: 0,
      reason: 'an old grudge'
    })),
    ...memory.results.map(resultMoment),
    ...memory.trades.map(tradeMoment).filter((m): m is Moment => m !== null)
  ];
  return all.sort(
    (a, b) => a.at.localeCompare(b.at) || a.teamId.localeCompare(b.teamId) || a.reason.localeCompare(b.reason)
  );
}

export function bondStance(b: Pick<Bond, 'warmth' | 'rivalry' | 'grudge' | 'peakGrudge'>): BondStance {
  if (b.grudge >= 3 && b.grudge > b.warmth) return 'grudge';
  if (b.peakGrudge >= 2 && b.grudge <= b.peakGrudge / 2) return b.warmth >= 1.5 ? 'mending' : 'cooling';
  if (b.warmth >= 1.5) return b.rivalry >= 3 ? 'friendly_rivals' : 'on_good_terms';
  if (b.grudge >= 1) return 'wary';
  if (b.rivalry >= 2) return 'rivals';
  return 'neutral';
}

/**
 * Every relationship the records support, read at `now` (ISO; defaults to the newest record, so a
 * read without a clock is still deterministic). Strongest first.
 */
export function relationshipsFrom(memory: AgentLeagueMemory, now?: string): Bond[] {
  const list = moments(memory);
  const at = now ?? list.at(-1)?.at;
  const bonds = new Map<string, Bond>();
  for (const m of list) {
    const b = bonds.get(m.teamId);
    const fade = (key: keyof typeof BOND_HALF_LIFE_DAYS) =>
      b === undefined ? 0 : decay(b[key], b.at, m.at, BOND_HALF_LIFE_DAYS[key]);
    const grudge = clampBond(Math.max(0, fade('grudge') - m.repair) + m.grudge);
    bonds.set(m.teamId, {
      teamId: m.teamId,
      warmth: clampBond(fade('warmth') + m.warmth),
      rivalry: clampBond(fade('rivalry') + m.rivalry),
      grudge,
      peakGrudge: Math.max(b?.peakGrudge ?? 0, grudge),
      stance: 'neutral',
      reasons: [m.reason, ...(b?.reasons ?? [])].slice(0, 3),
      // Moments come oldest first, so this one is the newest so far.
      at: m.at
    });
  }
  return [...bonds.values()]
    .map((b) => {
      const read = (key: keyof typeof BOND_HALF_LIFE_DAYS) =>
        round2(at === undefined ? b[key] : decay(b[key], b.at, at, BOND_HALF_LIFE_DAYS[key]));
      const settled = {
        ...b,
        warmth: read('warmth'),
        rivalry: read('rivalry'),
        grudge: read('grudge'),
        peakGrudge: round2(b.peakGrudge)
      };
      return { ...settled, stance: bondStance(settled) };
    })
    .sort(
      (a, b) =>
        b.warmth + b.rivalry + b.grudge - (a.warmth + a.rivalry + a.grudge) ||
        a.teamId.localeCompare(b.teamId)
    );
}

/** The relationship with one team, or null when the records hold nothing about them. */
export function relationshipWith(memory: AgentLeagueMemory, teamId: string, now?: string): Bond | null {
  return relationshipsFrom(memory, now).find((b) => b.teamId === teamId) ?? null;
}

const STANCE_WORDS: Readonly<Record<BondStance, string>> = {
  neutral: 'no strong feelings either way',
  on_good_terms: 'on good terms: your dealings have been fair',
  friendly_rivals: 'friendly rivals: real competition, and goodwill from fair dealings',
  rivals: 'rivals: close games, no bad blood',
  wary: 'wary of them after a sour moment',
  grudge: 'you hold a grudge against them',
  mending: 'mending fences: an old grudge, eased by a fair deal since',
  cooling: 'an old grudge that time has cooled'
};

/** The stance in words, for the prompt (how it colors the agent's voice). */
export function stanceWords(stance: BondStance): string {
  return STANCE_WORDS[stance];
}
