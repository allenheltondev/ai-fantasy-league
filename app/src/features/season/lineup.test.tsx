import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { LeagueApiContext, type LeagueApi } from '../../api/league';
import type { EventConnect, LeagueEvent } from '../../realtime/leagueEvents';
import { RosterPage } from './RosterPage';
import type { Roster, RosterEntry, SlotCount } from '../../api/types';
import { fakeApi, state } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';
import { dragAnnouncements, gameLine } from './LineupBoard';
import {
  applyMoves,
  changes,
  isEligible,
  movesFor,
  place,
  placed,
  placementOf,
  projectedTotal,
  seats,
  willPlay
} from './slots';

const SLOTS: SlotCount[] = [
  { slot: 'QB', count: 1 },
  { slot: 'WR', count: 1 },
  { slot: 'W/R/T', count: 1 },
  { slot: 'BN', count: 5 },
  { slot: 'IR', count: 1 }
];

function entry(id: string, position: string, slot: string, extra: Partial<RosterEntry> = {}): RosterEntry {
  return {
    player: { id, name: id.toUpperCase(), team: 'KC', position },
    slot,
    status: 'active',
    injuryStatus: null,
    byeWeek: 10,
    onBye: false,
    kickoff: '2026-09-13T17:00:00.000Z',
    opponent: { team: 'BUF', home: true },
    locked: false,
    projectedPoints: 10,
    points: null,
    recentPoints: null,
    ...extra
  };
}

function roster(players: RosterEntry[], extra: Partial<Roster> = {}): Roster {
  return {
    teamId: 'team-1',
    teamName: "Alice's Team",
    week: 1,
    lineupSaved: true,
    carriedFromWeek: null,
    slots: SLOTS,
    players,
    optimal: null,
    ...extra
  };
}

const refused = (status: number, code: string, message: string, fix: string) =>
  new ApiError(status, { code, message, fix });

function open(overrides: Partial<LeagueApi>) {
  const api = fakeApi({
    getLeagueState: vi.fn(async () => state({ phase: 'regular_season', week: 1 })),
    ...overrides
  });
  renderApp('/leagues/L1/roster', undefined, api);
  return api;
}

/** The week before kickoff: the editor locks players by the clock too (#193). */
export const BEFORE_KICKOFF = new Date('2026-09-10T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: BEFORE_KICKOFF });
  signInAs({ sub: 'alice', email: 'alice@example.com', given_name: 'Alice' });
});
afterEach(() => vi.useRealTimers());

