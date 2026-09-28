import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeagueApi } from '../../api/league';
import type { AgentActivity, AgentTaskRecord } from '../../api/types';
import { fakeApi, state } from '../../test/fakeApi';
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

  it('is only offered to the commissioner', async () => {
    const api = fakeApi({ getLeagueState: vi.fn(async () => state({ youAreCommissioner: false })) });
    renderApp('/leagues/L1/settings', undefined, api);
    await screen.findByTestId('league-section-settings');
    expect(screen.queryByRole('button', { name: 'AI activity' })).not.toBeInTheDocument();
    expect(api.getAgentActivity).not.toHaveBeenCalled();
  });
});
