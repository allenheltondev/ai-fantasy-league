import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WeeklyPoints } from './WeeklyPoints';

const chart = () => screen.getByTestId('weekly-points');
const bar = (week: number) => chart().querySelector<HTMLElement>(`[data-week="${week}"]`)!;

describe('WeeklyPoints', () => {
  it('draws a bar per week, labeled, with the average and a name for screen readers', () => {
    render(
      <WeeklyPoints
        weekly={[
          { week: 1, points: 20 },
          { week: 2, points: 5 },
          { week: 3, points: 11 }
        ]}
        average={12}
        which="this season"
      />
    );
    expect(chart()).toHaveAttribute(
      'aria-label',
      'Weekly points this season: week 1 20, week 2 5, week 3 11'
    );
    // Every week is on the axis, and each bar says its points (a short season labels them all).
    expect(within(bar(1)).getByText('20')).toBeInTheDocument();
    expect(within(bar(2)).getByText('5')).toBeInTheDocument();
    expect(bar(1)).toHaveAttribute('title', 'Week 1: 20 pts');
    // Above his average is bold, below it faded.
    expect(bar(1).querySelector('[data-bar]')).toHaveAttribute('data-bar', 'above');
    expect(bar(2).querySelector('[data-bar]')).toHaveAttribute('data-bar', 'below');
    // The best week is the boldest label; the average has a line and a legend.
    expect(within(bar(1)).getByText('20')).toHaveClass('font-bold');
    expect(screen.getByTestId('weekly-average')).toBeInTheDocument();
    expect(screen.getByText('Points by week')).toBeInTheDocument();
    expect(screen.getByText('average 12')).toBeInTheDocument();
    expect(screen.queryByText('projected')).toBeNull();
  });

  it('leaves a gap for a week he did not play, and shows the projection as an outline', () => {
    render(
      <WeeklyPoints
        weekly={[
          { week: 1, points: 8 },
          { week: 3, points: 14 }
        ]}
        average={11}
        projected={{ week: 4, points: 9.5 }}
        which="this season"
      />
    );
    expect(bar(2)).toHaveAttribute('title', 'Week 2: did not play');
    expect(bar(2).querySelector('[data-bar]')).toBeNull();
    expect(bar(4)).toHaveAttribute('title', 'Week 4: 9.5 pts (projected)');
    expect(bar(4).querySelector('[data-bar]')).toHaveAttribute('data-bar', 'projected');
    expect(within(bar(4)).getByText('9.5')).toBeInTheDocument();
    expect(chart().getAttribute('aria-label')).toContain('; week 4 projected 9.5');
    expect(screen.getByText('projected')).toBeInTheDocument();
  });

  it('labels only the best week when the season is long', () => {
    const weekly = Array.from({ length: 17 }, (_, i) => ({ week: i + 1, points: i === 8 ? 30 : 10 }));
    render(<WeeklyPoints weekly={weekly} average={11} />);
    expect(
      within(chart())
        .getAllByText(/^\d+(\.\d)?$/)
        .filter((n) => n.closest('[data-bar]'))
    ).toHaveLength(1);
    expect(within(bar(9)).getByText('30')).toBeInTheDocument();
  });

  it('shows a negative week as a sliver in the error color, and never a bar taller than the chart', () => {
    render(
      <WeeklyPoints
        weekly={[
          { week: 1, points: -2 },
          { week: 2, points: 6 }
        ]}
        average={2}
      />
    );
    const negative = bar(1).querySelector<HTMLElement>('[data-bar]')!;
    expect(negative).toHaveClass('bg-error-500');
    expect(negative.style.height).toBe('2px');
    // The tallest is the chart's full height.
    expect(bar(2).querySelector<HTMLElement>('[data-bar]')!.style.height).toBe('100%');
  });

  it('handles a lone week, and an average above every bar', () => {
    render(<WeeklyPoints weekly={[{ week: 5, points: 3 }]} average={9} />);
    expect(bar(5).querySelector('[data-bar]')).toHaveAttribute('data-bar', 'below');
    expect(screen.getByTestId('weekly-average')).toHaveStyle({ bottom: '100%' });
  });
});
