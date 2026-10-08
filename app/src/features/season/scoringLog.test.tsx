import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeagueApiContext } from '../../api/league';
import type { MatchupData, ScoringLogData, ScoringLogEntry } from '../../api/types';
import type { EventConnect, LeagueEvent } from '../../realtime/leagueEvents';
import { fakeApi } from '../../test/fakeApi';
import { MatchupPage, pushedLog } from './MatchupPage';
import { filterEntries, formatPoints, mergeEntries, playText } from './ScoringLog';

const MATCHUP_ID = 'W04-M1';

function logEntry(overrides: Partial<ScoringLogEntry> & { at: string; playerId: string }): ScoringLogEntry {
  const { at, playerId, ...rest } = overrides;
  return {
    id: `${at}#${playerId}`,
    at,
    kind: 'live',
    teamId: 'team-1',
    teamName: "Allen's Team",
    slot: 'WR',
    starter: true,
    player: { id: playerId, name: playerId.toUpperCase(), team: 'PHI', position: 'WR' },
    changes: [{ stat: 'rec_yd', delta: 12 }],
    summary: '+1 rec, +12 rec yds',
    points: 1.7,
    touchdown: false,
    ...rest
  };
}

const MINE = logEntry({ at: '2026-10-04T17:10:00.000Z', playerId: 'ajbrown' });
const THEIRS = logEntry({
  at: '2026-10-04T17:20:00.000Z',
  playerId: 'cmc',
  teamId: 'team-2',
  teamName: 'The Spreadsheet',
  player: { id: 'cmc', name: 'Christian McCaffrey', team: 'SF', position: 'RB' },
  summary: '+18 rush yds, +1 rush TD',
  points: 7.8,
  touchdown: true
});
const BENCH = logEntry({ at: '2026-10-04T17:05:00.000Z', playerId: 'bench', starter: false, slot: 'BN' });
const CORRECTION = logEntry({
  at: '2026-10-08T15:00:00.000Z',
  playerId: 'hurts',
  kind: 'correction',
  summary: '-2 pass yds',
  points: -0.08,
  player: { id: 'hurts', name: 'Jalen Hurts', team: 'PHI', position: 'QB' }
});

function matchup(): MatchupData {
  return {
    week: 4,
    teamId: 'team-1',
    matchup: {
      id: MATCHUP_ID,
      status: 'in_progress',
      home: { teamId: 'team-1', teamName: "Allen's Team", score: 20, manager: null },
      away: {
        teamId: 'team-2',
        teamName: 'The Spreadsheet',
        score: 18,
        manager: { name: 'Marcus Hale', avatarSeed: 'seed-1', personality: 'The Spreadsheet' }
      }
    },
    lineups: {
      home: { teamId: 'team-1', points: 20, players: [] },
      away: { teamId: 'team-2', points: 18, players: [] }
    }
  };
}

const page = (entries: ScoringLogEntry[], nextCursor: string | null = null): ScoringLogData => ({
  week: 4,
  teamId: 'team-1',
  matchupId: MATCHUP_ID,
  entries,
  nextCursor
});

function renderMatchup(
  getScoringLog: (id: string, query?: Record<string, unknown>) => Promise<ScoringLogData>
) {
  let push: (event: LeagueEvent) => void = () => undefined;
  const connect: EventConnect = async (_target, handlers) => {
    push = handlers.onEvent;
    return () => undefined;
  };
  const api = fakeApi({
    getMatchup: vi.fn(async () => matchup()),
    getNflGames: vi.fn(async () => ({
      season: 2026,
      week: 4,
      games: [],
      redZone: [{ team: 'PHI', downDistance: '2nd & 4 at DAL 7', fieldPosition: 'DAL 7' }],
      updatedAt: null
    })),
    getScoringLog: vi.fn(getScoringLog),
    getRealtime: vi.fn(async () => ({
      enabled: true,
      httpHost: 'api.example',
      realtimeHost: 'realtime.example',
      channels: { league: '/fantasy/league/L1', global: '/fantasy/global' },
      refreshAt: null,
      pollIntervalSeconds: 30
    }))
  });
  render(
    <LeagueApiContext.Provider value={api}>
      <MemoryRouter initialEntries={['/leagues/L1/matchup']}>
        <Routes>
          <Route path="/leagues/:leagueId/matchup" element={<MatchupPage connect={connect} />} />
        </Routes>
      </MemoryRouter>
    </LeagueApiContext.Provider>
  );
  return { api, push: (event: LeagueEvent) => act(() => push(event)) };
}

afterEach(() => vi.restoreAllMocks());

