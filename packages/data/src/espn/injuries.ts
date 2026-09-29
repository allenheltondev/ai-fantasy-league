import { SchemaDriftError, type DriftIssue } from '../errors.js';
import { normalizeNameNoSuffix } from '../names.js';
import type { InjuryReport, InjuryStatus } from '../types.js';
import { espnTeam } from './normalize.js';
import { espnInjurySchema, type EspnInjuries, type EspnInjury } from './schemas.js';

/**
 * ESPN's injury report (#200) in our terms, and matched to our players. ESPN writes each status
 * out in words; anything we do not recognize is left out rather than guessed, so an unfamiliar
 * word never clears or sets a designation.
 */
const STATUS: Record<string, InjuryStatus | null> = {
  out: 'Out',
  inactive: 'Out',
  doubtful: 'Doubtful',
  questionable: 'Questionable',
  'injured reserve': 'IR',
  ir: 'IR',
  'physically unable to perform': 'PUP',
  pup: 'PUP',
  suspension: 'Suspended',
  suspended: 'Suspended',
  active: null,
  probable: null
};

/** Our designation for ESPN's status word: a status, null for "no designation", undefined when unknown. */
export function espnInjuryStatus(text: string): InjuryStatus | null | undefined {
  const key = text.trim().toLowerCase().replace(/-/g, ' ');
  return Object.hasOwn(STATUS, key) ? STATUS[key] : undefined;
}

const PLAYER_LINK = /\/_\/id\/(\d+)(?:\/|$)/;

/** The athlete's ESPN id: `athlete.id`, else the id in his player-card link. */
function athleteId(athlete: EspnInjury['athlete']): string | null {
  if (athlete.id !== null && athlete.id !== undefined && /^\d+$/.test(String(athlete.id))) {
    return String(athlete.id);
  }
  for (const link of athlete.links ?? []) {
    const match = PLAYER_LINK.exec(link.href ?? '');
    if (match !== null) return match[1] as string;
  }
  return null;
}

/**
 * The report's entries, one per player. A malformed entry, or one whose status we do not know, is
 * skipped; only when entries exist and none has the expected shape does it raise
 * `SchemaDriftError`, because then ESPN changed the payload.
 */
export function normalizeInjuries(report: EspnInjuries): InjuryReport[] {
  const out: InjuryReport[] = [];
  const issues: DriftIssue[] = [];
  let parsed = 0;
  report.injuries.forEach((group, g) => {
    (group.injuries ?? []).forEach((raw, i) => {
      const entry = espnInjurySchema.safeParse(raw);
      if (!entry.success) {
        for (const issue of entry.error.issues) {
          issues.push({
            path: ['injuries', g, 'injuries', i, ...issue.path].join('.'),
            message: issue.message
          });
        }
        return;
      }
      parsed++;
      const status = espnInjuryStatus(entry.data.status);
      if (status === undefined) return;
      const { athlete } = entry.data;
      const team = athlete.team?.abbreviation;
      out.push({
        espnId: athleteId(athlete),
        name: athlete.displayName,
        team: team ? espnTeam(team) : null,
        position: athlete.position?.abbreviation ?? null,
        injuryStatus: status,
        statusText: entry.data.status,
        reportedAt: entry.data.date ?? null,
        comment: entry.data.shortComment ?? null
      });
    });
  });
  if (parsed === 0 && issues.length > 0) throw new SchemaDriftError('espn /injuries', issues);
  return out;
}

/** The player fields matching reads. */
export interface InjuryMatchCandidate {
  id: string;
  name: string;
  team: string | null;
  position: string | null;
  espnId?: string | undefined;
}

export interface InjuryMatches {
  /** Our player id → his report entry. */
  byPlayer: Map<string, InjuryReport>;
  /** How each match was made, for the job's logs. */
  byId: number;
  byName: number;
  /** Entries that matched none of the candidates (most are players nobody rosters). */
  unmatched: number;
}

const nameKey = (name: string, team: string | null, position: string | null) =>
  `${normalizeNameNoSuffix(name)}|${team ?? ''}|${position ?? ''}`;

/**
 * Matches report entries to our players: by ESPN id when the player carries one (Sleeper's
 * `espn_id`), otherwise by name, team, and position, and only when exactly one candidate and one
 * entry share them, so two namesakes are never confused.
 */
export function matchInjuryReports(
  reports: readonly InjuryReport[],
  players: readonly InjuryMatchCandidate[]
): InjuryMatches {
  const byEspn = new Map<string, InjuryMatchCandidate>();
  const byName = new Map<string, InjuryMatchCandidate[]>();
  for (const p of players) {
    if (p.espnId) byEspn.set(p.espnId, p);
    const key = nameKey(p.name, p.team, p.position);
    byName.set(key, [...(byName.get(key) ?? []), p]);
  }
  const entriesByName = new Map<string, number>();
  for (const r of reports) {
    const key = nameKey(r.name, r.team, r.position);
    entriesByName.set(key, (entriesByName.get(key) ?? 0) + 1);
  }
  const matches: InjuryMatches = { byPlayer: new Map(), byId: 0, byName: 0, unmatched: 0 };
  for (const report of reports) {
    const viaId = report.espnId === null ? undefined : byEspn.get(report.espnId);
    if (viaId !== undefined) {
      matches.byPlayer.set(viaId.id, report);
      matches.byId++;
      continue;
    }
    const key = nameKey(report.name, report.team, report.position);
    const named = byName.get(key) ?? [];
    const only = named[0];
    // Two known ids that differ are two people, whatever their names say.
    const idsAgree = only?.espnId === undefined || report.espnId === null;
    if (named.length === 1 && only !== undefined && idsAgree && entriesByName.get(key) === 1) {
      matches.byPlayer.set(only.id, report);
      matches.byName++;
      continue;
    }
    matches.unmatched++;
  }
  return matches;
}
