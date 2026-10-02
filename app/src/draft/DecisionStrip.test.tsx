import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DecisionStrip } from './DecisionStrip';
import type { DraftBoard } from './board';
import type { DraftQueue } from './queue';

const a = { id: 'a', name: 'First Choice', position: 'WR', team: 'DAL' };
const b = { id: 'b', name: 'Backup Choice', position: 'RB', team: 'SF' };
const board: DraftBoard = {
  status: 'in_progress',
  rounds: 3,
  pickSeconds: 60,
  startedAt: '',
  completedAt: null,
  order: [
    { teamId: 'other', teamName: 'Rival', seatType: 'agent' },
    { teamId: 'me', teamName: 'My team', seatType: 'human' }
  ],
  onTheClock: null,
  yourTeamId: 'me',
  yourNextPick: { overall: 2, round: 1, pick: 2, picksAway: 1 },
  yourNeeds: ['WR', 'K'],
  picks: [],
  rosters: [],
  bestAvailable: []
};
const queue: DraftQueue = {
  players: [a, b],
  ready: true,
  saving: false,
  error: null,
  has: (id) => ['a', 'b'].includes(id),
  add: vi.fn(),
  remove: vi.fn(),
  move: vi.fn()
};

describe('persistent draft decision context', () => {
  it('explains a snake turn and moves to the fallback when a rival takes the first choice', () => {
    const onOpen = vi.fn();
    const view = render(<DecisionStrip board={board} queue={queue} onOpen={onOpen} />);
    expect(screen.getByText(/back-to-back picks/)).toHaveTextContent('Pick #2 → #3');
    expect(screen.getByText(/Open starters:/)).toHaveTextContent('1 WR, 1 K');
    fireEvent.click(screen.getByRole('button', { name: 'Research queued player First Choice' }));
    expect(onOpen).toHaveBeenCalledWith(a);
    view.rerender(
      <DecisionStrip
        board={{
          ...board,
          picks: [{ overall: 1, round: 1, pick: 1, teamId: 'other', player: a, auto: false, madeAt: null }]
        }}
        queue={queue}
        onOpen={onOpen}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'First Choice went to Rival. Backup Choice is now first'
    );
    expect(screen.getByTestId('autopick-plan')).toHaveTextContent(
      'try Backup Choice if available and roster-eligible'
    );
    expect(screen.queryByRole('button', { name: 'Research queued player First Choice' })).toBeNull();
  });

  it('distinguishes pending and failed queue saves from the saved timeout plan', () => {
    const p = { board, onOpen: vi.fn() };
    const view = render(<DecisionStrip {...p} queue={{ ...queue, ready: false }} />);
    expect(screen.getByTestId('autopick-plan')).toHaveTextContent('Loading');
    view.rerender(<DecisionStrip {...p} queue={{ ...queue, saving: true }} />);
    expect(screen.getByTestId('autopick-plan')).toHaveTextContent('last saved order');
    view.rerender(<DecisionStrip {...p} queue={{ ...queue, error: 'offline' }} />);
    expect(screen.getByTestId('autopick-plan')).toHaveTextContent('could not be saved');
    view.rerender(<DecisionStrip {...p} queue={{ ...queue, players: [] }} />);
    expect(screen.getByTestId('autopick-plan')).toHaveTextContent('autopick chooses an available player');
  });

  it('keeps a long queue compact and accurately describes gaps and the final turn', () => {
    const p = { queue: { ...queue, players: [a, b, { ...a, id: 'c' }, { ...b, id: 'd' }] }, onOpen: vi.fn() };
    const view = render(
      <DecisionStrip
        {...p}
        board={{
          ...board,
          yourNextPick: { overall: 3, round: 2, pick: 1, picksAway: 0 },
          yourRoster: { starters: [{ slot: 'WR', player: a }], bench: [], benchSize: 2 }
        }}
      />
    );
    expect(screen.getByText('+1 more')).toBeInTheDocument();
    expect(screen.getByText(/picks between turns/)).toHaveTextContent('Pick #3 → #6 · 2 picks between turns');
    expect(screen.getByText(/Starting lineup filled/)).toBeInTheDocument();
    view.rerender(
      <DecisionStrip
        {...p}
        board={{ ...board, yourNextPick: { overall: 6, round: 3, pick: 2, picksAway: 0 } }}
      />
    );
    expect(screen.getByText(/your final pick/)).toBeInTheDocument();
    view.rerender(<DecisionStrip {...p} board={{ ...board, yourNextPick: null }} />);
    expect(screen.queryByText(/your final pick/)).toBeNull();
  });

  it('avoids showing a personal decision to spectators or after the draft', () => {
    const p = { queue, onOpen: vi.fn() };
    const view = render(<DecisionStrip {...p} board={{ ...board, yourTeamId: null }} />);
    expect(screen.queryByRole('region')).toBeNull();
    view.rerender(<DecisionStrip {...p} board={{ ...board, status: 'complete' }} />);
    expect(screen.queryByRole('region')).toBeNull();
  });
});

it('explains when a rival empties the shortlist, even if team metadata has not arrived', () => {
  render(
    <DecisionStrip
      onOpen={vi.fn()}
      queue={{ ...queue, players: [a] }}
      board={{
        ...board,
        picks: [{ overall: 1, round: 1, pick: 1, player: a, teamId: 'new-team', auto: false, madeAt: null }]
      }}
    />
  );
  expect(screen.getByRole('status')).toHaveTextContent(
    'First Choice went to another team. Your shortlist is open'
  );
});