describe('lineup rules in the editor', () => {
  const players = [
    entry('qb', 'QB', 'QB', { projectedPoints: 20 }),
    entry('wr1', 'WR', 'WR', { projectedPoints: 8 }),
    entry('rb1', 'RB', 'W/R/T', { projectedPoints: 12 }),
    entry('wr2', 'WR', 'BN', { projectedPoints: 15 }),
    entry('qb2', 'QB', 'BN', { projectedPoints: 25, locked: true }),
    entry('hurt', 'WR', 'BN', { status: 'out', injuryStatus: 'Out' })
  ];
  const at = placementOf(players);

  it('swaps a bench player into a full slot, the starter taking his old place', () => {
    expect(place(players, SLOTS, at, 'wr2', { kind: 'slot', slot: 'WR', occupant: 'wr1' })).toMatchObject({
      wr2: 'WR',
      wr1: 'BN'
    });
    // Between starting slots the displaced player takes the mover's slot when he can play it...
    expect(place(players, SLOTS, at, 'wr1', { kind: 'slot', slot: 'W/R/T', occupant: 'rb1' })).toMatchObject({
      wr1: 'W/R/T',
      rb1: 'BN'
    });
    // ...and a starter dropped on a bench player swaps with him.
    expect(place(players, SLOTS, at, 'wr1', { kind: 'player', playerId: 'wr2' })).toMatchObject({
      wr1: 'BN',
      wr2: 'WR'
    });
    expect(place(players, SLOTS, at, 'qb', { kind: 'bench' })).toMatchObject({ qb: 'BN' });
  });

  it('refuses ineligible, locked, pointless, and IR moves that break the rules', () => {
    expect(place(players, SLOTS, at, 'wr2', { kind: 'slot', slot: 'QB', occupant: 'qb' })).toBeNull();
    expect(place(players, SLOTS, at, 'qb2', { kind: 'slot', slot: 'QB', occupant: 'qb' })).toBeNull();
    const lockedStarter = players.map((p) => (p.player.id === 'wr1' ? { ...p, locked: true } : p));
    expect(place(lockedStarter, SLOTS, at, 'wr2', { kind: 'slot', slot: 'WR', occupant: 'wr1' })).toBeNull();
    expect(place(players, SLOTS, at, 'wr2', { kind: 'bench' })).toBeNull();
    expect(place(players, SLOTS, at, 'wr2', { kind: 'player', playerId: 'hurt' })).toBeNull();
    expect(place(players, SLOTS, at, 'qb', { kind: 'player', playerId: 'wr2' })).toBeNull();
    expect(place(players, SLOTS, at, 'wr1', { kind: 'slot', slot: 'WR', occupant: 'wr1' })).toBeNull();
    expect(place(players, SLOTS, at, 'nobody', { kind: 'bench' })).toBeNull();
    // IR takes only an injured player, and only while there is room.
    expect(place(players, SLOTS, at, 'wr2', { kind: 'ir' })).toBeNull();
    const onIr = place(players, SLOTS, at, 'hurt', { kind: 'ir' });
    expect(onIr).toMatchObject({ hurt: 'IR' });
    const another = [...players, entry('hurt2', 'RB', 'BN', { status: 'ir' })];
    expect(place(another, SLOTS, { ...onIr, hurt2: 'BN' }, 'hurt2', { kind: 'ir' })).toBeNull();
  });

  it('totals the starters who will play and lists the moves to save', () => {
    expect(projectedTotal(players, at)).toBe(40);
    const next = place(players, SLOTS, at, 'wr2', { kind: 'slot', slot: 'WR', occupant: 'wr1' })!;
    expect(projectedTotal(players, next)).toBe(47);
    // An Out starter counts nothing.
    expect(projectedTotal(players, { ...at, hurt: 'W/R/T', rb1: 'BN' })).toBe(28);
    expect(willPlay(entry('bye', 'WR', 'BN', { onBye: true }))).toBe(false);
    expect(changes(players, next).map((c) => [c.entry.player.id, c.from, c.to])).toEqual([
      ['wr1', 'WR', 'BN'],
      ['wr2', 'BN', 'WR']
    ]);
    expect(movesFor(players, next)).toEqual([
      { playerId: 'wr1', slot: 'BN' },
      { playerId: 'wr2', slot: 'WR' }
    ]);
    expect(applyMoves(players, [{ playerId: 'wr2', slot: 'WR' }])).toMatchObject({ wr2: 'WR', wr1: 'WR' });
  });

  it('handles edge cases: unknown slots and players, no IR, and a WR swapping flex and WR', () => {
    expect(isEligible('DL', 'LB')).toBe(false);
    expect(placed(players, {})[0]?.slot).toBe('QB');
    expect(changes(players, {})).toEqual([]);
    const noIr = SLOTS.filter((s) => s.slot !== 'IR');
    expect(place(players, noIr, at, 'hurt', { kind: 'ir' })).toBeNull();
    expect(place(players, SLOTS, at, 'wr1', { kind: 'player', playerId: 'nobody' })).toBeNull();
    const wrFlex = { ...at, rb1: 'BN', wr2: 'W/R/T' };
    expect(
      place(players, SLOTS, wrFlex, 'wr1', { kind: 'slot', slot: 'W/R/T', occupant: 'wr2' })
    ).toMatchObject({
      wr1: 'W/R/T',
      wr2: 'WR'
    });
  });

  it('lays out one seat per starting slot, empty ones included', () => {
    expect(
      seats(players, SLOTS, { ...at, rb1: 'BN' }).map((s) => [s.key, s.entry?.player.id ?? null])
    ).toEqual([
      ['QB-0', 'qb'],
      ['WR-0', 'wr1'],
      ['W/R/T-0', null]
    ]);
  });

  it('describes the game: home or away, and the kickoff', () => {
    expect(gameLine(entry('a', 'WR', 'BN'))).toMatch(/^vs BUF · \w{3} /);
    expect(gameLine(entry('a', 'WR', 'BN', { opponent: { team: 'KC', home: false } }))).toMatch(/^@ KC · /);
    expect(gameLine(entry('a', 'WR', 'BN', { opponent: undefined }))).not.toContain('vs');
    expect(gameLine(entry('a', 'WR', 'BN', { onBye: true, kickoff: null }))).toBe('Bye');
  });
});

