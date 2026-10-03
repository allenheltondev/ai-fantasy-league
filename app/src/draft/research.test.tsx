import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiFetch } from '../api/client';
import { BestAvailableTable, type BestAvailableTableProps } from './BestAvailableTable';
import type { BestAvailableEntry } from './board';
import { DepthChart } from './DepthChart';
import { PlayerCard } from './PlayerCard';
import { fmt, type DraftDepth, type PlayerCardData } from './research';

const ref = (id: string, name: string, position: string, team: string | null = 'CIN') => ({
  id,
  name,
  team,
  position
});
const CHASE = ref('fx-chase', "Ja'Marr Chase", 'WR');
const CMC = ref('fx-cmc', 'Christian McCaffrey', 'RB', 'SF');

function fakeApi(handler: (path: string) => unknown) {
  const calls: string[] = [];
  const api = (async (path: string) => {
    calls.push(path);
    const data = handler(path);
    if (data instanceof Error) throw data;
    return { data, league: null, warnings: [] };
  }) as ApiFetch;
  return { api, calls };
}

describe('research helpers', () => {
  it('formats to one decimal', () => {
    expect([fmt(12.345), fmt(10), fmt(null), fmt(undefined)]).toEqual(['12.3', '10', '—', '—']);
  });
});

describe('BestAvailableTable', () => {
  const rows: BestAvailableEntry[] = [
    {
      player: CHASE,
      rank: 1,
      lastSeason: { points: 250.46, ppg: 15.7, games: 16 },
      projection: { points: 270 },
      bye: 10,
      injuryStatus: 'Questionable'
    },
    { player: CMC, rank: 3, lastSeason: null, projection: null, bye: null, injuryStatus: 'IR' }
  ];

  function renderTable(overrides: Partial<BestAvailableTableProps> = {}) {
    const props: BestAvailableTableProps = {
      rows,
      sort: 'rank',
      onSort: vi.fn(),
      position: '',
      onPosition: vi.fn(),
      q: '',
      onQuery: vi.fn(),
      isQueued: (id) => id === 'fx-cmc',
      onQueue: vi.fn(),
      canDraft: true,
      picking: null,
      onDraft: vi.fn(),
      onOpen: vi.fn(),
      ...overrides
    };
    render(<BestAvailableTable {...props} />);
    return props;
  }

  it('shows rank, last season, projection, bye, and injury, with a compact line for phones', () => {
    renderTable();
    const chase = screen.getByTestId('available-fx-chase');
    const cells = within(chase)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    // Rank, player, position, team, bye, projection, PPG, points, actions.
    expect([cells[0], ...cells.slice(2, 8)]).toEqual(['1', 'WR', 'CIN', '10', '270', '15.7', '250.5']);
    expect(within(chase).getByText('Q')).toHaveAttribute('title', 'Questionable');
    expect(within(chase).getByTestId('compact-stats')).toHaveTextContent(
      '#1 · CIN · bye 10 · proj 270 · 15.7 PPG'
    );
    const cmc = screen.getByTestId('available-fx-cmc');
    expect(within(cmc).getByText('IR')).toBeInTheDocument();
    expect(within(cmc).getByTestId('compact-stats')).toHaveTextContent('#3 · SF · proj — · — PPG');
    expect(within(cmc).getAllByRole('cell')[4]).toHaveTextContent('—');
    expect(within(cmc).getByRole('button', { name: 'Queue Christian McCaffrey' })).toHaveTextContent('✓');
  });

  it('sorts by header, filters by position chip, and marks the active sort', async () => {
    const user = userEvent.setup();
    const props = renderTable({ sort: 'projection', position: 'WR' });
    expect(screen.getByRole('columnheader', { name: /Proj/ })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('columnheader', { name: /Pts/ })).not.toHaveAttribute('aria-sort');
    await user.click(screen.getByRole('button', { name: 'Sort by last season fantasy points' }));
    expect(props.onSort).toHaveBeenCalledWith('lastSeasonPoints');
    await user.click(screen.getByRole('button', { name: 'Sort by consensus rank' }));
    expect(props.onSort).toHaveBeenCalledWith('rank');
    const chips = within(screen.getByRole('group', { name: 'Position' }));
    expect(chips.getByRole('button', { name: 'WR' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(chips.getByRole('button', { name: 'All' }));
    expect(props.onPosition).toHaveBeenCalledWith('');
    await user.type(screen.getByLabelText('Search players'), 'x');
    expect(props.onQuery).toHaveBeenCalledWith('x');
  });

  it('opens the card, queues, and drafts', async () => {
    const user = userEvent.setup();
    const props = renderTable();
    await user.click(screen.getByRole('button', { name: "Ja'Marr Chase" }));
    expect(props.onOpen).toHaveBeenCalledWith(CHASE);
    await user.click(screen.getByRole('button', { name: "Queue Ja'Marr Chase" }));
    expect(props.onQueue).toHaveBeenCalledWith(CHASE);
    expect(screen.getByRole('button', { name: 'Queue Christian McCaffrey' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: "Draft Ja'Marr Chase" }));
    expect(props.onDraft).toHaveBeenCalledWith(CHASE);
  });

  it('shows the rank sort as ascending and disables picks off the clock', () => {
    renderTable({ canDraft: false });
    expect(screen.getByRole('columnheader', { name: /Rk/ })).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByRole('button', { name: "Draft Ja'Marr Chase" })).toBeDisabled();
  });

  it('flags players likely gone before your pick, and counts the top 100 on the position chips', () => {
    renderTable({
      likelyGone: new Set(['fx-chase']),
      scarcity: [
        { position: 'WR', left: 12, likelyGone: 2 },
        { position: 'TE', left: 5, likelyGone: 0 }
      ]
    });
    expect(within(screen.getByTestId('available-fx-chase')).getByText('likely gone')).toBeInTheDocument();
    expect(within(screen.getByTestId('available-fx-cmc')).queryByText('likely gone')).toBeNull();
    const chips = within(screen.getByRole('group', { name: 'Position' }));
    expect(chips.getByRole('button', { name: 'WR' })).toHaveTextContent('WR12');
    expect(chips.getByRole('button', { name: 'WR' })).toHaveAttribute(
      'title',
      '12 WR among the 100 best remaining players (unranked positions count the full pool), 2 likely gone before your pick'
    );
    expect(chips.getByRole('button', { name: 'TE' })).toHaveAttribute(
      'title',
      '5 TE among the 100 best remaining players (unranked positions count the full pool)'
    );
    expect(chips.getByRole('button', { name: 'K' })).not.toHaveAttribute('title');
  });

  it('offers both compact and desktop comparison actions when used without a pinned selection', async () => {
    const user = userEvent.setup();
    const onCompare = vi.fn();
    renderTable({ onCompare });
    for (const button of screen.getAllByRole('button', { name: "Compare Ja'Marr Chase" }))
      await user.click(button);
    expect(onCompare).toHaveBeenCalledTimes(2);
    expect(onCompare).toHaveBeenCalledWith(CHASE);
  });

  it('sorts from the phone menu, and says when nothing matches', async () => {
    const user = userEvent.setup();
    const props = renderTable({ rows: [] });
    await user.selectOptions(screen.getByLabelText('Sort by'), 'ppg');
    expect(props.onSort).toHaveBeenCalledWith('ppg');
    expect(screen.getByText('No available players match.')).toBeInTheDocument();
  });
});

const CARD: PlayerCardData = {
  player: { ...CHASE, rank: 1 },
  scoring: { source: 'league' },
  bye: 10,
  injuryStatus: 'Doubtful',
  lastSeason: {
    season: 2025,
    points: 40,
    ppg: 20,
    games: 2,
    weekly: [
      { week: 1, points: 25 },
      { week: 3, points: 15 }
    ],
    totals: { rec_tgt: 20, rec: 14, rec_yd: 250, rec_td: 1, custom_key: 2 }
  },
  projection: { season: 2026, points: 280.5, totals: { rec: 100, rec_yd: 1300 } },
  news: [
    {
      id: 'n1',
      title: 'Chase practices in full',
      url: 'https://example.com/1',
      source: 'ESPN',
      publishedAt: '2026-09-01T12:00:00.000Z'
    }
  ]
};

describe('PlayerCard', () => {
  function renderCard(data: unknown, overrides: Partial<Parameters<typeof PlayerCard>[0]> = {}) {
    const { api, calls } = fakeApi(() => data);
    const props = {
      api,
      leagueId: 'L1',
      player: CHASE,
      onClose: vi.fn(),
      queued: false,
      onQueue: vi.fn(),
      canDraft: true,
      picking: false,
      onDraft: vi.fn(),
      ...overrides
    };
    render(<PlayerCard {...props} />);
    return { props, calls };
  }

  it('shows the weekly points chart, totals, projection, bye, injury, and news', async () => {
    const { calls } = renderCard(CARD);
    const card = await screen.findByTestId('player-card');
    expect(await within(card).findByText(/PPG/)).toHaveTextContent('40 pts · 20 PPG · 2 games');
    expect(within(card).getByRole('img', { name: /Weekly points last season/ })).toHaveAttribute(
      'aria-label',
      'Weekly points last season: week 1 25, week 3 15'
    );
    expect(within(card).getByText('D')).toHaveAttribute('title', 'Doubtful');
    expect(card).toHaveTextContent('bye 10');
    const totals = within(card.querySelector<HTMLElement>('dl[aria-label="Last season totals"]')!);
    expect(totals.getByText('Targets').nextSibling).toHaveTextContent('20');
    expect(totals.getByText('custom_key')).toBeInTheDocument();
    expect(card).toHaveTextContent('280.5 projected pts (2026)');
    expect(within(card).getByRole('link', { name: 'Chase practices in full' })).toHaveAttribute(
      'href',
      'https://example.com/1'
    );
    expect(card).toHaveTextContent('ESPN · 2026-09-01');
    expect(calls).toEqual(['/players/card']);
  });

  it('shows his age and experience, ESPN’s injury note, and how next week’s defense fares against his position', async () => {
    renderCard({
      ...CARD,
      bio: { age: 26, yearsExp: 5, number: 1 },
      injuryNote: { text: 'Chase (hip) is doubtful for Sunday.', reportedAt: '2026-10-02T20:00Z' },
      nextWeek: {
        season: 2026,
        week: 4,
        points: 11,
        totals: {},
        bye: false,
        opponent: { team: 'BAL', home: true },
        kickoff: null,
        matchup: { position: 'WR', perGame: 35.24, rank: 2, of: 32, games: 3, throughWeek: 3 }
      }
    });
    const card = await screen.findByTestId('player-card');
    expect(await within(card).findByTestId('card-bio')).toHaveTextContent('#1 · Age 26 · 6th season');
    expect(within(card).getByTestId('card-injury-note')).toHaveTextContent(
      'Chase (hip) is doubtful for Sunday. ESPN · Oct 2'
    );
    expect(within(card).getByTestId('card-matchup')).toHaveTextContent(
      'Favorable matchupBAL allows 35.2 PPR pts a game to WRs, 2nd most of 32 (through week 3)'
    );
  });

  it('calls a rookie a rookie, leaves out what is unknown, and rates a tough matchup', async () => {
    renderCard({
      ...CARD,
      bio: { age: null, yearsExp: 0, number: null },
      injuryNote: null,
      nextWeek: {
        season: 2026,
        week: 4,
        points: 11,
        totals: {},
        bye: false,
        opponent: { team: 'DEN', home: false },
        kickoff: null,
        matchup: { position: 'DEF', perGame: 1, rank: 30, of: 32, games: 3, throughWeek: 3 }
      }
    });
    const card = await screen.findByTestId('player-card');
    expect(await within(card).findByTestId('card-bio')).toHaveTextContent(/^Rookie$/);
    expect(within(card).queryByTestId('card-injury-note')).toBeNull();
    expect(within(card).getByTestId('card-matchup')).toHaveTextContent(
      'Tough matchupDEN allows 1 PPR pts a game to team defenses, 30th most of 32'
    );
  });

  it('queues and drafts from the card', async () => {
    const user = userEvent.setup();
    const { props } = renderCard(CARD);
    const card = await screen.findByTestId('player-card');
    await user.click(within(card).getByRole('button', { name: 'Queue' }));
    expect(props.onQueue).toHaveBeenCalledWith(CHASE);
    await user.click(within(card).getByRole('button', { name: 'Draft' }));
    expect(props.onDraft).toHaveBeenCalledWith(CHASE);
  });

  it('says what is missing for a rookie, off the clock, already queued, with default scoring', async () => {
    renderCard(
      {
        ...CARD,
        scoring: { source: 'default' },
        bye: null,
        injuryStatus: null,
        lastSeason: null,
        projection: null,
        news: []
      },
      { canDraft: false, queued: true }
    );
    const card = await screen.findByTestId('player-card');
    expect(await within(card).findByText('No stats last season.')).toBeInTheDocument();
    expect(card).toHaveTextContent('No projection yet.');
    expect(card).toHaveTextContent('No recent news.');
    expect(card).toHaveTextContent('bye —');
    expect(card).toHaveTextContent('Points use default half-PPR scoring.');
    expect(within(card).getByRole('button', { name: 'Queued' })).toBeDisabled();
    expect(within(card).queryByRole('button', { name: 'Draft' })).toBeNull();
  });

  it('shows loading, then the error when the card cannot load', async () => {
    renderCard(new ApiError(404, { code: 'PLAYER_NOT_FOUND', message: 'No such player.' }));
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('No such player.');
  });

  it('reports a network failure', async () => {
    renderCard(new TypeError('offline'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server.');
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const { props } = renderCard(CARD);
    await screen.findByTestId('player-card');
    await user.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalled();
  });
});

const DEPTH: DraftDepth = {
  yourTeamId: 'team-1',
  teams: [
    {
      teamId: 'team-1',
      teamName: "Allen's Team",
      yours: true,
      picksBeforeYou: 0,
      positions: [
        { position: 'QB', players: [] },
        { position: 'RB', players: [CMC] }
      ],
      slots: [
        { slot: 'QB', required: 1, filled: 0 },
        { slot: 'RB', required: 2, filled: 1 },
        { slot: 'W/R/T', required: 1, filled: 0 }
      ],
      gaps: ['QB', 'RB', 'W/R/T']
    },
    {
      teamId: 'team-2',
      teamName: 'The Spreadsheet',
      yours: false,
      picksBeforeYou: 2,
      positions: [{ position: 'WR', players: [CHASE] }],
      slots: [{ slot: 'WR', required: 1, filled: 1 }],
      gaps: []
    },
    {
      teamId: 'team-3',
      teamName: 'Robo',
      yours: false,
      picksBeforeYou: 1,
      positions: [],
      slots: [],
      gaps: []
    }
  ]
};

describe('DepthChart', () => {
  it('shows teams by position with slot fill and gaps, your team first, and who picks before you', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const { api, calls } = fakeApi(() => DEPTH);
    render(<DepthChart api={api} leagueId="L1" version={3} onOpen={onOpen} />);
    expect(screen.getByText('Loading depth…')).toBeInTheDocument();
    const rows = within(await screen.findByRole('table', { name: 'Depth chart' })).getAllByRole('row');
    expect(rows[1]).toHaveTextContent("Allen's TeamYou");
    expect(screen.getByTestId('depth-team-1-RB')).toHaveTextContent('RB 1/2Christian McCaffrey');
    expect(screen.getByTestId('depth-team-1-RB')).toHaveAttribute('data-gap', 'true');
    expect(screen.getByTestId('depth-team-1-QB')).toHaveTextContent('QB 0/1');
    expect(screen.getByTestId('depth-team-2-WR')).not.toHaveAttribute('data-gap');
    expect(screen.getByTestId('depth-team-2-K')).toHaveTextContent('');
    expect(screen.getByTestId('depth-team-1')).toHaveTextContent('W/R/T 0/1');
    expect(screen.getByTestId('depth-team-1')).toHaveTextContent('Needs: QB, RB, W/R/T');
    expect(screen.getByTestId('depth-team-2')).toHaveTextContent('2 picks before you');
    expect(screen.getByTestId('depth-team-2')).toHaveClass('font-semibold');
    expect(screen.getByTestId('depth-team-3')).toHaveTextContent('1 pick before you');
    await user.click(screen.getByRole('button', { name: "Ja'Marr Chase" }));
    expect(onOpen).toHaveBeenCalledWith(CHASE);
    expect(calls).toEqual(['/leagues/L1/draft/depth']);
  });

  it('shows why the depth chart cannot load', async () => {
    const { api } = fakeApi(() => new ApiError(409, { code: 'DRAFT_NOT_STARTED', message: 'Not yet.' }));
    render(<DepthChart api={api} leagueId="L1" version={0} onOpen={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Not yet.');
  });

  it('reports a network failure', async () => {
    const { api } = fakeApi(() => new TypeError('offline'));
    render(<DepthChart api={api} leagueId="L1" version={0} onOpen={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server.');
  });
});
