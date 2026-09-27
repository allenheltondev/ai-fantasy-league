import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  activePlayerCount,
  isOnBye,
  isPlayerLocked,
  openRosterSpots,
  playerKickoff,
  validateLineup,
  type LineupEntry,
  type RosterPlayer,
  type WeekGames
} from './lineup.js';
import { yahooDefaultSettings } from './settings.js';

const settings = yahooDefaultSettings();

const p = (
  playerId: string,
  pos: RosterPlayer['positions'][number],
  nflTeam: string | null = 'KC',
  extra: Partial<RosterPlayer> = {}
): RosterPlayer => ({
  playerId,
  positions: [pos],
  status: 'active',
  nflTeam,
  ...extra
});

/** A full, legal 16-man roster plus an IR-eligible player. */
const roster: RosterPlayer[] = [
  p('qb1', 'QB', 'BUF', { name: 'Josh Allen' }),
  p('wr1', 'WR', 'CIN'),
  p('wr2', 'WR', 'MIN'),
  p('wr3', 'WR', 'DET'),
  p('rb1', 'RB', 'SF'),
  p('rb2', 'RB', 'ATL'),
  p('te1', 'TE', 'KC'),
  p('fx1', 'RB', 'PHI'),
  p('k1', 'K', 'BAL'),
  p('def1', 'DEF', 'PIT'),
  p('bn1', 'QB', 'MIA'),
  p('bn2', 'WR', 'LAR'),
  p('bn3', 'RB', 'GB'),
  p('bn4', 'TE', 'LV'),
  p('bn5', 'WR', 'SEA'),
  p('bn6', 'RB', 'DAL'),
  p('ir1', 'WR', 'NYJ', { status: 'ir' })
];

const lineup: LineupEntry[] = [
  { playerId: 'qb1', slot: 'QB' },
  { playerId: 'wr1', slot: 'WR' },
  { playerId: 'wr2', slot: 'WR' },
  { playerId: 'wr3', slot: 'WR' },
  { playerId: 'rb1', slot: 'RB' },
  { playerId: 'rb2', slot: 'RB' },
  { playerId: 'te1', slot: 'TE' },
  { playerId: 'fx1', slot: 'W/R/T' },
  { playerId: 'k1', slot: 'K' },
  { playerId: 'def1', slot: 'DEF' },
  { playerId: 'ir1', slot: 'IR' }
];

const allTeams = [...new Set(roster.map((r) => r.nflTeam).filter((t): t is string => t !== null))];
const sunday = (hourUtc: number): string => `2025-09-14T${String(hourUtc).padStart(2, '0')}:00:00Z`;
const games: WeekGames = Object.fromEntries(allTeams.map((t) => [t, { kickoff: sunday(17) }]));

const codes = (issues: { code: string }[]): string[] => issues.map((i) => i.code);
const replace = (playerId: string, slot: LineupEntry['slot']): LineupEntry[] =>
  lineup.map((e) => (e.playerId === playerId ? { playerId, slot } : e));

describe('validateLineup: legal lineups', () => {
  it('accepts the default roster and benches unlisted players', () => {
    const r = validateLineup(settings, roster, lineup, { games });
    expect(r).toMatchObject({ valid: true, errors: [], warnings: [] });
    expect(r.lineup).toHaveLength(roster.length);
    expect(r.lineup.filter((e) => e.slot === 'BN').map((e) => e.playerId)).toEqual([
      'bn1',
      'bn2',
      'bn3',
      'bn4',
      'bn5',
      'bn6'
    ]);
  });

  it('accepts a TE or WR in the W/R/T flex', () => {
    const swapped = lineup.map((e) =>
      e.playerId === 'fx1' ? { playerId: 'bn4', slot: 'W/R/T' as const } : e
    );
    expect(validateLineup(settings, roster, swapped).valid).toBe(true);
  });

  it('works with no context at all', () => {
    expect(validateLineup(settings, roster, lineup).valid).toBe(true);
  });
});

