import type { DefaultSettings, LeagueSettings, Phase, ScoringPreset, TierRule } from '../../api/types';

/** One editable rule, addressed by its dotted settings path. */
export type RuleField = {
  path: string;
  label: string;
  /** Show the field only while another setting has this value (FAAB details when FAAB is on). */
  showWhen?: { path: string; equals: unknown };
} & (
  | { kind: 'int'; min: number; max: number; fallback?: number }
  | { kind: 'decimal'; fallback?: number }
  | { kind: 'enum'; options: readonly (readonly [string, string])[] }
  | { kind: 'bool' }
  | { kind: 'nullableInt'; min: number; max: number; nullLabel: string }
  | { kind: 'statuses' }
  | { kind: 'tiers' }
);

export interface RuleSection {
  id: string;
  title: string;
  fields: RuleField[];
}

const FAAB_ON = { path: 'waivers.type', equals: 'faab' } as const;
const WEEK = { kind: 'int', min: 1, max: 18 } as const;

/** The rules editor's sections, built from the league's and the defaults' keys. */
export function ruleSections(settings: LeagueSettings, defaults: DefaultSettings): RuleSection[] {
  const statKeys = Object.keys(defaults.statLabels).filter(
    (key) => key in settings.scoring.perStat || key in defaults.settings.scoring.perStat
  );
  const customKeys = Object.keys(settings.scoring.perStat).filter((key) => !(key in defaults.statLabels));
  return [
    {
      id: 'roster',
      title: 'Roster slots',
      fields: [
        ...defaults.rosterSlots.map((slot): RuleField => ({
          path: `roster.slots.${slot}`,
          label: slot,
          kind: 'int',
          min: 0,
          max: 15,
          fallback: 0
        })),
        { path: 'roster.irEligibleStatuses', label: 'IR-eligible statuses', kind: 'statuses' }
      ]
    },
    {
      id: 'scoring',
      title: 'Scoring',
      fields: [
        ...[...statKeys, ...customKeys].map((key): RuleField => ({
          path: `scoring.perStat.${key}`,
          label: defaults.statLabels[key] ?? key,
          kind: 'decimal',
          fallback: 0
        })),
        // Bucketed stats (Yahoo's points-allowed bands for team defense). The whole list is one
        // setting: the server replaces arrays rather than merging them.
        { path: 'scoring.tiers', label: 'Tiered scoring', kind: 'tiers' }
      ]
    },
    {
      id: 'waivers',
      title: 'Waivers and FAAB',
      fields: [
        {
          path: 'waivers.type',
          label: 'FAAB bidding',
          kind: 'enum',
          options: [
            ['faab', 'On: teams bid from a season budget'],
            ['rolling', 'Off: rolling priority, no bids']
          ]
        },
        {
          path: 'waivers.faabBudget',
          label: 'FAAB budget ($)',
          kind: 'int',
          min: 0,
          max: 1000,
          showWhen: FAAB_ON
        },
        { path: 'waivers.allowZeroBids', label: 'Allow $0 bids', kind: 'bool', showWhen: FAAB_ON },
        { path: 'waivers.waiverPeriodDays', label: 'Waiver period (days)', kind: 'int', min: 0, max: 7 },
        {
          path: 'waivers.faabTiebreak',
          label: 'FAAB tiebreak',
          showWhen: FAAB_ON,
          kind: 'enum',
          options: [
            ['waiver_priority', 'Waiver priority'],
            ['reverse_standings', 'Reverse standings'],
            ['earliest_claim', 'Earliest claim']
          ]
        },
        {
          path: 'waivers.priorityOrder',
          label: 'Priority order',
          kind: 'enum',
          options: [
            ['reverse_draft_continual', 'Reverse draft order, continual'],
            ['reverse_standings_weekly', 'Reverse standings, reset weekly']
          ]
        },
        {
          path: 'waivers.postDraftPlayers',
          label: 'Undrafted players after the draft',
          kind: 'enum',
          options: [
            ['waivers', 'Go through waivers'],
            ['free_agents', 'Are free agents']
          ]
        },
        {
          path: 'waivers.maxAcquisitionsPerWeek',
          label: 'Max adds per week',
          kind: 'nullableInt',
          min: 1,
          max: 50,
          nullLabel: 'Unlimited'
        }
      ]
    },
    {
      id: 'trades',
      title: 'Trades',
      fields: [
        {
          path: 'trades.review',
          label: 'Trade review',
          kind: 'enum',
          options: [
            ['league_vote', 'League vote'],
            ['commissioner', 'Commissioner'],
            ['none', 'None']
          ]
        },
        { path: 'trades.reviewPeriodDays', label: 'Review period (days)', kind: 'int', min: 0, max: 7 },
        {
          path: 'trades.vetoVotes',
          label: 'Veto votes needed',
          kind: 'nullableInt',
          min: 1,
          max: 12,
          nullLabel: 'Yahoo rule (a third of the league)'
        },
        { path: 'trades.deadlineWeek', label: 'Trade deadline week', ...WEEK },
        {
          path: 'trades.offerExpiryHours',
          label: 'Offers expire after (hours)',
          kind: 'int',
          min: 1,
          max: 336
        },
        {
          path: 'trades.expireAtNextLineupLock',
          label: 'Offers expire at the next lineup lock',
          kind: 'bool'
        }
      ]
    },
    {
      id: 'playoffs',
      title: 'Playoffs',
      fields: [
        { path: 'playoffs.teams', label: 'Playoff teams', kind: 'int', min: 2, max: 8 },
        { path: 'playoffs.byes', label: 'First-round byes', kind: 'int', min: 0, max: 6 },
        { path: 'playoffs.startWeek', label: 'First playoff week', ...WEEK },
        { path: 'playoffs.endWeek', label: 'Championship week', ...WEEK },
        {
          path: 'playoffs.tiebreaker',
          label: 'Seeding tiebreaker',
          kind: 'enum',
          options: [
            ['points_for', 'Points for'],
            ['head_to_head', 'Head to head']
          ]
        }
      ]
    },
    {
      id: 'schedule',
      title: 'Schedule',
      fields: [
        {
          path: 'teamCount',
          label: 'Teams',
          kind: 'enum',
          options: ['4', '6', '8', '10', '12'].map((n) => [n, `${n} teams`] as const)
        },
        { path: 'schedule.startWeek', label: 'First week', ...WEEK },
        { path: 'schedule.regularSeasonEndWeek', label: 'Last regular-season week', ...WEEK }
      ]
    }
  ];
}

