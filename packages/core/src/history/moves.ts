/**
 * How roster moves turned out (#76), as pure functions. A waiver pickup is a hit when the player a
 * team claimed scored more for it, over the weeks it rostered him, than the player it dropped for
 * him scored over those same weeks.
 */

export interface WaiverPickup {
  teamId: string;
  /** The week the claim was awarded; the first week that can count. */
  week: number;
  addPlayerId: string;
  /** The player released for him, or null when the team had an open spot. */
  dropPlayerId: string | null;
}

export interface WaiverPickupOutcome extends WaiverPickup {
  /** Final weeks the team rostered the added player, from the claim's week on. */
  weeks: number[];
  /** Fantasy points the added player scored in those weeks. */
  addedPoints: number;
  /** Fantasy points the dropped player scored in the same weeks, wherever he played. */
  droppedPoints: number;
  /** `addedPoints - droppedPoints`. */
  netPoints: number;
  hit: boolean;
}

export interface MoveLookups {
  /** Whether a team had a player on its roster (any slot) in a week. */
  rostered(teamId: string, playerId: string, week: number): boolean;
  /** A player's fantasy points in a week (0 when he did not play). */
  points(playerId: string, week: number): number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One pickup's outcome over the final weeks up to `throughWeek`. */
export function waiverPickupOutcome(
  pickup: WaiverPickup,
  throughWeek: number,
  lookups: MoveLookups
): WaiverPickupOutcome {
  const weeks: number[] = [];
  for (let week = pickup.week; week <= throughWeek; week++) {
    if (lookups.rostered(pickup.teamId, pickup.addPlayerId, week)) weeks.push(week);
  }
  const sum = (playerId: string | null) =>
    playerId === null ? 0 : round2(weeks.reduce((t, w) => t + lookups.points(playerId, w), 0));
  const addedPoints = sum(pickup.addPlayerId);
  const droppedPoints = sum(pickup.dropPlayerId);
  return {
    ...pickup,
    weeks,
    addedPoints,
    droppedPoints,
    netPoints: round2(addedPoints - droppedPoints),
    hit: weeks.length > 0 && addedPoints > droppedPoints
  };
}

export interface WaiverHitRate {
  /** Pickups with at least one final week rostered (the only ones that can be judged). */
  claims: number;
  hits: number;
  /** `hits / claims`, 0 to 1; null without a judged claim. */
  hitRate: number | null;
  /** Points gained over the dropped players, summed. */
  netPoints: number;
}

/** Rolls pickup outcomes up; pickups not rostered through a final week yet are left out. */
export function waiverHitRate(outcomes: readonly WaiverPickupOutcome[]): WaiverHitRate {
  const judged = outcomes.filter((o) => o.weeks.length > 0);
  const hits = judged.filter((o) => o.hit).length;
  return {
    claims: judged.length,
    hits,
    hitRate: judged.length === 0 ? null : Math.round((hits / judged.length) * 1000) / 1000,
    netPoints: round2(judged.reduce((t, o) => t + o.netPoints, 0))
  };
}
