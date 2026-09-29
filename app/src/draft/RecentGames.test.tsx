import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RecentGames, trendOf } from './RecentGames';
import type { RecentGame } from './research';

const game = (week: number, points: number, extra: Partial<RecentGame> = {}): RecentGame => ({
  week,
  points,
  vsAverage: Math.round((points - 10) * 10) / 10,
  opponent: { team: 'BAL', home: true },
  breakdown: [
    { stat: 'rec_yd', text: '82 rec yds', points: 8.2 },
    { stat: 'rec_td', text: '1 rec TD', points: 6 },
    { stat: 'rec', text: '5 rec', points: 2.5 }
  ],
  ...extra
});

describe('trendOf', () => {
  it('compares the last games with the season average, with a floor for low scorers', () => {
    const recent = [game(5, 16), game(4, 14), game(3, 15)];
    expect(trendOf(recent, 10, 8)).toBe('up');
    expect(trendOf([game(5, 4), game(4, 5), game(3, 6)], 10, 8)).toBe('down');
    expect(trendOf([game(5, 11), game(4, 10), game(3, 9)], 10, 8)).toBe('steady');
    // A low scorer needs at least 1.5 points a game, not 15% of nothing.
    expect(trendOf([game(5, 3.6), game(4, 3.6)], 2, 8)).toBe('up');
    expect(trendOf([game(5, 2.5), game(4, 2.5)], 2, 8)).toBe('steady');
  });

  it('has no trend when the recent games are the whole season, or there are none', () => {
    expect(trendOf([game(5, 16), game(4, 14), game(3, 15)], 15, 3)).toBeNull();
    expect(trendOf([], 10, 8)).toBeNull();
  });
});

describe('RecentGames', () => {
  it('shows each game with its opponent, points, delta from his average, and where the points came from', () => {
    render(
      <RecentGames
        recent={[
          game(5, 16.7, { vsAverage: 6.7 }),
          game(4, 6.2, { vsAverage: -3.8, opponent: { team: 'CLE', home: false } }),
          game(3, 10, { vsAverage: 0, opponent: null })
        ]}
        ppg={10}
        games={8}
      />
    );
    expect(screen.getByRole('heading', { name: 'Last 3 games' })).toBeInTheDocument();
    const five = within(screen.getByTestId('recent-5'));
    expect(five.getByText('Week 5')).toBeInTheDocument();
    expect(five.getByText('vs BAL')).toBeInTheDocument();
    expect(five.getByText('16.7')).toBeInTheDocument();
    expect(five.getByText(/above his average/).parentElement).toHaveTextContent('▲ 6.7 above his average');
    expect(five.getByText('82 rec yds')).toBeInTheDocument();
    expect(five.getByText('+8.2')).toBeInTheDocument();
    expect(five.getByText('+6')).toBeInTheDocument();
    // Below his average, away, and on the other side of the ball.
    const four = within(screen.getByTestId('recent-4'));
    expect(four.getByText('at CLE')).toBeInTheDocument();
    expect(four.getByText(/below his average/).parentElement).toHaveTextContent('▼ 3.8 below his average');
    // No delta for an average game, and no opponent when it is not known.
    const three = within(screen.getByTestId('recent-3'));
    expect(three.queryByText(/his average/)).toBeNull();
    expect(three.queryByText(/^(vs|at) /)).toBeNull();
    // The trend: 10.97 a game over the last three against 10 on the year is steady.
    expect(document.querySelector('[data-trend]')).toHaveAttribute('data-trend', 'steady');
  });

  it('calls a hot streak, and shows the bar of where the points came from', () => {
    render(<RecentGames recent={[game(5, 20), game(4, 18), game(3, 19)]} ppg={10} games={8} />);
    const chip = document.querySelector('[data-trend]')!;
    expect(chip).toHaveAttribute('data-trend', 'up');
    expect(chip).toHaveTextContent('Trending up · 19 a game vs 10 on the year');
    const bar = screen.getByTestId('recent-5').querySelector('[aria-hidden="true"].flex')!;
    // Three segments (yards, touchdown, catches), widths adding to the whole.
    const widths = [...bar.children].map((c) => parseFloat((c as HTMLElement).style.width));
    expect(widths).toHaveLength(3);
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });

  it('shows penalties in red, a lone game, and a game that scored nothing', () => {
    render(
      <RecentGames
        recent={[
          game(2, -1, {
            vsAverage: 0,
            breakdown: [{ stat: 'fum_lost', text: '1 fumble lost', points: -2 }]
          }),
          game(1, 0, { vsAverage: 0, breakdown: [] })
        ]}
        ppg={-0.5}
        games={2}
      />
    );
    expect(screen.getByRole('heading', { name: 'Last 2 games' })).toBeInTheDocument();
    expect(within(screen.getByTestId('recent-2')).getByText('−2')).toHaveClass('text-error-700');
    // No bar when nothing earned points.
    expect(screen.getByTestId('recent-2').querySelector('[aria-hidden="true"].flex')).toBeNull();
    expect(within(screen.getByTestId('recent-1')).getByText('Nothing that scored.')).toBeInTheDocument();
    // All of his games are shown: no trend chip.
    expect(document.querySelector('[data-trend]')).toBeNull();
  });

  it('says "Last game" for one, hides the delta on a first game, and renders nothing without games', () => {
    const { container, rerender } = render(<RecentGames recent={[game(1, 12.4)]} ppg={12.4} games={1} />);
    expect(screen.getByRole('heading', { name: 'Last game' })).toBeInTheDocument();
    expect(screen.queryByText(/his average/)).toBeNull();
    rerender(<RecentGames recent={[]} ppg={0} games={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});