describe('validateLineup: errors', () => {
  it('rejects players not on the roster and duplicates', () => {
    const r = validateLineup(settings, roster, [
      ...lineup,
      { playerId: 'ghost', slot: 'BN' },
      { playerId: 'qb1', slot: 'BN' }
    ]);
    expect(codes(r.errors)).toEqual(['PLAYER_NOT_ON_ROSTER', 'DUPLICATE_PLAYER']);
    expect(r.errors[1]?.message).toContain('Josh Allen (qb1)');
  });

  it('rejects position-ineligible slots with a list of legal ones', () => {
    const r = validateLineup(settings, roster, replace('k1', 'W/R/T'));
    const inel = r.errors.find((e) => e.code === 'INELIGIBLE_FOR_SLOT');
    expect(inel?.fix).toBe('Put this player in K, BN.');
    const rb = validateLineup(settings, roster, replace('rb1', 'QB'));
    expect(rb.errors.find((e) => e.code === 'INELIGIBLE_FOR_SLOT')?.fix).toBe(
      'Put this player in RB, W/R/T, BN.'
    );
  });

  it('rejects overfilled slots and slots the league does not have', () => {
    const over = validateLineup(settings, roster, [...lineup, { playerId: 'bn1', slot: 'QB' }]);
    expect(codes(over.errors)).toEqual(['SLOT_OVERFILLED']);
    const none = validateLineup(settings, roster, [...lineup, { playerId: 'bn1', slot: 'Q/W/R/T' }]);
    expect(codes(none.errors)).toEqual(['SLOT_NOT_IN_LEAGUE']);
    expect(none.errors[0]?.message).toBe('This league has no Q/W/R/T slot.');
  });

  it('allows only IR-eligible statuses on IR (default IR, O, PUP, NFI, COVID)', () => {
    for (const status of ['ir', 'out', 'pup', 'nfi', 'covid'] as const) {
      const r2 = roster.map((r) => (r.playerId === 'ir1' ? { ...r, status } : r));
      expect(validateLineup(settings, r2, lineup).valid).toBe(true);
    }
    for (const status of ['active', 'questionable', 'doubtful', 'suspended', 'na'] as const) {
      const r2 = roster.map((r) => (r.playerId === 'ir1' ? { ...r, status } : r));
      const res = validateLineup(settings, r2, lineup);
      expect(codes(res.errors)).toContain('IR_INELIGIBLE');
    }
  });

  it('respects a commissioner-narrowed IR list', () => {
    const strict = { ...settings, roster: { ...settings.roster, irEligibleStatuses: ['ir' as const] } };
    const r2 = roster.map((r) => (r.playerId === 'ir1' ? { ...r, status: 'out' as const } : r));
    expect(codes(validateLineup(strict, r2, lineup).errors)).toEqual(['IR_INELIGIBLE']);
  });

  it('rejects too many active players and too many on IR', () => {
    const extra = [...roster, p('bn7', 'WR', 'NE')];
    const r = validateLineup(settings, extra, lineup);
    expect(r.errors).toMatchObject([{ code: 'ROSTER_FULL', details: { active: 17, limit: 16 } }]);
    const twoIr = [...roster, p('ir2', 'RB', 'NE', { status: 'out' })];
    expect(
      codes(validateLineup(settings, twoIr, [...lineup, { playerId: 'ir2', slot: 'IR' }]).errors)
    ).toEqual(['SLOT_OVERFILLED']);
  });
});

