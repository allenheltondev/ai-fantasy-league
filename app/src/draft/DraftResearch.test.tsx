import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiFetch } from '../api';
import { DraftResearch } from './DraftResearch';
import type { PlayerCardData } from './research';

const player = { id: 'p1', name: 'Test Receiver', position: 'WR', team: 'CIN' };
const card: PlayerCardData = {
  player: { ...player, rank: 12 },
  scoring: { source: 'league' },
  bye: 9,
  injuryStatus: null,
  projection: { season: 2026, points: 210, totals: { rec_tgt: 120 } },
  lastSeason: {
    season: 2025,
    points: 200,
    ppg: 12.5,
    games: 16,
    weekly: [{ week: 1, points: 20 }],
    totals: { rec: 80 }
  },
  thisSeason: {
    season: 2026,
    points: 30,
    ppg: 15,
    games: 2,
    weekly: [
      { week: 1, points: 15 },
      { week: 2, points: 15 }
    ],
    totals: { rec: 12 }
  },
  nextWeek: {
    season: 2026,
    week: 3,
    points: 16,
    totals: {},
    bye: false,
    opponent: { team: 'BAL', home: true },
    kickoff: null
  },
  news: [
    {
      id: 'news',
      title: 'Practice report',
      source: 'Team report',
      publishedAt: '2026-09-20',
      url: 'https://example.com/news'
    }
  ]
};
const props = (api: ApiFetch) => ({
  api,
  leagueId: 'L1',
  players: [player],
  drafted: new Set<string>(),
  isQueued: () => false,
  queueReady: true,
  canDraft: true,
  picking: null,
  onQueue: vi.fn(),
  onDraft: vi.fn(),
  onRemove: vi.fn(),
  onShare: vi.fn()
});
const response = (data: PlayerCardData) => ({ data, league: null, warnings: [] });
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('draft research decisions', () => {
  it('keeps notes and context after a player is taken, and shares only the selected player references', async () => {
    const user = userEvent.setup();
    const api = vi.fn(async () => response(card)) as unknown as ApiFetch;
    const p = props(api);
    const view = render(<DraftResearch {...p} />);
    expect(await screen.findByText('210 pts')).toBeInTheDocument();
    await user.click(screen.getByText('Weekly production & stat detail'));
    expect(screen.getByText('vs BAL · 16 projected pts')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Practice report' })).toHaveAttribute(
      'href',
      'https://example.com/news'
    );
    await user.click(screen.getByText('Private notes'));
    await user.type(screen.getByLabelText('Notes for Test Receiver'), 'My private sleeper');
    await user.click(screen.getByRole('button', { name: 'Discuss in chat →' }));
    expect(p.onShare).toHaveBeenCalledWith([player]);
    expect(p.onDraft).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '＋ Queue' }));
    expect(p.onQueue).toHaveBeenCalledWith(player);
    view.rerender(<DraftResearch {...p} drafted={new Set(['p1'])} />);
    expect(screen.getByRole('status')).toHaveTextContent('Drafted');
    expect(screen.queryByRole('button', { name: 'Draft Test Receiver' })).toBeNull();
    expect(screen.getByLabelText('Notes for Test Receiver')).toHaveValue('My private sleeper');
    expect(api).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Remove Test Receiver from research' }));
    expect(p.onRemove).toHaveBeenCalledWith('p1');
    view.unmount();
    render(<DraftResearch {...p} />);
    expect(screen.getByLabelText('Notes for Test Receiver')).toHaveValue('My private sleeper');
  });

  it('retries failed research without blocking the pick, and distinguishes missing data from zero', async () => {
    const user = userEvent.setup();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(
        response({
          ...card,
          player: { ...player, rank: null },
          scoring: { source: 'default' },
          injuryStatus: 'IR',
          bye: null,
          projection: null,
          lastSeason: null,
          thisSeason: null,
          nextWeek: null,
          news: []
        })
      );
    const p = props(fetch as ApiFetch);
    render(<DraftResearch {...p} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Research could not load');
    await user.click(screen.getByRole('button', { name: 'Draft Test Receiver' }));
    expect(p.onDraft).toHaveBeenCalledWith(player);
    await user.click(screen.getByRole('button', { name: 'Retry research' }));
    expect(await screen.findByText('Unranked')).toBeInTheDocument();
    expect(screen.getAllByText('Not available')).toHaveLength(3);
    expect(screen.getByText(/Points use default half-PPR/)).toBeInTheDocument();
    await user.click(screen.getByText('Weekly production & stat detail'));
    expect(screen.getByText('No production data available yet.')).toBeInTheDocument();
  });

  it('ignores a late response for a removed player and allows private notes when storage is blocked', async () => {
    let complete!: (value: ReturnType<typeof response>) => void;
    const api = (() =>
      new Promise<ReturnType<typeof response>>((resolve) => {
        complete = resolve;
      })) as unknown as ApiFetch;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const p = props(api);
    const view = render(<DraftResearch {...p} canDraft={false} queueReady={false} />);
    expect(screen.getByRole('button', { name: 'Draft Test Receiver' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '＋ Queue' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Notes for Test Receiver'), {
      target: { value: 'Temporary note' }
    });
    expect(screen.getByText(/Device storage is unavailable/)).toBeInTheDocument();
    view.rerender(<DraftResearch {...p} players={[]} />);
    await act(async () => complete(response(card)));
    expect(screen.queryByText('210 pts')).toBeNull();
    expect(screen.getByText('Find your next difference-maker.')).toBeInTheDocument();
  });

  it.each([
    { ...card.nextWeek!, bye: true },
    { ...card.nextWeek!, points: null, opponent: null },
    { ...card.nextWeek!, opponent: { team: 'BAL', home: false } }
  ])('shows the weekly context without inventing a matchup or projection: %j', async (nextWeek) => {
    const api = (async () => response({ ...card, nextWeek })) as ApiFetch;
    render(<DraftResearch {...props(api)} picking="p1" isQueued={() => true} onShare={undefined} />);
    await screen.findByText('210 pts');
    fireEvent.click(screen.getByText('Weekly production & stat detail'));
    const article = within(screen.getByRole('article'));
    expect(
      article.getByText(
        nextWeek.bye
          ? 'On bye'
          : nextWeek.opponent === null
            ? 'Matchup unavailable · No weekly projection'
            : 'at BAL · 16 projected pts'
      )
    ).toBeInTheDocument();
    expect(article.getByRole('button', { name: 'Queued ✓' })).toBeDisabled();
  });
});

it('does not surface a late network error after a candidate is removed', async () => {
  let reject!: (reason: Error) => void;
  const api = (() =>
    new Promise<unknown>((_resolve, fail) => {
      reject = fail;
    })) as unknown as ApiFetch;
  const p = props(api);
  const view = render(<DraftResearch {...p} />);
  view.rerender(<DraftResearch {...p} players={[]} />);
  await act(async () => reject(new Error('late network failure')));
  expect(screen.queryByRole('alert')).toBeNull();
});
