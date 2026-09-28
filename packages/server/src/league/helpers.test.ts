import { yahooDefaultSettings } from '@fantasy/core';
import { describe, expect, it, vi } from 'vitest';
import { league, START } from '../../test/support/harness.js';
import { createLogger, silentLogger } from '../log.js';
import type { Invite } from '../repos/types.js';
import {
  estimatedWeekKickoff,
  estimateNextUnlockedWeek,
  firstScoringWeek,
  laborDay,
  nextUnlockedWeek,
  nflSeasonAt,
  type NflStateSnapshot
} from './calendar.js';
import {
  claimableSeats,
  claimSeat,
  defaultTeamName,
  newTeam,
  nextTeamId,
  sameTeamName,
  vacateSeat
} from './seats.js';
import { buildLeagueSettings, settingsError, settingsPhase, settingsWarnings } from './settings.js';
import { hashInviteToken, INVITE_TOKEN_BYTES, isWellFormedInviteToken, newInviteToken } from './tokens.js';
import { inviteStatus, leagueWeeksView, matchupView } from './views.js';

const NOW = new Date(START);
const settings = yahooDefaultSettings(8);

describe('invite tokens', () => {
  it('are random, URL-safe, and carry at least 128 bits', () => {
    const tokens = new Set(Array.from({ length: 50 }, newInviteToken));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(token, 'base64url').length).toBe(INVITE_TOKEN_BYTES);
      expect(isWellFormedInviteToken(token)).toBe(true);
    }
    expect(INVITE_TOKEN_BYTES * 8).toBeGreaterThanOrEqual(128);
  });

  it('are stored only as a SHA-256 hash', () => {
    const token = newInviteToken();
    const hash = hashInviteToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashInviteToken(token)).toBe(hash);
    expect(hashInviteToken(`${token}x`)).not.toBe(hash);
  });

  it('rejects malformed tokens before any lookup', () => {
    for (const bad of [
      '',
      'short',
      'has spaces in it and more',
      'x'.repeat(129),
      'bad/chars/abcdefghijklmnop'
    ]) {
      expect(isWellFormedInviteToken(bad)).toBe(false);
    }
  });
});

describe('NFL calendar', () => {
  it('finds Labor Day and estimates weekly kickoffs', () => {
    expect(laborDay(2026).toISOString()).toBe('2026-09-07T00:00:00.000Z');
    expect(laborDay(2025).toISOString()).toBe('2025-09-01T00:00:00.000Z');
    expect(laborDay(2024).toISOString()).toBe('2024-09-02T00:00:00.000Z');
    expect(estimatedWeekKickoff(2026, 1).toISOString()).toBe('2026-09-11T00:20:00.000Z');
    expect(estimatedWeekKickoff(2026, 4).toISOString()).toBe('2026-10-02T00:20:00.000Z');
  });

  it('assigns January and February to the previous season', () => {
    expect(nflSeasonAt(new Date('2027-02-01T00:00:00Z'))).toBe(2026);
    expect(nflSeasonAt(new Date('2026-03-01T00:00:00Z'))).toBe(2026);
  });

  it('estimates the next week that has not kicked off', () => {
    expect(estimateNextUnlockedWeek(new Date('2026-06-01T00:00:00Z'))).toEqual({
      season: 2026,
      week: 1,
      source: 'clock'
    });
    expect(estimateNextUnlockedWeek(new Date('2026-09-27T12:00:00Z')).week).toBe(4);
    expect(estimateNextUnlockedWeek(new Date('2027-01-20T00:00:00Z'))).toEqual({
      season: 2026,
      week: 19,
      source: 'clock'
    });
  });

  it('uses the NFL state when it is available', async () => {
    const source = (state: NflStateSnapshot) => ({ getNflState: async () => state });
    const at = new Date('2026-09-27T12:00:00Z');
    expect(
      await nextUnlockedWeek(source({ season: 2026, seasonType: 'pre', week: 1 }), at, silentLogger)
    ).toEqual({
      season: 2026,
      week: 1,
      source: 'nfl_state'
    });
    expect(
      (await nextUnlockedWeek(source({ season: 2026, seasonType: 'off', week: 0 }), at, silentLogger)).week
    ).toBe(1);
    expect(
      (await nextUnlockedWeek(source({ season: 2026, seasonType: 'post', week: 19 }), at, silentLogger)).week
    ).toBe(19);
    // Week 3 kicked off on Thursday, so week 4 is next; a state already on week 6 wins.
    expect(
      (await nextUnlockedWeek(source({ season: 2026, seasonType: 'regular', week: 3 }), at, silentLogger))
        .week
    ).toBe(4);
    expect(
      (await nextUnlockedWeek(source({ season: 2026, seasonType: 'regular', week: 6 }), at, silentLogger))
        .week
    ).toBe(6);
    expect(await nextUnlockedWeek(undefined, at, silentLogger)).toMatchObject({ week: 4, source: 'clock' });
  });

  it('falls back to the clock when the NFL state fails', async () => {
    const lines: string[] = [];
    const failing = { getNflState: vi.fn().mockRejectedValue(new Error('sleeper down')) };
    const result = await nextUnlockedWeek(failing, NOW, createLogger({ sink: (l) => lines.push(l) }));
    expect(result).toEqual({ season: 2026, week: 1, source: 'clock' });
    expect(lines.some((l) => l.includes('NFL state unavailable'))).toBe(true);
  });
});