describe('validateLineup: warnings', () => {
  it('warns (does not error) for starters on bye, without a team, or ruled out', () => {
    const r2 = roster.map((r) =>
      r.playerId === 'wr1'
        ? { ...r, status: 'out' as const }
        : r.playerId === 'wr2'
          ? { ...r, nflTeam: null }
          : r
    );
    const byeGames = Object.fromEntries(Object.entries(games).filter(([t]) => t !== 'SF'));
    const r = validateLineup(settings, r2, lineup, { games: byeGames });
    expect(r.valid).toBe(true);
    expect(codes(r.warnings).sort()).toEqual([
      'STARTER_HAS_NO_TEAM',
      'STARTER_NOT_PLAYING',
      'STARTER_ON_BYE'
    ]);
  });

  it('does not warn about benched players on bye or out', () => {
    const r2 = roster.map((r) =>
      r.playerId === 'bn1' ? { ...r, status: 'out' as const, nflTeam: 'XXX' } : r
    );
    expect(validateLineup(settings, r2, lineup, { games }).warnings).toEqual([]);
  });

  it('warns about empty starting slots', () => {
    const r = validateLineup(settings, roster, replace('k1', 'BN'));
    expect(r.warnings).toMatchObject([{ code: 'EMPTY_STARTER_SLOT', path: 'lineup.slots.K' }]);
  });
});

describe('lineup lock', () => {
  const early: WeekGames = { ...games, CIN: { kickoff: sunday(13) }, BUF: { kickoff: new Date(sunday(13)) } };
  const now = sunday(15);

  it('computes kickoff and lock status from supplied times', () => {
    expect(playerKickoff(p('x', 'WR', 'CIN'), early)?.toISOString()).toBe('2025-09-14T13:00:00.000Z');
    expect(isPlayerLocked(p('x', 'WR', 'CIN'), early, now)).toBe(true);
    expect(isPlayerLocked(p('x', 'WR', 'CIN'), early, sunday(12))).toBe(false);
    expect(isPlayerLocked(p('x', 'WR', 'CIN'), early, sunday(13))).toBe(true);
    expect(isPlayerLocked(p('x', 'WR', 'KC'), early, new Date(now))).toBe(false);
    expect(isPlayerLocked(p('x', 'WR', 'BYE'), early, now)).toBe(false);
    expect(isOnBye(p('x', 'WR', null), early)).toBe(true);
  });

  it('forbids moving a locked player, including benching or starting him', () => {
    const benchLocked = replace('wr1', 'BN'); // wr1 plays CIN, kicked off
    const r = validateLineup(settings, roster, [...benchLocked, { playerId: 'bn2', slot: 'WR' }], {
      games: early,
      now,
      previousLineup: lineup
    });
    expect(r.errors).toMatchObject([{ code: 'PLAYER_LOCKED', details: { from: 'WR', to: 'BN' } }]);

    const bnLocked = { ...early, MIA: { kickoff: sunday(13) } }; // bench QB bn1 locked on BN
    const start = validateLineup(
      settings,
      roster,
      [...replace('qb1', 'BN'), { playerId: 'bn1', slot: 'QB' }],
      {
        games: bnLocked,
        now,
        previousLineup: lineup
      }
    );
    // qb1 (BUF) is locked too, so both moves are refused
    expect(codes(start.errors)).toEqual(['PLAYER_LOCKED', 'PLAYER_LOCKED']);
  });

  it('allows moving unlocked players while others are locked', () => {
    const r = validateLineup(settings, roster, [...replace('rb1', 'BN'), { playerId: 'bn3', slot: 'RB' }], {
      games: early,
      now,
      previousLineup: lineup
    });
    expect(r.valid).toBe(true);
  });

  it('skips lock checks without a previous lineup or time', () => {
    expect(validateLineup(settings, roster, replace('wr1', 'BN'), { games: early, now }).errors).toEqual([]);
    expect(
      validateLineup(settings, roster, replace('wr1', 'BN'), { games: early, previousLineup: lineup }).errors
    ).toEqual([]);
  });

  it('property: an unchanged lineup is never blocked by locks, at any time', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 23 }), (hour) => {
        const r = validateLineup(settings, roster, lineup, {
          games: early,
          now: sunday(hour),
          previousLineup: lineup
        });
        expect(r.errors).toEqual([]);
      })
    );
  });
});

describe('roster size helpers', () => {
  it('counts active players and open spots', () => {
    const full = validateLineup(settings, roster, lineup).lineup;
    expect(activePlayerCount(full)).toBe(16);
    expect(openRosterSpots(settings, full)).toBe(0);
    expect(openRosterSpots(settings, lineup)).toBe(6);
  });
});
