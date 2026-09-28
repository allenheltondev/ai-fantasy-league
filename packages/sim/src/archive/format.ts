import { z } from 'zod';

/** Bump when the on-disk layout changes; `readSimArchive` refuses other versions. */
export const SIM_ARCHIVE_VERSION = 1;

/** Fantasy positions the archive keeps. IDP players are not archived. */
export const ARCHIVE_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'] as const;
export type ArchivePosition = (typeof ARCHIVE_POSITIONS)[number];

const statMap = z.record(z.string(), z.number());
/** Week numbers are JSON object keys. */
const weekKey = z.string().regex(/^\d+$/);

export const ArchiveInjurySchema = z.enum(['Questionable', 'Doubtful', 'Out', 'IR']);
export type ArchiveInjury = z.infer<typeof ArchiveInjurySchema>;

export const SimPlayerSchema = z.strictObject({
  /** Sleeper id; the GSIS id when no Sleeper id is known; the team code for a team defense. */
  id: z.string().min(1),
  gsisId: z.string().optional(),
  name: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  position: z.enum(ARCHIVE_POSITIONS),
  /** Week → NFL team as known before that week's kickoffs (null: not on a team). */
  teams: z.record(weekKey, z.string().nullable()),
  /** Week → injury designation for that week's game, when he had one. */
  injuries: z.record(weekKey, ArchiveInjurySchema).optional()
});
export type SimPlayer = z.infer<typeof SimPlayerSchema>;

export const ScheduledGameSchema = z.strictObject({
  gameId: z.string(),
  season: z.number().int(),
  seasonType: z.enum(['regular', 'post']),
  week: z.number().int(),
  kickoff: z.string(),
  homeTeam: z.string(),
  awayTeam: z.string(),
  status: z.enum(['scheduled', 'final']),
  homeScore: z.number().optional(),
  awayScore: z.number().optional()
});

export const CrosswalkEntrySchema = z.strictObject({
  sleeperId: z.string(),
  gsisId: z.string(),
  method: z.enum(['idmap', 'sleeper', 'name'])
});

export const ArchiveWeekSchema = z.strictObject({
  week: z.number().int(),
  /** Player id → actual stat line (Sleeper keys). DEF lines are keyed by team code. */
  stats: z.record(z.string(), statMap),
  /** Synthetic projections, captured before the week's first kickoff. */
  projections: z.strictObject({ capturedAt: z.string(), lines: z.record(z.string(), statMap) }),
  /** Synthetic trending adds, captured with the projections. */
  trending: z.strictObject({
    capturedAt: z.string(),
    add: z.array(z.strictObject({ playerId: z.string(), count: z.number() }))
  }),
  /** When the week's player snapshot (teams) and injury designations become visible. */
  playersCapturedAt: z.string(),
  injuriesCapturedAt: z.string()
});
export type ArchiveWeek = z.infer<typeof ArchiveWeekSchema>;

export const ArchiveManifestSchema = z.strictObject({
  version: z.literal(SIM_ARCHIVE_VERSION),
  season: z.number().int(),
  /** Regular-season weeks included, ascending. */
  weeks: z.array(z.number().int()),
  /** Where the data came from and how the synthetic parts were made. */
  provenance: z.strictObject({
    sources: z.array(z.string()),
    projectionMethod: z.string(),
    defenseMethod: z.string(),
    notes: z.array(z.string())
  }),
  /** True for a trimmed test fixture. */
  fixture: z.boolean()
});
export type ArchiveManifest = z.infer<typeof ArchiveManifestSchema>;

/** A compact, self-contained season archive the simulator replays. */
export interface SimArchive {
  manifest: ArchiveManifest;
  schedule: z.infer<typeof ScheduledGameSchema>[];
  byeWeeks: Record<string, number>;
  crosswalk: z.infer<typeof CrosswalkEntrySchema>[];
  players: SimPlayer[];
  /** One entry per archived week, keyed by week. */
  weeks: Record<number, ArchiveWeek>;
}

export const ArchiveFilesSchema = {
  manifest: ArchiveManifestSchema,
  schedule: z.array(ScheduledGameSchema),
  byeWeeks: z.record(z.string(), z.number().int()),
  crosswalk: z.array(CrosswalkEntrySchema),
  players: z.array(SimPlayerSchema),
  week: ArchiveWeekSchema
} as const;