describe('firstScoringWeek (#85)', () => {
  const at = (startWeek: number) => ({ season: 2026, settings: { schedule: { startWeek } } });

  it('starts at the later of the start week and the next unlocked week', () => {
    expect(firstScoringWeek(at(1), { season: 2026, week: 5 })).toBe(5);
    expect(firstScoringWeek(at(6), { season: 2026, week: 5 })).toBe(6);
  });

  it('uses the start week before the season and nothing after it', () => {
    expect(firstScoringWeek(at(3), { season: 2025, week: 19 })).toBe(3);
    expect(firstScoringWeek(at(3), { season: 2027, week: 1 })).toBe(19);
  });
});

describe('seats', () => {
  const human = newTeam({
    leagueId: 'lg',
    id: 'team-1',
    draftSlot: 1,
    settings,
    now: NOW,
    owner: { userId: 'u1', name: 'Una', teamName: 'Una FC' }
  });
  const agent = (id: string, slot: number) =>
    newTeam({ leagueId: 'lg', id, draftSlot: slot, settings, now: NOW });

  it('creates human and agent seats with the league budget', () => {
    expect(human).toMatchObject({
      seatType: 'human',
      ownerUserId: 'u1',
      name: 'Una FC',
      faabRemaining: 100,
      roster: []
    });
    expect(agent('team-2', 2)).toMatchObject({
      seatType: 'agent',
      ownerUserId: null,
      name: 'Team 2',
      waiverPriority: 2
    });
    expect(defaultTeamName(7)).toBe('Team 7');
  });

  it('numbers new teams past any id in use', () => {
    expect(nextTeamId([])).toBe('team-1');
    expect(nextTeamId([{ id: 'team-1' }, { id: 'team-3' }])).toBe('team-4');
    expect(nextTeamId([{ id: 'team-3' }, { id: 'team-2' }, { id: 'team-4' }])).toBe('team-5');
  });

  it('offers open human seats first, then agent seats, by draft slot', () => {
    const openHuman = { ...agent('team-5', 5), seatType: 'human' as const };
    const seats = claimableSeats([human, agent('team-3', 3), openHuman, agent('team-2', 2)]);
    expect(seats.map((t) => t.id)).toEqual(['team-5', 'team-2', 'team-3']);
    const tie = claimableSeats([agent('team-b', 2), agent('team-a', 2)]);
    expect(tie.map((t) => t.id)).toEqual(['team-a', 'team-b']);
  });

  it('claims and vacates seats', () => {
    const claimed = claimSeat(agent('team-2', 2), { userId: 'u2', name: 'Vic' }, 'Vic Squad', NOW);
    expect(claimed).toMatchObject({
      seatType: 'human',
      ownerUserId: 'u2',
      ownerName: 'Vic',
      name: 'Vic Squad'
    });
    expect(vacateSeat(claimed, NOW)).toMatchObject({
      seatType: 'agent',
      ownerUserId: null,
      ownerName: null,
      name: 'Team 2'
    });
  });

  it('compares names ignoring case and spacing', () => {
    expect(sameTeamName('The  Champs ', 'the champs')).toBe(true);
    expect(sameTeamName('Champs', 'Chumps')).toBe(false);
  });
});