describe('the lineup editor', () => {
  const lineup = () =>
    roster(
      [
        entry('qb1', 'QB', 'QB', { locked: true, projectedPoints: 18.5, points: 6 }),
        entry('wr1', 'WR', 'WR', { projectedPoints: 9, recentPoints: { average: 11.25, games: 3 } }),
        entry('rb1', 'RB', 'W/R/T', {
          status: 'out',
          injuryStatus: 'Out',
          byeWeek: null,
          opponent: null,
          player: { id: 'rb1', name: 'RB1', team: null, position: 'RB' }
        }),
        entry('wr2', 'WR', 'BN', { projectedPoints: 14 }),
        entry('wr3', 'WR', 'BN', { onBye: true, kickoff: null, opponent: null, byeWeek: 1 })
      ],
      {
        optimal: {
          projectedPoints: 41.5,
          moves: [
            { playerId: 'rb1', slot: 'BN' },
            { playerId: 'wr2', slot: 'W/R/T' }
          ]
        }
      }
    );

  it('shows each player’s projection, game, availability, and the lineup total', async () => {
    open({ getRoster: vi.fn(async () => lineup()) });
    const wr1 = await screen.findByTestId('roster-row-wr1');
    expect(within(wr1).getByTestId('player-projection')).toHaveTextContent('9.0');
    expect(within(wr1).getByTestId('game-line')).toHaveTextContent(/^vs BUF · /);
    expect(wr1).toHaveTextContent(/Last 3 weeks average 11.3/);
    // Locked by the server; the game state says how far along his game is.
    expect(within(screen.getByTestId('roster-row-qb1')).getByTestId('lock-status')).toHaveTextContent(
      /^Locked$/
    );
    expect(screen.getByTestId('roster-row-qb1')).toHaveTextContent('6.0 pts');
    expect(within(screen.getByTestId('roster-row-rb1')).getByText('Out')).toBeInTheDocument();
    expect(within(screen.getByTestId('roster-row-wr3')).getByText('Bye')).toBeInTheDocument();
    // 18.5 + 9; the Out flex counts nothing.
    await waitFor(() => expect(screen.getByTestId('lineup-projection')).toHaveTextContent('27.50'));
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Optimize lineup (+14.00)' })).toBeEnabled();
  });

  it('moves a player by selecting him and then a slot, highlighting where he can go, and saves', async () => {
    let current = lineup();
    const setLineup = vi.fn(async () => {
      current = roster(
        current.players.map((p) =>
          p.player.id === 'wr2' ? { ...p, slot: 'WR' } : p.player.id === 'wr1' ? { ...p, slot: 'BN' } : p
        )
      );
      return { roster: current, warnings: [{ code: 'NOTE', message: 'Saved with a note.' }] };
    });
    const api = open({ getRoster: vi.fn(async () => current), setLineup });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'WR2, BN' }));
    expect(screen.getByTestId('moving-banner')).toHaveTextContent('Moving WR2');
    expect(screen.getByRole('button', { name: /^Selected: WR2/ })).toHaveAttribute('aria-pressed', 'true');
    // WR and the flex light up; the locked QB and the QB slot dim.
    expect(screen.getByTestId('roster-row-wr1')).toHaveAttribute('data-target', 'valid');
    expect(screen.getByTestId('roster-row-rb1')).toHaveAttribute('data-target', 'valid');
    expect(screen.getByTestId('roster-row-qb1')).toHaveAttribute('data-target', 'invalid');
    expect(screen.getByRole('button', { name: /QB1: WR2 cannot go here/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    // A dimmed target does nothing; Cancel lets go.
    await user.click(screen.getByRole('button', { name: /QB1: WR2 cannot go here/ }));
    expect(screen.getByTestId('moving-banner')).toBeInTheDocument();
    await user.click(within(screen.getByTestId('moving-banner')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('moving-banner')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'WR2, BN' }));

    await user.click(screen.getByRole('button', { name: 'Move WR2 to WR, swapping with WR1' }));
    const pending = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(pending).toHaveTextContent('2 unsaved changes');
    expect(pending).toHaveTextContent('Projected 27.50 → 32.50 (+5.00)');
    expect(within(pending).getByText('WR2').parentElement).toHaveTextContent('+14.0');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByTestId('lineup-projection-delta')).toHaveTextContent('+5.00 vs saved');
    expect(screen.getByTestId('lineup-announcer')).toHaveTextContent('WR2 moved to WR, swapping with WR1.');
    expect(setLineup).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save lineup' }));
    expect(await screen.findByText('Saved with a note.')).toBeInTheDocument();
    expect(setLineup).toHaveBeenCalledWith('L1', 'team-1', 1, [
      { playerId: 'wr1', slot: 'BN' },
      { playerId: 'wr2', slot: 'WR' }
    ]);
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument()
    );
    expect(api.getRoster).toHaveBeenCalledTimes(2);
  });

  it('works from the keyboard: Enter to pick, Enter to place, Escape to cancel', async () => {
    open({ getRoster: vi.fn(async () => lineup()) });
    const user = userEvent.setup();
    const wr2 = await screen.findByRole('button', { name: 'WR2, BN' });
    wr2.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('moving-banner')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('moving-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('lineup-announcer')).toHaveTextContent('Move cancelled.');

    screen.getByRole('button', { name: 'WR1, WR' }).focus();
    await user.keyboard('{Enter}');
    // A starter can go to the bench from its header, or swap with a bench player.
    expect(screen.getByTestId('roster-row-wr2')).toHaveAttribute('data-target', 'valid');
    expect(screen.getByTestId('roster-row-wr3')).toHaveAttribute('data-target', 'valid');
    screen.getByRole('button', { name: 'Move to bench' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('lineup-empty-WR-0')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toHaveTextContent('1 unsaved change');
    // Choosing the empty slot puts someone back in it.
    await user.click(screen.getByRole('button', { name: 'WR2, BN' }));
    await user.click(screen.getByRole('button', { name: 'Move here: empty WR slot' }));
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toHaveTextContent('2 unsaved changes');
    // Selecting the same player twice lets go of him; a locked player cannot be picked up.
    await user.click(screen.getByRole('button', { name: 'WR3, BN' }));
    await user.click(screen.getByRole('button', { name: /^Selected: WR3/ }));
    expect(screen.queryByTestId('moving-banner')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'QB1, QB, locked' }));
    expect(screen.queryByTestId('moving-banner')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('optimizes: shows the diff to review, then saves those moves', async () => {
    const setLineup = vi.fn(async () => ({ roster: lineup(), warnings: [] }));
    open({ getRoster: vi.fn(async () => lineup()), setLineup });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Optimize lineup (+14.00)' }));
    const pending = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(pending).toHaveTextContent('Projected 27.50 → 41.50 (+14.00)');
    expect(within(pending).getByText('RB1').parentElement).toHaveTextContent('W/R/T → BN');
    expect(within(pending).getByText('WR2').parentElement).toHaveTextContent('BN → W/R/T');
    expect(screen.getByRole('button', { name: 'Optimize lineup' })).toBeDisabled();
    expect(screen.getByText('Your lineup is the best projected one.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save lineup' }));
    await waitFor(() =>
      expect(setLineup).toHaveBeenCalledWith('L1', 'team-1', 1, [
        { playerId: 'rb1', slot: 'BN' },
        { playerId: 'wr2', slot: 'W/R/T' }
      ])
    );
  });

  it('keeps the changes and shows the server’s reason when a save is refused', async () => {
    open({
      getRoster: vi.fn(async () => lineup()),
      setLineup: vi.fn(async () => {
        throw refused(400, 'INVALID_LINEUP', 'WR2 is locked.', 'Keep him on the bench.');
      })
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Optimize lineup (+14.00)' }));
    await user.click(screen.getByRole('button', { name: 'Save lineup' }));
    expect(await screen.findByText('WR2 is locked.')).toBeInTheDocument();
    expect(screen.getByText('Keep him on the bench.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toBeInTheDocument();
  });

  it('names the player who locked when a save loses the race with his kickoff, then reloads (#193)', async () => {
    let reads = 0;
    const getRoster = vi.fn(async () => {
      reads++;
      return lineup();
    });
    open({
      getRoster,
      setLineup: vi.fn(async () => {
        throw new ApiError(409, {
          code: 'PLAYER_LOCKED',
          message: "WR2 (wr2)'s game has kicked off.",
          fix: 'Keep him.',
          details: { lockedPlayerIds: ['wr2', 'nobody'] }
        });
      })
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Optimize lineup (+14.00)' }));
    await user.click(screen.getByRole('button', { name: 'Save lineup' }));
    expect(await screen.findByTestId('lock-race')).toHaveTextContent(
      'WR2 is locked: his game kicked off before your changes were saved, so nothing was changed.'
    );
    // No generic error, and a fresh board from the server's lineup.
    expect(screen.queryByText("WR2 (wr2)'s game has kicked off.")).not.toBeInTheDocument();
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('words the race generically when the refusal names nobody it knows, and in the plural', async () => {
    const two = () =>
      roster(
        [entry('wr1', 'WR', 'WR', { projectedPoints: 9 }), entry('wr2', 'WR', 'BN', { projectedPoints: 14 })],
        {
          optimal: {
            projectedPoints: 14,
            moves: [
              { playerId: 'wr2', slot: 'WR' },
              { playerId: 'wr1', slot: 'BN' }
            ]
          }
        }
      );
    let details: unknown = { lockedPlayerIds: ['wr1', 'wr2'] };
    open({
      getRoster: vi.fn(async () => two()),
      setLineup: vi.fn(async () => {
        throw new ApiError(409, { code: 'PLAYER_LOCKED', message: 'Locked.', fix: 'Keep them.', details });
      })
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Optimize lineup/ }));
    await user.click(screen.getByRole('button', { name: 'Save lineup' }));
    expect(await screen.findByTestId('lock-race')).toHaveTextContent(
      'WR1 and WR2 are locked: their games kicked off'
    );
    details = null;
    await user.click(await screen.findByRole('button', { name: /^Optimize lineup/ }));
    await user.click(screen.getByRole('button', { name: 'Save lineup' }));
    await waitFor(() =>
      expect(screen.getByTestId('lock-race')).toHaveTextContent(
        'A game kicked off before your changes were saved, so nothing was changed.'
      )
    );
  });

  it('counts down the last hour and locks a player at his kickoff without a reload (#193)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-09-13T16:48:00.000Z'));
    const game = {
      state: 'live' as const,
      opponent: 'BUF',
      home: true,
      kickoff: '2026-09-13T16:00:00.000Z',
      period: 2,
      clock: '8:42',
      teamScore: 7,
      opponentScore: 3,
      possession: false,
      redZone: false,
      progress: 0.35
    };
    open({
      getRoster: vi.fn(async () =>
        roster([
          entry('qb1', 'QB', 'QB', { locked: true, kickoff: '2026-09-13T16:00:00.000Z', game }),
          entry('wr1', 'WR', 'WR'),
          entry('wr2', 'WR', 'BN', { kickoff: '2026-09-13T20:25:00.000Z' }),
          entry('wr3', 'WR', 'BN', {
            locked: true,
            game: { ...game, state: 'final', period: 4, clock: null }
          })
        ])
      )
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
    }
    const wr1 = screen.getByTestId('roster-row-wr1');
    expect(within(screen.getByTestId('roster-row-qb1')).getByTestId('lock-status')).toHaveTextContent(
      'Locked · Q2 8:42'
    );
    expect(within(screen.getByTestId('roster-row-wr3')).getByTestId('lock-status')).toHaveTextContent(
      'Locked · Final'
    );
    expect(within(wr1).getByTestId('lock-status')).toHaveTextContent('Locks in 12m');
    // More than an hour away: no countdown yet.
    expect(within(screen.getByTestId('roster-row-wr2')).queryByTestId('lock-status')).toBeNull();
    expect(screen.getByRole('button', { name: 'WR1, WR' })).toHaveAttribute('aria-disabled', 'false');

    // The countdown ticks, then his kickoff locks him on the spot.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9 * 60_000);
    });
    expect(within(wr1).getByTestId('lock-status')).toHaveTextContent('Locks in 3m');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(within(wr1).getByTestId('lock-status')).toHaveTextContent(/^Locked$/);
    expect(screen.getByRole('button', { name: 'WR1, WR, locked' })).toHaveAttribute('aria-disabled', 'true');
    vi.useRealTimers();
  });

  it('offers a one-tap lineup when nobody starts, ranked by consensus rank without projections', async () => {
    const empty = () =>
      roster(
        [
          entry('qb1', 'QB', 'BN', { projectedPoints: null }),
          entry('wr1', 'WR', 'BN', { projectedPoints: null }),
          entry('wr2', 'WR', 'BN', { projectedPoints: null })
        ],
        {
          lineupSaved: false,
          optimal: {
            basis: 'rank',
            projectedPoints: 0,
            moves: [
              { playerId: 'qb1', slot: 'QB' },
              { playerId: 'wr1', slot: 'WR' },
              { playerId: 'wr2', slot: 'W/R/T' }
            ]
          }
        }
      );
    const setLineup = vi.fn(async () => ({ roster: empty(), warnings: [] }));
    open({ getRoster: vi.fn(async () => empty()), setLineup });
    const user = userEvent.setup();
    const callout = await screen.findByRole('region', { name: 'Your lineup is empty' });
    expect(callout).toHaveTextContent('by consensus rank (no projections yet)');
    expect(screen.getByRole('button', { name: 'Optimize lineup (by rank)' })).toBeEnabled();
    expect(screen.getByTestId('optimize-note')).toHaveTextContent(
      'No projections for week 1 yet: ranked by consensus rank instead.'
    );
    await user.click(within(callout).getByRole('button', { name: 'Set my lineup' }));
    await waitFor(() =>
      expect(setLineup).toHaveBeenCalledWith('L1', 'team-1', 1, [
        { playerId: 'qb1', slot: 'QB' },
        { playerId: 'wr1', slot: 'WR' },
        { playerId: 'wr2', slot: 'W/R/T' }
      ])
    );
  });

  it('prompts by projection when there are projections', async () => {
    open({
      getRoster: vi.fn(async () =>
        roster([entry('qb1', 'QB', 'BN')], {
          optimal: { basis: 'projections', projectedPoints: 10, moves: [{ playerId: 'qb1', slot: 'QB' }] }
        })
      )
    });
    expect(await screen.findByRole('region', { name: 'Your lineup is empty' })).toHaveTextContent(
      'Start your highest-projected players'
    );
  });

  it('says when there is no suggestion, and offers IR to a hurt player', async () => {
    open({
      getRoster: vi.fn(async () =>
        roster(
          [entry('wr1', 'WR', 'WR', { projectedPoints: null }), entry('hurt', 'WR', 'BN', { status: 'ir' })],
          { optimal: undefined, lineupSaved: false, carriedFromWeek: 0 }
        )
      )
    });
    const user = userEvent.setup();
    expect(await screen.findByText('No lineup suggestion is available.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Optimize lineup' })).toBeDisabled();
    expect(screen.getByText(/carried over from week 0/)).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('roster-row-wr1')).getByTestId('player-projection')).toHaveTextContent(
      '–'
    );
    await user.click(screen.getByRole('button', { name: 'HURT, BN' }));
    await user.click(screen.getByRole('button', { name: 'Move to IR' }));
    expect(screen.getByRole('list', { name: 'IR' })).toHaveTextContent('HURT');
  });
});

describe('drag and drop', () => {
  // jsdom lays nothing out, so give each lineup row a 60px band stacked down the page.
  const ROW = '[data-testid^="roster-row-"], [data-testid^="lineup-empty-"], [data-testid^="drop-"]';
  let rects: { mockRestore: () => void };
  beforeEach(() => {
    rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const rows = [...document.querySelectorAll(ROW)];
      const row = this.closest(ROW);
      const i = row === null ? -1 : rows.indexOf(row);
      const top = i < 0 ? 5000 : i * 60;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 400,
        bottom: top + 60,
        width: 400,
        height: 60,
        toJSON: () => ({})
      };
    });
  });
  afterEach(() => rects.mockRestore());

  const at = (y: number) => ({ clientX: 100, clientY: y, button: 0 });

  it('drags a bench player onto a starter: targets light up, the drop swaps them', async () => {
    const players = [
      entry('qb1', 'QB', 'QB', { projectedPoints: 18 }),
      entry('wr1', 'WR', 'WR', { projectedPoints: 9 }),
      entry('rb1', 'RB', 'W/R/T', { projectedPoints: 5 }),
      entry('wr2', 'WR', 'BN', { projectedPoints: 14 })
    ];
    open({ getRoster: vi.fn(async () => roster(players)) });
    const handle = await screen.findByRole('button', { name: 'WR2, BN' });
    // Rows: QB1 0-60, WR1 60-120, RB1 120-180, WR2 180-240.
    await act(async () => {
      fireEvent.mouseDown(handle, at(200));
      fireEvent.mouseMove(document, at(190));
      fireEvent.mouseMove(document, at(180));
    });
    await waitFor(() => expect(screen.getByTestId('roster-row-wr1')).toHaveAttribute('data-target', 'valid'));
    expect(screen.getByTestId('roster-row-qb1')).toHaveAttribute('data-target', 'invalid');
    await act(async () => {
      fireEvent.mouseMove(document, at(90));
      fireEvent.mouseMove(document, at(91));
    });
    await act(async () => {
      fireEvent.mouseUp(document, at(91));
    });
    const pending = await screen.findByRole('region', { name: 'Unsaved changes' });
    expect(pending).toHaveTextContent('WR2 BN → WR');
    expect(pending).toHaveTextContent('WR1 WR → BN');
    expect(screen.getByTestId('lineup-announcer')).toHaveTextContent('WR2 moved to WR, swapping with WR1.');
  });

  it('drops a starter on the bench heading, in a league without IR', async () => {
    const slots = SLOTS.filter((s) => s.slot !== 'IR');
    open({
      getRoster: vi.fn(async () =>
        roster(
          [
            entry('qb1', 'QB', 'QB'),
            entry('wr1', 'WR', 'WR', { projectedPoints: null, recentPoints: { average: 7, games: 1 } })
          ],
          { slots }
        )
      )
    });
    const handle = await screen.findByRole('button', { name: 'WR1, WR' });
    expect(screen.getByTestId('roster-row-wr1')).toHaveTextContent(/Last 3 weeks average 7.0/);
    expect(screen.queryByRole('list', { name: 'IR' })).not.toBeInTheDocument();
    // Rows: QB1 0-60, WR1 60-120, the empty flex 120-180, the bench heading 180-240.
    await act(async () => {
      fireEvent.mouseDown(handle, at(80));
      fireEvent.mouseMove(document, at(90));
      fireEvent.mouseMove(document, at(100));
    });
    await waitFor(() => expect(screen.getByTestId('drop-bench')).toHaveTextContent('Drop here'));
    await act(async () => {
      fireEvent.mouseMove(document, at(200));
      fireEvent.mouseMove(document, at(201));
    });
    await act(async () => {
      fireEvent.mouseUp(document, at(201));
    });
    expect(await screen.findByRole('region', { name: 'Unsaved changes' })).toHaveTextContent('WR1 WR → BN');
  });

  it('changes nothing when a drag ends away from a target, or is cancelled', async () => {
    open({ getRoster: vi.fn(async () => roster([entry('qb1', 'QB', 'QB'), entry('wr2', 'WR', 'BN')])) });
    const handle = await screen.findByRole('button', { name: 'WR2, BN' });
    await act(async () => {
      fireEvent.mouseDown(handle, at(80));
      fireEvent.mouseMove(document, at(70));
      fireEvent.mouseMove(document, at(20));
    });
    await act(async () => {
      fireEvent.mouseUp(document, at(20));
    });
    await act(async () => {
      fireEvent.mouseDown(handle, at(80));
      fireEvent.mouseMove(document, at(70));
      fireEvent.mouseMove(document, at(20));
      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    });
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('announces a drag for screen readers', () => {
    const say = dragAnnouncements((id) => id.toUpperCase());
    const active = { id: 'wr2' } as never;
    const over = { id: 'WR-0', data: { current: { label: 'WR, swapping with WR1' } } } as never;
    expect(say.onDragStart({ active })).toBe('Picked up WR2.');
    expect(say.onDragOver({ active, over })).toBe('WR2 is over WR, swapping with WR1.');
    expect(say.onDragOver({ active, over: null })).toBe('WR2 is not over a slot.');
    expect(say.onDragEnd({ active, over })).toBe('WR2 was dropped on WR, swapping with WR1.');
    expect(say.onDragEnd({ active, over: null })).toBe('WR2 was dropped back where he was.');
    expect(say.onDragCancel({ active, over: null })).toBe('Moving WR2 was cancelled.');
  });
});

