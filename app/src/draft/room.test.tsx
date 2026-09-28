import { act, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  needsFromSlots,
  needsLine,
  positionTone,
  roundPick,
  shortName,
  teamAt,
  type DraftBoard
} from './board';
import { BoardGrid, PickTicker } from './BoardViews';
import { DraftTopBar, type DraftTopBarProps } from './DraftTopBar';
import { PositionChip, TeamMark } from './marks';
import { RosterPanel } from './Panels';
import { playChime, useDraftSound } from './sound';

/** The draft room's pieces (#170) on their own: helpers, marks, the ticker and grid, the top bar, sound. */

const ref = (id: string, name: string, position: string, team: string | null = 'SF') => ({
  id,
  name,
  team,
  position
});

function board(overrides: Partial<DraftBoard> = {}): DraftBoard {
  return {
    status: 'in_progress',
    rounds: 2,
    pickSeconds: 90,
    startedAt: '2026-09-30T11:59:00.000Z',
    completedAt: null,
    order: [
      { teamId: 'team-1', teamName: "Allen's Team", seatType: 'human' },
      { teamId: 'team-2', teamName: 'Robo', seatType: 'agent', manager: null }
    ],
    onTheClock: {
      overall: 1,
      round: 1,
      pick: 1,
      teamId: 'team-1',
      teamName: "Allen's Team",
      deadline: null,
      secondsLeft: 60
    },
    yourTeamId: 'team-2',
    yourNextPick: { overall: 2, round: 1, pick: 2, picksAway: 1 },
    yourNeeds: [],
    picks: [],
    rosters: [],
    bestAvailable: [],
    ...overrides
  };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('draft room helpers', () => {
  it('finds the team at a snake pick, and nobody outside the draft', () => {
    const order = ['a', 'b', 'c'];
    expect([1, 2, 3, 4, 5, 6, 7].map((o) => teamAt(order, o))).toEqual(['a', 'b', 'c', 'c', 'b', 'a', 'a']);
    expect(teamAt(order, 0)).toBeUndefined();
    expect(teamAt([], 1)).toBeUndefined();
  });

  it('writes round.pick, short names, needs, and position colors', () => {
    expect(roundPick(3, 7)).toBe('3.07');
    expect(roundPick(12, 10)).toBe('12.10');
    expect(shortName(ref('a', "Ja'Marr Chase", 'WR'))).toBe('J. Chase');
    expect(shortName(ref('b', 'Amon-Ra St. Brown', 'WR'))).toBe('A. St. Brown');
    expect(shortName(ref('c', 'Pelé', 'WR'))).toBe('Pelé');
    expect(shortName(ref('d', 'NYJ Defense', 'DEF'))).toBe('NYJ Defense');
    expect(
      needsLine([
        { slot: 'TE', player: null },
        { slot: 'K', player: 'x' },
        { slot: 'TE', player: null }
      ])
    ).toBe('2 TE');
    expect(needsFromSlots(['TE', 'DEF', 'K'])).toBe('1 TE, 1 DEF, 1 K');
    expect(needsFromSlots([])).toBe('');
    expect(positionTone('QB').chip).toContain('error');
    expect(positionTone('LB').chip).toBe('bg-muted text-foreground');
  });
});

describe('marks', () => {
  it('draws an AI manager’s avatar, or a person’s initials', () => {
    const { container } = render(
      <>
        <TeamMark
          teamId="t1"
          teamName="Robo"
          manager={{ name: 'Sheets', avatarSeed: 's', personality: null }}
        />
        <TeamMark teamId="t2" teamName="Allen's Team" />
        <TeamMark teamId="t3" teamName="!!!" manager={null} />
        <PositionChip position="TE" />
      </>
    );
    expect(container.querySelector('svg[aria-label="Sheets avatar"]')).not.toBeNull();
    const initials = screen.getAllByTestId('team-initials').map((e) => e.textContent);
    expect(initials).toEqual(['AT', '?']);
    expect(screen.getByText('TE')).toHaveAttribute('data-position', 'TE');
  });
});

describe('pick ticker and board grid', () => {
  it('says there are no picks yet, and names the slots coming up', () => {
    render(<PickTicker board={board()} arrived={() => false} onOpen={vi.fn()} />);
    const ticker = screen.getByRole('list', { name: 'Recent picks' });
    expect(ticker).toHaveTextContent('No picks yet.');
    const slots = within(ticker).getAllByRole('listitem').slice(1);
    // Four slots in a 2-team, 2-round draft: the clock, then You, You, and Allen's Team again.
    expect(slots.map((s) => s.textContent)).toEqual([
      "AT1.01Allen's TeamOn the clock",
      'R1.02You',
      'R2.01You',
      "AT2.02Allen's Team"
    ]);
  });

  it('shows the picks of a team no longer in the order by its id', () => {
    const picks = [
      {
        overall: 1,
        round: 1,
        pick: 1,
        teamId: 'gone',
        player: ref('p1', 'Some Body', 'QB'),
        auto: false,
        madeAt: null
      }
    ];
    const done = board({ picks, onTheClock: null, status: 'complete' });
    render(<PickTicker board={done} arrived={() => false} onOpen={vi.fn()} />);
    expect(screen.getByTestId('ticker-1')).toHaveTextContent('1.01goneS. Body');
    expect(screen.queryByTestId('ticker-clock')).toBeNull();
    expect(screen.queryByText('No picks yet.')).toBeNull();
  });

  it('highlights your column and the pick on the clock', () => {
    render(<BoardGrid board={board()} arrived={() => false} onOpen={vi.fn()} />);
    expect(screen.getByTestId('cell-1')).toHaveClass('motion-clock-cell');
    expect(screen.getByTestId('cell-2')).toHaveClass('border-primary-300');
    expect(screen.getByTestId('cell-4')).toHaveClass('border-border');
  });
});

describe('top bar', () => {
  const props = (overrides: Partial<DraftTopBarProps> = {}): DraftTopBarProps => ({
    board: board(),
    seconds: 60,
    yourTurn: false,
    updates: 'Updating live',
    live: true,
    sound: { enabled: false, toggle: vi.fn() },
    commissioner: null,
    ...overrides
  });

  it('counts picks until yours, and waits between picks', () => {
    const { rerender } = render(
      <DraftTopBar
        {...props({ board: board({ yourNextPick: { overall: 4, round: 2, pick: 2, picksAway: 2 } }) })}
      />
    );
    expect(screen.getByTestId('your-next-pick')).toHaveTextContent('Your pick #4 in 2 picks');
    rerender(<DraftTopBar {...props({ board: board({ onTheClock: null }) })} />);
    expect(screen.getByText('Waiting for the next pick.')).toBeInTheDocument();
    expect(screen.queryByTestId('your-next-pick')).toBeNull();
  });
});

describe('roster panel', () => {
  it('shows a free agent in a starting seat', () => {
    render(
      <RosterPanel
        board={board({
          yourRoster: {
            starters: [{ slot: 'DEF', player: ref('d', 'NYJ Defense', 'DEF', null) }],
            bench: [],
            benchSize: 0
          }
        })}
        onOpen={vi.fn()}
      />
    );
    expect(screen.getByRole('list', { name: 'Your roster' })).toHaveTextContent('DEFDEFNYJ DefenseFA');
  });
});

describe('sound', () => {
  function fakeAudio() {
    const nodes: { started: number[]; freq: number[] } = { started: [], freq: [] };
    const close = vi.fn(async () => undefined);
    class FakeContext {
      currentTime = 1;
      destination = {};
      createOscillator() {
        const osc = {
          type: '',
          frequency: {
            set value(v: number) {
              nodes.freq.push(v);
            }
          },
          connect: (next: unknown) => next,
          start: (at: number) => nodes.started.push(at),
          stop: () => undefined
        };
        return osc;
      }
      createGain() {
        return {
          gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined },
          connect: (next: unknown) => next
        };
      }
      close = close;
    }
    return { FakeContext, nodes, close };
  }

  it('plays two rising notes, then closes the audio context', () => {
    vi.useFakeTimers();
    const { FakeContext, nodes, close } = fakeAudio();
    vi.stubGlobal('AudioContext', FakeContext);
    try {
      playChime();
      expect(nodes.freq).toEqual([660, 880]);
      expect(nodes.started).toEqual([1, 1.16]);
      vi.advanceTimersByTime(900);
      expect(close).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('stays silent without Web Audio, or when it fails', () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(() => playChime()).not.toThrow();
    vi.stubGlobal('AudioContext', function Broken() {
      throw new Error('blocked');
    });
    expect(() => playChime()).not.toThrow();
    vi.unstubAllGlobals();
  });

  it('is off by default, and plays only when on', () => {
    const play = vi.fn();
    const { result } = renderHook(() => useDraftSound(play));
    expect(result.current.enabled).toBe(false);
    act(() => result.current.play());
    expect(play).not.toHaveBeenCalled();
    act(() => result.current.toggle());
    act(() => result.current.play());
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('keeps working when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useDraftSound(vi.fn()));
    expect(result.current.enabled).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.enabled).toBe(true);
  });
});
