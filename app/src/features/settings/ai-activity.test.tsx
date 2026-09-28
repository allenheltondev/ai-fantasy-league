import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeagueApi } from '../../api/league';
import type { AgentActivity, AgentTaskRecord } from '../../api/types';
import { catalog, fakeApi, league, state, team } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';

beforeEach(() => signInAs({ sub: 'alice', given_name: 'Alice' }));

function task(overrides: Partial<AgentTaskRecord> = {}): AgentTaskRecord {
  return {
    taskId: 't1',
    teamId: 'team-4',
    agentId: 'L1.team-4',
    kind: 'lineup',
    week: 3,
    trigger: { detailType: 'Lineup Lock Approaching', eventId: 'e1' },
    status: 'completed',
    fallbackReason: null,
    toolsCalled: [
      { name: 'get_roster', mutation: false, ok: true, errorCode: null },
      { name: 'set_lineup', mutation: true, ok: true, errorCode: null }
    ],
    finalAction: 'set_lineup',
    reasoningSummary: 'Benched the questionable QB. Arr.',
    latencyMs: 1500,
    usage: [],
    costUsd: 0.004,
    startedAt: '2026-09-20T15:00:00.000Z',
    finishedAt: '2026-09-20T15:00:01.500Z',
    ...overrides
  };
}

function activity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    tasks: [
      task(),
      task({
        taskId: 't2',
        status: 'fallback',
        fallbackReason: 'budget_exceeded',
        kind: 'waivers',
        reasoningSummary: 'No waiver claims without a model decision.',
        toolsCalled: [],
        costUsd: 0
      })
    ],
    budget: {
      week: 3,
      ceilingUsd: 1,
      spentUsd: 1.2,
      remainingUsd: 0,
      exceeded: true,
      byAgent: [
        {
          agentId: 'L1.team-4',
          teamId: 'team-4',
          allowanceUsd: 0.5,
          costUsd: 1.2,
          inputTokens: 1,
          outputTokens: 1,
          tasks: 7
        }
      ],
      byModel: []
    },
    killSwitch: { configured: true, engaged: true },
    ...overrides
  };
}

async function openAi(api: LeagueApi) {
  const user = userEvent.setup();
  renderApp('/leagues/L1/settings', undefined, api);
  await screen.findByTestId('league-section-settings');
  await user.click(screen.getByRole('button', { name: 'AI activity' }));
  await screen.findByTestId('ai-activity');
  return user;
}

