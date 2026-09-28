import type { Position } from '../rules/positions.js';

/**
 * Notable picks and the draft recap (#50, #123). A pick is measured against the player's consensus
 * rank when he was taken (the ADP stand-in the board shows): a steal went well after it, a reach
 * well before it. How far is "well" grows with the pick, since ADP is noisier later in a draft: at
 * least a full round, or 40% of the pick number. Kickers and defenses are never steals or reaches;
 * their ranks say little about when leagues draft them. An agent's first-round pick is notable too,
 * so its reasoning reaches the chat.
 */

export const NOTABLE_PICK_KINDS = ['steal', 'reach', 'first_round'] as const;
export type NotablePickKind = (typeof NOTABLE_PICK_KINDS)[number];

export interface NotablePickInput {
  overall: number;
  round: number;
  adp: number | null;
  position: Position;
  /** True when an agent seat made the pick. */
  byAgent: boolean;
  teamCount: number;
}

const NO_VALUE_POSITIONS: readonly Position[] = ['K', 'DEF'];
const MARGIN_SHARE = 0.4;

/** How many picks from ADP a pick must land to be a steal or a reach. */
export function valueMargin(overall: number, teamCount: number): number {
  return Math.max(teamCount, Math.ceil(overall * MARGIN_SHARE));
}

/** Picks after ADP (positive: the player fell to this pick) or null when he is unranked. */
export function pickValue(overall: number, adp: number | null): number | null {
  return adp === null ? null : overall - adp;
}

export function notablePick(input: NotablePickInput): NotablePickKind | null {
  const value = pickValue(input.overall, input.adp);
  if (value !== null && !NO_VALUE_POSITIONS.includes(input.position)) {
    const margin = valueMargin(input.overall, input.teamCount);
    if (value >= margin) return 'steal';
    if (-value >= margin) return 'reach';
  }
  return input.byAgent && input.round === 1 ? 'first_round' : null;
}

export interface RecapPick {
  overall: number;
  round: number;
  teamId: string;
  playerId: string;
  position: Position;
  adp: number | null;
  reason: string | null;
  byAgent: boolean;
}

export interface RecapEntry {
  overall: number;
  round: number;
  teamId: string;
  playerId: string;
  adp: number | null;
  /** Picks after ADP; negative for a reach. */
  value: number | null;
  reason: string | null;
}

export interface DraftRecap {
  picks: number;
  /** The biggest steals, best first. */
  steals: RecapEntry[];
  /** The biggest reaches, biggest first. */
  reaches: RecapEntry[];
  /** Each agent team's first pick, with its reasoning, in draft order. */
  agentPicks: RecapEntry[];
}

/** How many steals and reaches the recap names. */
export const RECAP_TOP = 3;

const entry = (p: RecapPick): RecapEntry => ({
  overall: p.overall,
  round: p.round,
  teamId: p.teamId,
  playerId: p.playerId,
  adp: p.adp,
  value: pickValue(p.overall, p.adp),
  reason: p.reason
});

export function draftRecap(picks: readonly RecapPick[], teamCount: number): DraftRecap {
  const sorted = [...picks].sort((a, b) => a.overall - b.overall);
  const kinds = sorted.map((p) => ({ p, kind: notablePick({ ...p, teamCount }) }));
  const byValue = (kind: NotablePickKind, sign: 1 | -1) =>
    kinds
      .filter((k) => k.kind === kind)
      .map((k) => entry(k.p))
      .sort((a, b) => sign * ((b.value as number) - (a.value as number)) || a.overall - b.overall)
      .slice(0, RECAP_TOP);
  const firstPicks = new Map<string, RecapPick>();
  for (const p of sorted) if (p.byAgent && !firstPicks.has(p.teamId)) firstPicks.set(p.teamId, p);
  return {
    picks: sorted.length,
    steals: byValue('steal', 1),
    reaches: byValue('reach', -1),
    agentPicks: [...firstPicks.values()].map(entry)
  };
}

export interface RecapNames {
  team(teamId: string): string;
  player(playerId: string): string;
}

/** Longest reasoning quoted in the one-message recap; the board shows it in full. */
export const RECAP_REASON_MAX = 140;

const clip = (text: string) =>
  text.length <= RECAP_REASON_MAX ? text : `${text.slice(0, RECAP_REASON_MAX - 1).trimEnd()}…`;

/** The recap as one chat line. */
export function formatDraftRecap(recap: DraftRecap, names: RecapNames): string {
  const pick = (e: RecapEntry) =>
    `${names.team(e.teamId)} took ${names.player(e.playerId)} at pick ${e.overall}`;
  const adp = (e: RecapEntry) => (e.adp === null ? '' : ` (ADP ${e.adp})`);
  const parts = [`Draft recap: ${recap.picks} pick${recap.picks === 1 ? '' : 's'}.`];
  if (recap.steals.length > 0) parts.push(`Steals: ${recap.steals.map((e) => pick(e) + adp(e)).join('; ')}.`);
  if (recap.reaches.length > 0)
    parts.push(`Reaches: ${recap.reaches.map((e) => pick(e) + adp(e)).join('; ')}.`);
  for (const e of recap.agentPicks) {
    parts.push(e.reason === null ? `${pick(e)}.` : `${pick(e)}: "${clip(e.reason)}"`);
  }
  return parts.join(' ');
}
