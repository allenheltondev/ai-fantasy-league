import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type { LeagueApi } from '../../api/league';
import { fakeApi, league, settings, state } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';
import { fromLocalInput, toLocalInput } from './DraftSchedulePanel';

beforeEach(() => signInAs({ sub: 'alice', given_name: 'Alice' }));

async function open(api: LeagueApi) {
  renderApp('/leagues/L1/settings', undefined, api);
  return screen.findByTestId('draft-schedule');
}

const scheduled = (scheduledAt: string | null, orderMode: 'slots' | 'random' = 'slots') =>
  league({ settings: { ...settings(), draft: { pickSeconds: 90, scheduledAt, orderMode } } });

describe('draft time helpers', () => {
  it('shows a UTC instant in this browser’s time zone and stores it back as UTC', () => {
    const at = '2026-10-01T23:30:00.000Z';
    expect(toLocalInput(at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(fromLocalInput(toLocalInput(at))).toBe(at);
    expect(toLocalInput(null)).toBe('');
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('not a time')).toBeNull();
  });
});

describe('settings: draft time', () => {
  it('lets the commissioner schedule the draft in local time, stored as UTC, with an order', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const panel = within(await open(api));
    expect(panel.getByRole('button', { name: 'Save draft time' })).toBeDisabled();
    expect(panel.queryByRole('button', { name: 'Clear draft time' })).not.toBeInTheDocument();
    const input = panel.getByLabelText(/^Draft starts \(/);
    await user.type(input, '2026-10-01T19:30');
    await user.selectOptions(panel.getByLabelText('Draft order'), 'random');
    await user.click(panel.getByRole('button', { name: 'Save draft time' }));
    expect(api.updateSettings).toHaveBeenCalledWith(
      'L1',
      { draft: { scheduledAt: new Date('2026-10-01T19:30').toISOString(), orderMode: 'random' } },
      3
    );
    expect(await screen.findByText('Draft scheduled.')).toBeInTheDocument();
  });

  it('shows the saved time and clears it, or says why a save failed', async () => {
    const user = userEvent.setup();
    const at = '2026-10-01T23:30:00.000Z';
    const updateSettings = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(400, { code: 'INVALID_SETTINGS', message: 'The draft time has already passed.' })
      )
      .mockResolvedValue({ version: 4, changedPaths: ['draft.scheduledAt'] });
    const api = fakeApi({ getLeague: vi.fn(async () => scheduled(at, 'random')), updateSettings });
    const panel = within(await open(api));
    expect(panel.getByLabelText(/^Draft starts \(/)).toHaveValue(toLocalInput(at));
    expect(panel.getByLabelText('Draft order')).toHaveValue('random');
    await user.click(panel.getByRole('button', { name: 'Clear draft time' }));
    expect(await screen.findByText('The draft time has already passed.')).toBeInTheDocument();
    await user.click(panel.getByRole('button', { name: 'Clear draft time' }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith(
        'L1',
        { draft: { scheduledAt: null, orderMode: 'random' } },
        3
      )
    );
    expect(await screen.findByText('Draft time cleared.')).toBeInTheDocument();
  });

  it('shows members the time without a picker', async () => {
    const at = '2026-10-01T23:30:00.000Z';
    const api = fakeApi({
      getLeague: vi.fn(async () => scheduled(at)),
      getLeagueState: vi.fn(async () => state({ youAreCommissioner: false, allowedActions: [] }))
    });
    const panel = await open(api);
    expect(panel).toHaveTextContent(`The draft starts ${new Date(at).toLocaleString()}`);
    expect(within(panel).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says a draft without a time starts by hand', async () => {
    const api = fakeApi({
      getLeagueState: vi.fn(async () => state({ youAreCommissioner: false, allowedActions: [] }))
    });
    expect(await open(api)).toHaveTextContent('The commissioner starts the draft by hand.');
  });
});