describe('the lineup page on game day (#193)', () => {
  it('reloads the lineup when the NFL games change', async () => {
    let push: (event: LeagueEvent) => void = () => undefined;
    const connect: EventConnect = async (target, handlers) => {
      expect(target.topics).toContain('fantasy.global');
      push = handlers.onEvent;
      return () => undefined;
    };
    const api = fakeApi({
      getLeagueState: vi.fn(async () => state({ phase: 'regular_season', week: 1 })),
      getRoster: vi.fn(async () => roster([entry('qb1', 'QB', 'QB'), entry('wr1', 'WR', 'WR')])),
      getRealtime: vi.fn(async () => ({
        enabled: true,
        token: 't',
        endpoint: null,
        cacheName: 'c',
        topics: { league: 'fantasy.league.L1', global: 'fantasy.global' },
        expiresAt: null,
        pollIntervalSeconds: 30
      }))
    });
    render(
      <LeagueApiContext.Provider value={api}>
        <MemoryRouter initialEntries={['/leagues/L1/roster']}>
          <Routes>
            <Route path="/leagues/:leagueId/roster" element={<RosterPage connect={connect} />} />
          </Routes>
        </MemoryRouter>
      </LeagueApiContext.Provider>
    );
    expect(await screen.findByTestId('roster-row-qb1')).toBeInTheDocument();
    await waitFor(() => expect(api.getRealtime).toHaveBeenCalled());
    act(() => push({ detailType: 'NFL Games Updated', leagueId: null }));
    await waitFor(() => expect(api.getRoster).toHaveBeenCalledTimes(2));
  });

  it('shows a player ruled out without a reload, and ignores other teams’ players (#200)', async () => {
    let push: (event: LeagueEvent) => void = () => undefined;
    const connect: EventConnect = async (_target, handlers) => {
      push = handlers.onEvent;
      return () => undefined;
    };
    let out = false;
    const api = fakeApi({
      getLeagueState: vi.fn(async () => state({ phase: 'regular_season', week: 1 })),
      getRoster: vi.fn(async () =>
        roster([
          entry('qb1', 'QB', 'QB'),
          entry('wr1', 'WR', 'WR', out ? { status: 'out', injuryStatus: 'Out' } : {})
        ])
      ),
      getRealtime: vi.fn(async () => ({
        enabled: true,
        token: 't',
        endpoint: null,
        cacheName: 'c',
        topics: { league: 'fantasy.league.L1', global: 'fantasy.global' },
        expiresAt: null,
        pollIntervalSeconds: 30
      }))
    });
    render(
      <LeagueApiContext.Provider value={api}>
        <MemoryRouter initialEntries={['/leagues/L1/roster']}>
          <Routes>
            <Route path="/leagues/:leagueId/roster" element={<RosterPage connect={connect} />} />
          </Routes>
        </MemoryRouter>
      </LeagueApiContext.Provider>
    );
    expect(await screen.findByTestId('roster-row-wr1')).toBeInTheDocument();
    await waitFor(() => expect(api.getRealtime).toHaveBeenCalled());
    act(() => push({ detailType: 'Player Status Changed', leagueId: null, detail: { playerId: 'someone' } }));
    out = true;
    act(() => push({ detailType: 'Player Status Changed', leagueId: null, detail: { playerId: 'wr1' } }));
    await waitFor(() => expect(api.getRoster).toHaveBeenCalledTimes(2));
    expect(await within(screen.getByTestId('roster-row-wr1')).findByText('Out')).toBeInTheDocument();
  });
});

