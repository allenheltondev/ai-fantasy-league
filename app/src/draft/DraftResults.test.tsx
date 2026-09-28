import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError, type ApiFetch } from '../api';
import { DraftResults, ordinal, type DraftReportCard, type ReportTeam } from './DraftResults';

function team(overrides: Partial<ReportTeam>): ReportTeam {
  return {
    teamId: 'team-x',
    teamName: 'Team X',
    yours: false,
    grade: 'B',
    headline: 'Fine.',
    strengths: ['Depth at receiver.'],
    weaknesses: ['No tight end.'],
    analysis: 'A steady draft.',
    projectedWins: 7,
    projectedLosses: 7,
    projectedRank: 2,
    projectedPoints: 1600.4,
    expectedWins: 7.1,
    ...overrides
  };
}

const READY: DraftReportCard = {
  status: 'ready',
  source: 'model',
  summary: 'The Spreadsheet ran away with it.',
  generatedAt: '2026-09-30T13:00:00.000Z',
  teams: [
    team({
      teamId: 'team-2',
      teamName: 'The Spreadsheet',
      grade: 'A+',
      headline: 'Receivers for days.',
      strengths: ["Ja'Marr Chase at 2 is a cheat code."],
      weaknesses: ['Punted kicker to the last round.'],
      projectedWins: 10,
      projectedLosses: 4,
      projectedRank: 1
    }),
    team({
      teamId: 'team-1',
      teamName: "Allen's Team",
      yours: true,
      grade: 'C-',
      headline: 'Brave choices.',
      projectedWins: 7,
      projectedLosses: 7,
      projectedRank: 2
    }),
    team({
      teamId: 'team-3',
      teamName: 'Robo',
      grade: 'F-',
      projectedWins: 4,
      projectedLosses: 10,
      projectedRank: 3
    })
  ]
};
const GRADING: DraftReportCard = {
  status: 'grading',
  source: null,
  summary: null,
  generatedAt: null,
  teams: []
};

/** Answers each report-card read with the next response (the last one repeats). */
function sequence(responses: (DraftReportCard | Error)[]) {
  let calls = 0;
  const api = (async (path: string) => {
    expect(path).toBe('/leagues/L1/draft/report-card');
    const next = responses[Math.min(calls, responses.length - 1)]!;
    calls++;
    if (next instanceof Error) throw next;
    return { data: next, league: null, warnings: [] };
  }) as ApiFetch;
  return { api, calls: () => calls };
}

describe('DraftResults', () => {
  it('says the card is being graded, checks back, then shows every team', async () => {
    const user = userEvent.setup();
    const { api, calls } = sequence([GRADING, GRADING, READY]);
    render(<DraftResults api={api} leagueId="L1" pollMs={5} />);
    expect(await screen.findByTestId('draft-results-grading')).toHaveTextContent(/grading every team/);
    expect(await screen.findByTestId('draft-results')).toBeInTheDocument();
    expect(calls()).toBe(3);
    expect(screen.getByText('The Spreadsheet ran away with it.')).toBeInTheDocument();
    expect(screen.getByText(/Graded by the AI analyst/)).toBeInTheDocument();

    // Your team's card comes first, open.
    const cards = screen.getAllByTestId(/^report-team-/);
    expect(cards.map((c) => c.dataset.testid)).toEqual(['report-team-1', 'report-team-2', 'report-team-3']);
    const yours = screen.getByTestId('report-team-1');
    expect(yours).toHaveAttribute('open');
    expect(yours).toHaveTextContent("Allen's TeamYour team");
    expect(yours).toHaveTextContent('Projected 7-7, 2nd place');
    expect(within(yours).getByLabelText('Grade C-')).toBeInTheDocument();

    // The standings table, in projected order.
    const rows = within(screen.getByRole('table', { name: 'Projected standings' })).getAllByRole('row');
    expect(rows.slice(1).map((r) => r.textContent)).toEqual([
      '1The Spreadsheet10-4A+1,600',
      "2Allen's Team7-7C-1,600",
      '3Robo4-10F-1,600'
    ]);

    // Other teams open to show what went well and what didn't.
    const spreadsheet = screen.getByTestId('report-team-2');
    expect(spreadsheet).not.toHaveAttribute('open');
    await user.click(within(spreadsheet).getByText('Receivers for days.'));
    expect(spreadsheet).toHaveAttribute('open');
    expect(within(spreadsheet).getByRole('region', { name: 'What went well' })).toHaveTextContent(
      "Ja'Marr Chase at 2 is a cheat code."
    );
    expect(within(spreadsheet).getByRole('region', { name: "What didn't" })).toHaveTextContent(
      'Punted kicker to the last round.'
    );
  });

  it('says when grades came from projections alone', async () => {
    const { api } = sequence([{ ...READY, source: 'computed', summary: null }]);
    render(<DraftResults api={api} leagueId="L1" />);
    expect(await screen.findByText(/Graded from projections alone/)).toBeInTheDocument();
  });

  it('keeps waiting patiently when grading is slow', async () => {
    const { api } = sequence([GRADING]);
    render(<DraftResults api={api} leagueId="L1" pollMs={1} />);
    expect(await screen.findByText(/taking longer than usual/, {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('shows why it could not load', async () => {
    const { api } = sequence([new ApiError(500, { code: 'INTERNAL', message: 'Server trouble.' })]);
    render(<DraftResults api={api} leagueId="L1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Server trouble.');
    const offline = sequence([new Error('offline')]);
    render(<DraftResults api={offline.api} leagueId="L1" />);
    expect(await screen.findByText('Could not reach the server.')).toBeInTheDocument();
  });
});

describe('ordinal', () => {
  it('suffixes places', () => {
    expect([1, 2, 3, 4, 10, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '10th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '101st',
      '111th'
    ]);
  });
});