export function getPath(source: unknown, path: string): unknown {
  let node = source;
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** A copy of `target` with `value` at `path`, creating objects along the way. */
export function setPath<T>(target: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.') as [string, ...string[]];
  const node = (typeof target === 'object' && target !== null ? target : {}) as Record<string, unknown>;
  return {
    ...node,
    [head]: rest.length === 0 ? value : setPath(node[head], rest.join('.'), value)
  } as T;
}

/** A field's value, with the field's fallback for slots and stats the settings leave out. */
export function fieldValue(settings: unknown, field: RuleField): unknown {
  const value = getPath(settings, field.path);
  if (value === undefined && 'fallback' in field) return field.fallback;
  return field.kind === 'enum' ? String(value) : value;
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether the commissioner may still change `path` in `phase` (longest matching prefix wins). */
export function isEditableInPhase(
  path: string,
  phase: Phase,
  editability: DefaultSettings['editability']
): boolean {
  if (phase === 'setup') return true;
  let best = '';
  for (const key of Object.keys(editability)) {
    if ((path === key || path.startsWith(`${key}.`)) && key.length > best.length) best = key;
  }
  return editability[best] === 'any_time';
}

/** The settings patch for every field whose draft value differs from the saved one. */
export function settingsPatch(
  saved: LeagueSettings,
  draft: LeagueSettings,
  fields: readonly RuleField[]
): Partial<LeagueSettings> {
  let patch: Partial<LeagueSettings> = {};
  for (const field of fields) {
    const value = fieldValue(draft, field);
    if (sameValue(fieldValue(saved, field), value)) continue;
    patch = setPath(patch, field.path, field.path === 'teamCount' ? Number(value) : value);
  }
  return patch;
}

/** The scoring preset whose reception points match, for comparing against the right defaults. */
export function inferPreset(settings: LeagueSettings): ScoringPreset {
  const rec = settings.scoring.perStat.rec;
  if (rec === 1) return 'full_ppr';
  if (rec === undefined || rec === 0) return 'standard';
  return 'yahoo_standard';
}

const TIER_STAT_LABELS: Readonly<Record<string, string>> = { pts_allow: 'Points allowed' };

/** A tier rule's stat, readably: the known label, else the Sleeper key. */
export function tierStatLabel(stat: string, statLabels: Readonly<Record<string, string>>): string {
  return statLabels[stat] ?? TIER_STAT_LABELS[stat] ?? stat;
}

/** `0: 10 · 1–6: 7 · 35+: -4`. */
export function describeTiers(rules: readonly TierRule[]): string {
  if (rules.length === 0) return 'None';
  return rules
    .map((rule) =>
      rule.bands
        .map((b) => {
          const range = b.max === null ? `${b.min}+` : b.max === b.min ? `${b.min}` : `${b.min}–${b.max}`;
          return `${range}: ${b.points}`;
        })
        .join(' · ')
    )
    .join('; ');
}

/** Adds a band after the last one, closing the last band's open upper bound first. */
export function addTierBand(rule: TierRule): TierRule {
  const bands = rule.bands.map((b) => ({ ...b }));
  const last = bands.at(-1);
  if (last === undefined) return { ...rule, bands: [{ min: 0, max: null, points: 0 }] };
  if (last.max === null) last.max = last.min;
  return { ...rule, bands: [...bands, { min: last.max + 1, max: null, points: 0 }] };
}