describe('a player notification’s lineup link (#200)', () => {
  const hurt = () =>
    roster([
      entry('qb1', 'QB', 'QB'),
      entry('wr1', 'WR', 'WR', { status: 'out', injuryStatus: 'Out' }),
      entry('wr2', 'WR', 'BN', { projectedPoints: 12 }),
      entry('wr3', 'WR', 'BN', { status: 'questionable', injuryStatus: 'Questionable' })
    ]);

  function openAt(path: string, overrides: Partial<LeagueApi> = {}) {
    const api = fakeApi({
      getLeagueState: vi.fn(async () => state({ phase: 'regular_season', week: 1 })),
      getRoster: vi.fn(async () => hurt()),
      ...overrides
    });
    renderApp(path, undefined, api);
    return api;
  }

  it('highlights the ruled-out starter, selected, so one tap on a bench player replaces him', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    openAt('/leagues/L1/team/lineup?player=wr1');
    const row = await screen.findByTestId('roster-row-wr1');
    expect(row).toHaveAttribute('data-highlighted', 'true');
    expect(screen.getByTestId('player-alert')).toHaveTextContent(
      'WR1 is Out. Tap a highlighted player to start in his place, then save.'
    );
    expect(screen.getByTestId('moving-banner')).toHaveTextContent('Moving WR1');
    await user.click(within(screen.getByTestId('roster-row-wr2')).getByRole('button'));
    expect(screen.getByTestId('pending-changes')).toBeInTheDocument();
  });

  it('only points at a bench player, or a questionable starter, without moving anyone', async () => {
    openAt('/leagues/L1/team/lineup?player=wr3');
    expect(await screen.findByTestId('player-alert')).toHaveTextContent(
      'WR3 is Questionable and on your bench.'
    );
    expect(screen.queryByTestId('moving-banner')).not.toBeInTheDocument();
  });
});