describe('settings: AI activity', () => {
  it('shows the kill switch, spend against budget, and the decision log with reasoning', async () => {
    const api = fakeApi({ getAgentActivity: vi.fn(async () => activity()) });
    await openAi(api);
    const panel = screen.getByTestId('ai-activity');
    expect(within(panel).getByText('Agents paused')).toBeInTheDocument();
    expect(within(panel).getByText('$1.20 of $1.00')).toBeInTheDocument();
    expect(within(panel).getByText('Over budget')).toBeInTheDocument();
    expect(within(panel).getByText(/reached its weekly model budget/)).toBeInTheDocument();
    const spend = within(panel).getByRole('table', { name: 'Spend by agent' });
    expect(within(spend).getAllByRole('row')[1]).toHaveTextContent('$1.20$0.507');
    const log = within(panel).getByRole('list', { name: 'Agent decisions' });
    expect(log).toHaveTextContent('Benched the questionable QB. Arr.');
    expect(log).toHaveTextContent('get_roster, set_lineup');
    expect(log).toHaveTextContent('Model decided');
    expect(log).toHaveTextContent('(budget exceeded)');
    expect(api.getAgentActivity).toHaveBeenCalledWith('L1', { limit: 50 });
  });

  it('filters the log by team and handles an empty log with the kill switch off', async () => {
    const api = fakeApi({
      getAgentActivity: vi.fn(async () =>
        activity({ tasks: [], killSwitch: { configured: false, engaged: false } })
      )
    });
    const user = await openAi(api);
    expect(screen.getByText('Not set up')).toBeInTheDocument();
    expect(screen.getByText('No agent activity yet')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Filter by team'), 'team-4');
    await waitFor(() =>
      expect(api.getAgentActivity).toHaveBeenLastCalledWith('L1', { limit: 50, teamId: 'team-4' })
    );
    await user.click(screen.getByRole('button', { name: 'League settings' }));
    expect(await screen.findByRole('heading', { name: 'Seats' })).toBeInTheDocument();
  });

  it('shows a healthy week, unknown kinds, removed seats, and load errors', async () => {
    const api = fakeApi({
      getAgentActivity: vi
        .fn()
        .mockResolvedValueOnce(
          activity({
            tasks: [task({ kind: 'mystery', teamId: 'team-9', status: 'skipped', toolsCalled: [] })],
            budget: {
              ...activity().budget,
              spentUsd: 0.1,
              remainingUsd: 0.9,
              exceeded: false,
              byAgent: [
                {
                  agentId: 'L1.gone',
                  teamId: null,
                  allowanceUsd: null,
                  costUsd: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                  tasks: 0
                }
              ]
            },
            killSwitch: { configured: true, engaged: false }
          })
        )
        .mockRejectedValueOnce(new Error('boom'))
    });
    const user = await openAi(api);
    const panel = screen.getByTestId('ai-activity');
    expect(within(panel).getByText('Off')).toBeInTheDocument();
    expect(within(panel).getByText('Agents may call their models.')).toBeInTheDocument();
    expect(within(panel).queryByText('Over budget')).not.toBeInTheDocument();
    expect(within(panel).getByRole('table', { name: 'Spend by agent' })).toHaveTextContent('Removed seat');
    const log = within(panel).getByRole('list', { name: 'Agent decisions' });
    expect(log).toHaveTextContent('mystery');
    expect(log).toHaveTextContent('team-9');
    expect(log).toHaveTextContent('Skipped');
    await user.selectOptions(screen.getByLabelText('Filter by team'), 'team-4');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it("lists each agent seat's versions, newest first, with what changed", async () => {
    const base = { personalityId: 'p4', difficulty: 'pro', archetype: 'balanced' };
    const api = fakeApi({
      getAgentSeat: vi.fn(async (_id: string, teamId: string) => ({
        seat: {
          teamId,
          personality: catalog().personalities[4]!,
          difficulty: { id: 'rookie', displayName: 'Rookie' }
        },
        commissioner: {
          current: { version: 3, config: { ...base, difficulty: 'rookie' } },
          history: [
            {
              version: 3,
              updatedAt: '2026-09-20T12:00:00.000Z',
              updatedBy: 'user#alice',
              config: { ...base, difficulty: 'rookie', advanced: { modelOverride: 'claude-opus-5' } }
            },
            {
              version: 2,
              updatedAt: '2026-09-10T12:00:00.000Z',
              updatedBy: 'user#alice',
              config: { ...base, advanced: { customFlavor: 'Pirate talk.' } }
            },
            { version: 1, updatedAt: '2026-09-01T12:00:00.000Z', updatedBy: 'user#alice', config: base }
          ]
        }
      }))
    });
    await openAi(api);
    const table = await screen.findByRole('table', { name: 'Seat version history' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('v3 Current');
    expect(rows[1]).toHaveTextContent('Persona 4 · Rookie · Balanced · Claude Opus 5');
    expect(rows[1]).toHaveTextContent(
      'Difficulty: Pro → Rookie; Model: Difficulty default → Claude Opus 5; Advanced levers or flavor changed'
    );
    expect(rows[2]).toHaveTextContent('Advanced levers or flavor changed');
    expect(rows[3]).toHaveTextContent('alice');
    expect(rows[3]).toHaveTextContent('First version');
    expect(api.getAgentSeat).toHaveBeenCalledWith('L1', 'team-4');
  });

  it('explains a seat without saved versions, an unchanged save, and load errors', async () => {
    const config = { personalityId: 'p1', difficulty: 'pro', archetype: 'balanced' };
    const revision = (version: number) => ({
      version,
      updatedAt: '2026-09-01T12:00:00.000Z',
      updatedBy: 'agent',
      config
    });
    const seat = (history: ReturnType<typeof revision>[]) => ({
      seat: {
        teamId: 'team-4',
        personality: catalog().personalities[1]!,
        difficulty: { id: 'pro', displayName: 'Pro' }
      },
      commissioner: { current: { version: history.length, config }, history }
    });
    let down = false;
    const api = fakeApi({
      getLeague: vi.fn(async () => league({ teams: [team(1, { seatType: 'human' }), team(4), team(5)] })),
      getAgentSeat: vi.fn(async (_id: string, teamId: string) => {
        if (teamId === 'team-5') return seat([]);
        if (down) throw new Error('seat down');
        return seat([revision(2), revision(1)]);
      })
    });
    const user = await openAi(api);
    expect(await screen.findByText('Saved with no changes')).toBeInTheDocument();
    const picker = screen.getByLabelText('Agent seat');
    await user.selectOptions(picker, 'team-5');
    expect(await screen.findByText('This seat has no saved config yet.')).toBeInTheDocument();
    down = true;
    await user.selectOptions(picker, 'team-4');
    expect(await screen.findByText('seat down')).toBeInTheDocument();
  });

  it('has no seat history without agent seats', async () => {
    const api = fakeApi({
      getLeague: vi.fn(async () => league({ teams: [team(1, { seatType: 'human' })] }))
    });
    await openAi(api);
    expect(await screen.findByText('No agent seats')).toBeInTheDocument();
    expect(api.getAgentSeat).not.toHaveBeenCalled();
  });

  it('is only offered to the commissioner', async () => {
    const api = fakeApi({ getLeagueState: vi.fn(async () => state({ youAreCommissioner: false })) });
    renderApp('/leagues/L1/settings', undefined, api);
    await screen.findByTestId('league-section-settings');
    expect(screen.queryByRole('button', { name: 'AI activity' })).not.toBeInTheDocument();
    expect(api.getAgentActivity).not.toHaveBeenCalled();
  });
});