describe('scoring log helpers', () => {
  it('merges by id, newest first', () => {
    expect(mergeEntries([MINE, THEIRS], [THEIRS, CORRECTION]).map((e) => e.id)).toEqual([
      CORRECTION.id,
      THEIRS.id,
      MINE.id
    ]);
  });

  it('keeps the copy of an entry that has its play description (#164)', () => {
    const described = { ...THEIRS, play: { text: 'Christian McCaffrey 18 Yd Run (Jake Moody Kick)' } };
    expect(mergeEntries([{ ...THEIRS, play: null }], [described])).toEqual([described]);
    expect(mergeEntries([described], [{ ...THEIRS, play: null }])).toEqual([described]);
    expect(mergeEntries([THEIRS], [{ ...THEIRS, summary: 'later' }])).toEqual([THEIRS]);
    expect(playText(described)).toBe('Christian McCaffrey 18 Yd Run (Jake Moody Kick)');
    expect(playText({ ...THEIRS, play: { text: ' ' } })).toBeNull();
    expect(playText({ ...THEIRS, play: { text: 7 } as unknown as { text: string } })).toBeNull();
    expect(playText(THEIRS)).toBeNull();
  });

  it('filters by team and bench', () => {
    const all = [THEIRS, MINE, BENCH];
    expect(filterEntries(all, 'both', 'team-1', false)).toEqual([THEIRS, MINE]);
    expect(filterEntries(all, 'mine', 'team-1', true)).toEqual([MINE, BENCH]);
    expect(filterEntries(all, 'theirs', 'team-1', true)).toEqual([THEIRS]);
  });

  it('formats points with a sign', () => {
    expect([formatPoints(7.8), formatPoints(-0.2), formatPoints(0)]).toEqual(['+7.80', '-0.20', '0.00']);
  });

  it('reads pushed entries from a Scores Updated detail, dropping anything malformed', () => {
    expect(pushedLog({ detailType: 'Scores Updated', leagueId: 'L1' })).toEqual([]);
    expect(
      pushedLog({
        detailType: 'Scores Updated',
        leagueId: 'L1',
        detail: {
          scoringLog: [
            { matchupId: MATCHUP_ID, entries: [MINE, { id: 'x' }] },
            { matchupId: 'W04-M2', entries: [{ nope: true }] },
            { entries: [MINE] },
            null
          ]
        }
      })
    ).toEqual([{ matchupId: MATCHUP_ID, entries: [MINE] }]);
  });
});

