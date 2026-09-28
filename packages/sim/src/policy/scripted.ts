import { autopick, hashString, optimizeLineup, type LineupEntry, type RosterPlayer } from '@fantasy/core';
import { byId } from '../players.js';
import type { ClaimRequest, DraftContext, LineupContext, TeamPolicy, WaiverContext } from './types.js';

export interface ScriptedPolicyOptions {
  /** Relative, per-team jitter on draft rankings, so teams draft differently (0 = pure projections). */
  draftJitter?: number;
  /** Claims submitted per waiver run. */
  maxClaims?: number;
  /** A free agent is a target when he is trending or projects at least this many points this week. */
  highProjection?: number;
  /** Minimum improvement (in blended projected points) over the player he would replace. */
  minGain?: number;
  /** Dollars bid per point of improvement. */
  bidPerPoint?: number;
  /** Extra dollars for a trending player. */
  trendingBonus?: number;
}

const DEFAULTS: Required<ScriptedPolicyOptions> = {
  draftJitter: 0.15,
  maxClaims: 2,
  highProjection: 10,
  minGain: 1.5,
  bidPerPoint: 2,
  trendingBonus: 3
};

/** A deterministic number in [0, 1) for a key. */
function unit(key: string): number {
  return hashString(key) / 4294967296;
}

/** Draft rankings: projected points, jittered per team, best first (ids with no projection come last). */
export function draftRankings(ctx: DraftContext, jitter: number): string[] {
  const scored = ctx.available
    .filter((p) => ctx.projections[p.playerId] !== undefined)
    .map((p) => {
      const base = ctx.projections[p.playerId] as number;
      const noise = 1 + jitter * (unit(`${ctx.seed}:${ctx.teamId}:${p.playerId}`) * 2 - 1);
      return { id: p.playerId, score: base * noise };
    });
  return scored.sort((a, b) => b.score - a.score || byId(a.id, b.id)).map((s) => s.id);
}

/**
 * The scripted bot used by simulations:
 * - **draft:** core `autopick` over the projections published before the draft, with a small per-team jitter;
 * - **lineups:** core `optimizeLineup` on this week's projections (it respects locks, byes, and injuries);
 * - **waivers:** targets trending or high-projection free agents that beat the weakest rostered player at
 *   the same position by `minGain` blended points (half this week, half season-to-date), and bids
 *   `bidPerPoint` dollars per point of gain (+ `trendingBonus` when trending), within the budget.
 */
export function scriptedPolicy(options: ScriptedPolicyOptions = {}): TeamPolicy {
  const o = { ...DEFAULTS, ...options };
  return {
    name: 'scripted',
    draftPick(ctx: DraftContext): string | null {
      const rankings = draftRankings(ctx, o.draftJitter);
      return autopick(ctx.draft, ctx.available, rankings, { roster: ctx.settings.roster })?.playerId ?? null;
    },
    lineup(ctx: LineupContext): LineupEntry[] {
      return optimizeLineup(ctx.settings, ctx.roster, ctx.projections, {
        games: ctx.games,
        now: ctx.now,
        previousLineup: ctx.currentLineup
      }).lineup;
    },
    waiverClaims(ctx: WaiverContext): ClaimRequest[] {
      const blended = (id: string): number => ((ctx.projections[id] ?? 0) + (ctx.values[id] ?? 0)) / 2;
      const primary = (p: RosterPlayer): string | undefined => p.positions[0];
      const targets = ctx.freeAgents
        .filter((fa) => fa.projection > 0 && (fa.trending || fa.projection >= o.highProjection))
        .sort(
          (a, b) =>
            blended(b.player.playerId) - blended(a.player.playerId) ||
            byId(a.player.playerId, b.player.playerId)
        );
      const claims: ClaimRequest[] = [];
      const dropping = new Set<string>();
      let budget = ctx.faabRemaining;
      for (const fa of targets) {
        if (claims.length >= o.maxClaims) break;
        const weakest = ctx.roster
          .filter((p) => primary(p) === primary(fa.player) && !dropping.has(p.playerId))
          .sort((a, b) => blended(a.playerId) - blended(b.playerId) || byId(a.playerId, b.playerId))[0];
        if (!weakest) continue;
        const gain = blended(fa.player.playerId) - blended(weakest.playerId);
        if (gain < o.minGain) continue;
        const bid = Math.max(
          0,
          Math.min(budget, Math.floor(gain * o.bidPerPoint) + (fa.trending ? o.trendingBonus : 0))
        );
        claims.push({ addPlayerId: fa.player.playerId, dropPlayerId: weakest.playerId, bid });
        dropping.add(weakest.playerId);
        budget -= bid;
      }
      return claims;
    }
  };
}