describe('settings helpers', () => {
  it('builds defaults for a preset and start week', () => {
    const { settings: built, warnings } = buildLeagueSettings({
      teamCount: 10,
      preset: 'full_ppr',
      startWeek: 8,
      overrides: undefined
    });
    expect(built.teamCount).toBe(10);
    expect(built.scoring.perStat.rec).toBe(1);
    expect(built.schedule.startWeek).toBe(8);
    expect(warnings.map((w) => w.code)).toEqual(['SHORT_REGULAR_SEASON']);
  });

  it('applies overrides and reports every invalid setting with a fix', () => {
    const merged = buildLeagueSettings({
      teamCount: 8,
      preset: 'yahoo_standard',
      startWeek: 1,
      overrides: { waivers: { faabBudget: 200 } }
    });
    expect(merged.settings.waivers.faabBudget).toBe(200);
    expect(() =>
      buildLeagueSettings({
        teamCount: 8,
        preset: 'standard',
        startWeek: 1,
        overrides: { waivers: { faabBudget: -1 } }
      })
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_SETTINGS',
        details: { issues: [expect.objectContaining({ path: 'waivers.faabBudget' })] }
      })
    );
  });

  it('keeps warnings out of the error and errors out of the warnings', () => {
    const error = { code: 'E', severity: 'error' as const, path: 'a', message: 'm', fix: 'Fix a.' };
    const warning = {
      code: 'W',
      severity: 'warning' as const,
      path: 'b',
      message: 'Heads up.',
      fix: 'Maybe b.'
    };
    expect(settingsError([error, warning]).details).toEqual({
      issues: [{ code: 'E', path: 'a', message: 'm', fix: 'Fix a.' }]
    });
    expect(settingsWarnings([error, warning])).toEqual([{ code: 'W', message: 'Heads up. Maybe b.' }]);
  });

  it('maps league phases to the editability phases', () => {
    expect(settingsPhase('setup')).toBe('pre_draft');
    expect(settingsPhase('drafting')).toBe('drafting');
    expect(settingsPhase('regular_season')).toBe('in_season');
    expect(settingsPhase('playoffs')).toBe('playoffs');
    expect(settingsPhase('complete')).toBe('complete');
  });
});

describe('views', () => {
  const invite: Invite = {
    id: 'i',
    leagueId: 'lg',
    tokenHash: 'h',
    email: null,
    maxUses: 2,
    uses: 0,
    expiresAt: '2026-09-11T00:00:00.000Z',
    revokedAt: null,
    createdBy: 'u',
    createdAt: START,
    version: 1
  };

  it('derives invite status', () => {
    expect(inviteStatus(invite, NOW)).toBe('active');
    expect(inviteStatus({ ...invite, uses: 2 }, NOW)).toBe('used_up');
    expect(inviteStatus(invite, new Date('2026-09-11T00:00:00.000Z'))).toBe('expired');
    expect(inviteStatus({ ...invite, revokedAt: START }, NOW)).toBe('revoked');
  });

  it('shows the weeks a league plays, or null for impossible settings', () => {
    expect(leagueWeeksView(league())).toMatchObject({
      startWeek: 1,
      playoffs: [15, 16, 17],
      midSeasonStart: false
    });
    const broken = league({
      settings: { ...settings, schedule: { startWeek: 12, regularSeasonEndWeek: 14 } }
    });
    expect(leagueWeeksView(broken)).toBeNull();
  });

  it('names matchup teams, falling back to the id', () => {
    const view = matchupView(
      {
        id: 'W01-1',
        leagueId: 'lg',
        week: 1,
        kind: 'regular',
        homeTeamId: 'team-1',
        awayTeamId: 'team-9',
        homeScore: null,
        awayScore: null,
        status: 'scheduled'
      },
      [newTeam({ leagueId: 'lg', id: 'team-1', draftSlot: 1, settings, now: NOW })]
    );
    expect(view.home).toEqual({ teamId: 'team-1', teamName: 'Team 1', score: null });
    expect(view.away.teamName).toBe('team-9');
  });
});
