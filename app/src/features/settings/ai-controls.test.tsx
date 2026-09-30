import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeagueApi } from '../../api/league';
import type { AgentActivity, AiSettings } from '../../api/types';
import { fakeApi, league, settings, state } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';

beforeEach(() => signInAs({ sub: 'alice', given_name: 'Alice' }));

const NO_MODELS: AiSettings['models'] = {
  rookie: { decision: null, chat: null },
  amateur: { decision: null, chat: null },
  pro: { decision: null, chat: null },
  all_pro: { decision: null, chat: null },
  hall_of_famer: { decision: null, chat: null }
};

function activity(budget: Partial<AgentActivity['budget']> = {}): AgentActivity {
  return {
    tasks: [],
    budget: {
      week: 3,
      ceilingUsd: 2,
      automatic: false,
      overageUsd: 1,
      limitUsd: 3,
      spentUsd: 2.4,
      remainingUsd: 0,
      overage: true,
      exceeded: false,
      byAgent: [],
      byModel: [],
      ...budget
    },
    season: {
      spentUsd: 5.75,
      weeks: [
        { week: 0, spentUsd: 1.1, tasks: 30 },
        { week: 3, spentUsd: 4.65, tasks: 12 }
      ]
    },
    killSwitch: { configured: true, engaged: false }
  };
}

async function openAi(api: LeagueApi) {
  const user = userEvent.setup();
  renderApp('/leagues/L1/settings', undefined, api);
  await screen.findByTestId('league-section-settings');
  await user.click(screen.getByRole('button', { name: 'AI activity' }));
  await screen.findByTestId('ai-controls');
  // The model choices load with the catalog.
  await screen.findByRole('combobox', { name: 'Rookie decision model' });
  return user;
}

describe('settings: AI budget & models', () => {
  it('sets a weekly budget, allows overage, and maps a difficulty to a Nova model', async () => {
    const api = fakeApi({ getAgentActivity: vi.fn(async () => activity()) });
    const user = await openAi(api);
    const panel = screen.getByTestId('ai-controls');
    const save = within(panel).getByRole('button', { name: 'Save AI settings' });
    expect(save).toBeDisabled();

    await user.click(within(panel).getByRole('button', { name: 'Set an amount' }));
    await user.type(within(panel).getByLabelText('Budget per week (USD)'), '5');
    await user.click(within(panel).getByRole('button', { name: 'Allow overage' }));
    await user.type(within(panel).getByLabelText('Extra per week (USD)'), '1.50');
    const rookie = within(panel).getByRole('combobox', { name: 'Rookie decision model' });
    // Models show their estimated price.
    expect(
      within(rookie).getByRole('option', { name: 'Amazon Nova Micro · $0.035 in / $0.14 out' })
    ).toBeInTheDocument();
    await user.selectOptions(rookie, 'nova-micro');
    await user.click(save);

    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith(
        'L1',
        {
          ai: {
            weeklyBudgetUsd: 5,
            overageUsd: 1.5,
            models: { ...NO_MODELS, rookie: { decision: 'nova-micro', chat: null } }
          }
        },
        3
      )
    );
  });

  it('refuses amounts it cannot save, and warns when pricier models run on the automatic budget', async () => {
    const api = fakeApi({ getAgentActivity: vi.fn(async () => activity()) });
    const user = await openAi(api);
    const panel = screen.getByTestId('ai-controls');
    await user.click(within(panel).getByRole('button', { name: 'Set an amount' }));
    await user.type(within(panel).getByLabelText('Budget per week (USD)'), '500');
    expect(within(panel).getByText('Enter an amount from $0 to $100.')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Save AI settings' })).toBeDisabled();

    await user.click(within(panel).getByRole('button', { name: 'Automatic' }));
    await user.selectOptions(
      within(panel).getByRole('combobox', { name: 'Rookie decision model' }),
      'claude-opus-5'
    );
    expect(within(panel).getByRole('note')).toHaveTextContent(/set an amount so the budget keeps up/);
  });

  it("starts from the league's saved settings and clears a model back to the default", async () => {
    const saved: AiSettings = {
      weeklyBudgetUsd: 4,
      overageUsd: 2,
      models: { ...NO_MODELS, pro: { decision: 'claude-opus-5', chat: 'nova-micro' } }
    };
    const api = fakeApi({
      getLeague: vi.fn(async () => league({ settings: settings({ ai: saved }) })),
      getAgentActivity: vi.fn(async () => activity())
    });
    const user = await openAi(api);
    const panel = screen.getByTestId('ai-controls');
    expect(within(panel).getByLabelText('Budget per week (USD)')).toHaveValue('4');
    expect(within(panel).getByLabelText('Extra per week (USD)')).toHaveValue('2');
    const pro = within(panel).getByRole('combobox', { name: 'Pro decision model' });
    expect(pro).toHaveValue('claude-opus-5');
    await user.selectOptions(pro, '');
    await user.click(within(panel).getByRole('button', { name: 'Save AI settings' }));
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith(
        'L1',
        { ai: { ...saved, models: { ...NO_MODELS, pro: { decision: null, chat: 'nova-micro' } } } },
        3
      )
    );
  });

  it('shows overage and season-to-date spend in the activity summary', async () => {
    const api = fakeApi({ getAgentActivity: vi.fn(async () => activity()) });
    await openAi(api);
    const panel = await screen.findByTestId('ai-activity');
    expect(within(panel).getByText('$2.40 of $2.00')).toBeInTheDocument();
    expect(within(panel).getByText('On overage')).toBeInTheDocument();
    expect(within(panel).getByText('On overage: $0.60 of $1.00 left')).toBeInTheDocument();
    expect(within(panel).getByText('$5.75')).toBeInTheDocument();
    expect(within(panel).getByText('42 tasks · estimates, not billing')).toBeInTheDocument();
  });

  it('is read-only when the settings cannot change', async () => {
    const api = fakeApi({
      getLeagueState: vi.fn(async () => state({ allowedActions: ['configure_agent_seat'] })),
      getAgentActivity: vi.fn(async () => activity({ overage: false, automatic: true, overageUsd: 0 }))
    });
    await openAi(api);
    const panel = screen.getByTestId('ai-controls');
    expect(within(panel).queryByRole('button', { name: 'Save AI settings' })).not.toBeInTheDocument();
    expect(within(panel).getByRole('combobox', { name: 'Rookie decision model' })).toBeDisabled();
  });
});
