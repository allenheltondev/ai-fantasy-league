import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DraftTopBar } from './DraftTopBar';
import type { DraftBoard } from './board';

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

it('measures a resized clock so mobile research actions can stay below it, and releases the observer', () => {
  let resize!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    }
  );
  const measure = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 0, 300, 96));
  const onHeight = vi.fn();
  try {
    const view = render(
      <DraftTopBar
        board={board}
        seconds={null}
        yourTurn={false}
        live={false}
        updates="Refreshing"
        sound={{ enabled: false, toggle: vi.fn() }}
        commissioner={null}
        onHeight={onHeight}
      />
    );
    expect(onHeight).toHaveBeenLastCalledWith(104);
    measure.mockReturnValue(new DOMRect(0, 0, 300, 120));
    resize();
    expect(onHeight).toHaveBeenLastCalledWith(128);
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  } finally {
    measure.mockRestore();
    vi.unstubAllGlobals();
  }
});