describe('MatchupPage scoring log', () => {
  it('lists plays newest first with avatars, touchdowns, corrections, and red-zone highlights', async () => {
    renderMatchup(async () => page([CORRECTION, THEIRS, MINE]));
    const log = await screen.findByRole('list', { name: 'Scoring plays, newest first' });
    const rows = within(log).getAllByRole('listitem');
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      'log-entry-hurts',
      'log-entry-cmc',
      'log-entry-ajbrown'
    ]);

    expect(rows[0]).toHaveTextContent('Stat correction');
    expect(within(rows[0]!).getByTestId('log-points')).toHaveTextContent('-0.08');
    expect(within(rows[0]!).getByTestId('log-points')).toHaveClass('text-error-700');
    // Hurts's team is in the red zone now: his latest entry carries the highlight.
    expect(rows[0]).toHaveClass('red-zone-card');
    expect(within(rows[0]!).getByTestId('red-zone-chip')).toBeVisible();

    expect(rows[1]).toHaveClass('scoring-log-td');
    expect(rows[1]).toHaveAttribute('data-touchdown', 'true');
    expect(rows[1]).toHaveTextContent('Touchdown');
    expect(rows[1]).toHaveTextContent('+18 rush yds, +1 rush TD');
    expect(within(rows[1]!).getByRole('img', { name: 'Marcus Hale (The Spreadsheet)' })).toBeVisible();
    expect(within(rows[2]!).getByRole('img', { name: "Allen's Team" })).toHaveTextContent('A');
    // Nothing is new on the first load.
    expect(rows.some((r) => r.dataset.new)).toBe(false);
  });

  it("shows ESPN's play description under the stat summary, and nothing without one (#164)", async () => {
    const text = 'Christian McCaffrey 18 Yd Run (Jake Moody Kick)';
    renderMatchup(async () =>
      page([
        { ...THEIRS, play: { text } },
        { ...MINE, play: null }
      ])
    );
    const row = await screen.findByTestId('log-entry-cmc');
    const play = within(row).getByTestId('log-play');
    expect(play).toHaveTextContent(text);
    // Right under the summary line.
    expect(within(row).getByText('+18 rush yds, +1 rush TD').nextElementSibling).toBe(play);
    expect(within(screen.getByTestId('log-entry-ajbrown')).queryByTestId('log-play')).toBeNull();
  });

  it('filters mine and theirs, and asks for the bench', async () => {
    const { api } = renderMatchup(async (_id, query) =>
      page(query?.includeBench === true ? [THEIRS, MINE, BENCH] : [THEIRS, MINE])
    );
    await screen.findByTestId('log-entry-cmc');
    fireEvent.click(screen.getByRole('button', { name: 'Mine' }));
    expect(screen.queryByTestId('log-entry-cmc')).toBeNull();
    expect(screen.getByTestId('log-entry-ajbrown')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Theirs' }));
    expect(screen.getByTestId('log-entry-cmc')).toBeVisible();
    expect(screen.queryByTestId('log-entry-ajbrown')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Mine' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include bench' }));
    await screen.findByTestId('log-entry-bench');
    expect(screen.getByTestId('log-entry-bench')).toHaveTextContent('Bench');
    expect(api.getScoringLog).toHaveBeenCalledWith('L1', { includeBench: true, limit: 20 });
  });

  it('says so when there is nothing to show', async () => {
    renderMatchup(async () => page([THEIRS]));
    await screen.findByTestId('log-entry-cmc');
    fireEvent.click(screen.getByRole('button', { name: 'Mine' }));
    expect(screen.getByText("No scoring for Allen's Team yet.")).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Theirs' }));
    expect(screen.getByTestId('log-entry-cmc')).toBeVisible();
  });

  it('shows an empty log', async () => {
    renderMatchup(async () => page([]));
    expect(await screen.findByText(/No scoring yet/)).toBeVisible();
  });

  it('reports a failed load', async () => {
    renderMatchup(async () => {
      throw new Error('down');
    });
    expect(await screen.findByText(/The scoring log could not load/)).toBeVisible();
  });

  it('loads older plays a page at a time', async () => {
    const { api } = renderMatchup(async (_id, query) =>
      query?.cursor === 'c1' ? page([BENCH], null) : page([THEIRS], 'c1')
    );
    await screen.findByTestId('log-entry-cmc');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include bench' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show older plays' }));
    await screen.findByTestId('log-entry-bench');
    expect(api.getScoringLog).toHaveBeenLastCalledWith('L1', { includeBench: true, limit: 20, cursor: 'c1' });
    expect(screen.queryByRole('button', { name: 'Show older plays' })).toBeNull();
  });

  it('pops in a pushed entry live, and reloads when a push carries none', async () => {
    const { api, push } = renderMatchup(async () => page([MINE]));
    await screen.findByTestId('log-entry-ajbrown');
    await waitFor(() => expect(api.getRealtime).toHaveBeenCalled());
    const reads = vi.mocked(api.getScoringLog).mock.calls.length;
    push({
      detailType: 'Scores Updated',
      leagueId: 'L1',
      detail: { scoringLog: [{ matchupId: MATCHUP_ID, entries: [THEIRS] }] }
    });
    const pushed = await screen.findByTestId('log-entry-cmc');
    expect(pushed).toHaveAttribute('data-new', 'true');
    expect(pushed).toHaveClass('motion-pop');
    expect(screen.getByTestId('log-entry-ajbrown')).not.toHaveAttribute('data-new');
    expect(vi.mocked(api.getScoringLog).mock.calls.length).toBe(reads);

    push({ detailType: 'Stat Correction Applied', leagueId: 'L1' });
    await waitFor(() => expect(vi.mocked(api.getScoringLog).mock.calls.length).toBe(reads + 1));
  });

  it('highlights only a player’s latest entry, and shows a free agent as FA', async () => {
    const earlier = logEntry({
      at: '2026-10-04T16:50:00.000Z',
      playerId: 'hurts',
      player: CORRECTION.player
    });
    const fa = logEntry({
      at: '2026-10-04T16:40:00.000Z',
      playerId: 'fa',
      player: { id: 'fa', name: 'Free Agent', team: null, position: 'WR' }
    });
    renderMatchup(async () => page([CORRECTION, earlier, fa]));
    const rows = await screen.findAllByRole('listitem');
    expect(rows[0]).toHaveClass('red-zone-card');
    expect(rows[1]).not.toHaveClass('red-zone-card');
    expect(rows[2]).toHaveTextContent('WR · FA');
  });

  it('ignores a page for another matchup, and keeps the button after a failed older load', async () => {
    let calls = 0;
    const { api } = renderMatchup(async (_id, query) => {
      calls++;
      if (query?.cursor !== undefined) throw new Error('down');
      return calls === 1 ? { ...page([THEIRS]), matchupId: 'W03-M1' } : page([THEIRS], 'c1');
    });
    expect(await screen.findByText('Loading the scoring log…')).toBeVisible();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Include bench' }));
    const older = await screen.findByRole('button', { name: 'Show older plays' });
    fireEvent.click(older);
    await waitFor(() => expect(api.getScoringLog).toHaveBeenCalledTimes(3));
    expect(await screen.findByRole('button', { name: 'Show older plays' })).toBeEnabled();
  });
});
