import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@readysetcloud/ui';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { LeagueApiContext, type LeagueApi } from '../../api/league';
import type { LeagueDetail } from '../../api/types';
import { defaults, fakeApi, league, settings } from '../../test/fakeApi';
import { RulesEditor } from './RulesEditor';
import {
  fieldValue,
  getPath,
  inferPreset,
  isEditableInPhase,
  ruleSections,
  setPath,
  settingsPatch
} from './rules';

describe('rule helpers', () => {
  it('reads and writes dotted paths', () => {
    expect(getPath({ a: { b: 1 } }, 'a.b')).toBe(1);
    expect(getPath({ a: 1 }, 'a.b')).toBeUndefined();
    expect(setPath({ a: { b: 1, c: 2 } }, 'a.b', 3)).toEqual({ a: { b: 3, c: 2 } });
    expect(setPath({}, 'x.y', 1)).toEqual({ x: { y: 1 } });
  });

  it('knows which paths the phase still allows', () => {
    const { editability } = defaults();
    expect(isEditableInPhase('scoring.perStat.rec', 'setup', editability)).toBe(true);
    expect(isEditableInPhase('scoring.perStat.rec', 'regular_season', editability)).toBe(false);
    expect(isEditableInPhase('trades.review', 'regular_season', editability)).toBe(true);
    expect(isEditableInPhase('waivers.waiverPeriodDays', 'playoffs', editability)).toBe(true);
    expect(isEditableInPhase('waivers.type', 'playoffs', editability)).toBe(false);
    expect(isEditableInPhase('mystery', 'drafting', editability)).toBe(false);
  });

  it('builds sections, values, and a minimal patch', () => {
    const custom = settings({
      scoring: { perStat: { pass_td: 6, bonus_x: 2 }, tiers: [] }
    });
    const sections = ruleSections(custom, defaults());
    expect(sections.map((s) => s.title)).toEqual([
      'Roster slots',
      'Scoring',
      'Waivers and FAAB',
      'Trades',
      'Playoffs',
      'Schedule'
    ]);
    const scoring = sections[1]!.fields.map((f) => f.label);
    expect(scoring).toEqual(['Passing touchdowns', 'Receptions', 'bonus_x']);
    const fields = sections.flatMap((s) => s.fields);
    const te = fields.find((f) => f.path === 'roster.slots.TE')!;
    expect(fieldValue(custom, te)).toBe(0);
    let draft = setPath(custom, 'roster.slots.TE', 1);
    draft = setPath(draft, 'teamCount', '6');
    draft = setPath(draft, 'trades.vetoVotes', 3);
    expect(settingsPatch(custom, draft, fields)).toEqual({
      teamCount: 6,
      roster: { slots: { TE: 1 } },
      trades: { vetoVotes: 3 }
    });
  });

  it('infers the scoring preset from reception points', () => {
    expect(inferPreset(settings())).toBe('yahoo_standard');
    expect(inferPreset(settings({ scoring: { perStat: { rec: 1 }, tiers: [] } }))).toBe('full_ppr');
    expect(inferPreset(settings({ scoring: { perStat: {}, tiers: [] } }))).toBe('standard');
  });
});

function renderEditor(detail: LeagueDetail, canEdit: boolean, api: LeagueApi = fakeApi()) {
  const onSaved = vi.fn();
  render(
    <ToastProvider>
      <LeagueApiContext.Provider value={api}>
        <RulesEditor league={detail} defaults={defaults()} canEdit={canEdit} onSaved={onSaved} />
      </LeagueApiContext.Provider>
    </ToastProvider>
  );
  return { onSaved, api };
}

describe('RulesEditor', () => {
  it('highlights changes from the Yahoo defaults and resets them', async () => {
    const user = userEvent.setup();
    const detail = league({
      settings: settings({
        waivers: { ...settings().waivers, faabBudget: 200, maxAcquisitionsPerWeek: 4 },
        trades: { ...settings().trades, expireAtNextLineupLock: false, vetoVotes: 2 }
      })
    });
    renderEditor(detail, true);
    const faab = screen.getByTestId('rule-waivers.faabBudget');
    expect(faab).toHaveAttribute('data-changed', 'true');
    expect(faab).toHaveTextContent('Yahoo default: 100');
    expect(screen.getByTestId('rule-waivers.maxAcquisitionsPerWeek')).toHaveTextContent(
      'Yahoo default: Unlimited'
    );
    expect(screen.getByTestId('rule-trades.expireAtNextLineupLock')).toHaveTextContent('Yahoo default: Yes');
    expect(screen.getByTestId('rule-waivers.type')).not.toHaveAttribute('data-changed');
    expect(screen.getByRole('button', { name: 'Save rules' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Reset FAAB budget ($) to default' }));
    expect(screen.getByTestId('rule-waivers.faabBudget')).not.toHaveAttribute('data-changed');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('FAAB budget ($)')).toHaveValue(200);
  });

  it('edits every kind of field and saves only the changes', async () => {
    const user = userEvent.setup();
    const { api, onSaved } = renderEditor(league(), true);
    await user.clear(screen.getByLabelText('TE'));
    await user.type(screen.getByLabelText('TE'), '1');
    await user.click(screen.getByLabelText('pup'));
    await user.click(screen.getByLabelText('out'));
    await user.clear(screen.getByLabelText('Receptions'));
    await user.type(screen.getByLabelText('Receptions'), '1');
    await user.selectOptions(screen.getByLabelText('Waiver type'), 'rolling');
    await user.selectOptions(screen.getByLabelText('Allow $0 bids'), 'no');
    await user.type(screen.getByLabelText('Max adds per week'), '5');
    await user.selectOptions(screen.getByLabelText('Teams'), '6');
    expect(screen.getByTestId('rule-roster.irEligibleStatuses')).toHaveTextContent('Yahoo default: ir, out');
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(api.updateSettings).toHaveBeenCalledWith(
      'L1',
      {
        teamCount: 6,
        roster: { slots: { TE: 1 }, irEligibleStatuses: ['ir', 'pup'] },
        scoring: { perStat: { rec: 1 } },
        waivers: { type: 'rolling', allowZeroBids: false, maxAcquisitionsPerWeek: 5 }
      },
      3
    );
    expect(await screen.findByText('Rules saved.')).toBeInTheDocument();
  });

  it('shows the server fix under each invalid field', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      updateSettings: vi.fn(async () => {
        throw new ApiError(400, {
          code: 'INVALID_SETTINGS',
          message: 'The league settings are not valid (2 problem(s)).',
          fix: 'Lower the byes. Pick statuses.',
          details: {
            issues: [
              { code: 'BYES', path: 'playoffs.byes', message: 'Too many byes.', fix: 'Lower the byes.' },
              {
                code: 'IR',
                path: 'roster.irEligibleStatuses',
                message: 'Pick one.',
                fix: 'Pick statuses.'
              }
            ]
          }
        });
      })
    });
    renderEditor(league(), true, api);
    await user.clear(screen.getByLabelText('First-round byes'));
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(await screen.findByText('Lower the byes. Pick statuses.')).toBeInTheDocument();
    expect(within(screen.getByTestId('rule-playoffs.byes')).getByText('Lower the byes.')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('rule-roster.irEligibleStatuses')).getByText('Pick statuses.')
    ).toBeInTheDocument();
    expect(api.updateSettings).toHaveBeenCalledWith('L1', { playoffs: { byes: '' } }, 3);
  });

  it('ignores errors without issues', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      updateSettings: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(409, { code: 'CONFLICT', message: 'Stale.' }))
        .mockRejectedValueOnce(new Error('offline'))
    });
    renderEditor(league(), true, api);
    await user.type(screen.getByLabelText('Veto votes needed'), '2');
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Stale.');
    await user.clear(screen.getByLabelText('Veto votes needed'));
    await user.type(screen.getByLabelText('Veto votes needed'), '3');
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
  });

  it('locks pre-draft rules once the draft starts', () => {
    renderEditor(league({ phase: 'regular_season', week: 5 }), true);
    expect(screen.getByText(/The draft has started/)).toBeInTheDocument();
    expect(screen.getByLabelText('QB')).toBeDisabled();
    expect(screen.getByLabelText('Receptions')).toBeDisabled();
    expect(screen.getByLabelText('Trade review')).toBeEnabled();
    expect(screen.getByLabelText('ir')).toBeEnabled();
  });

  it('is read-only for members, and final once the league is complete', () => {
    const detail = league({ settings: settings({ waivers: { ...settings().waivers, faabBudget: 50 } }) });
    renderEditor(detail, false);
    expect(screen.getByText(/Only the commissioner can change the rules/)).toBeInTheDocument();
    expect(screen.getByLabelText('Trade review')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Reset/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save rules' })).not.toBeInTheDocument();
    renderEditor(league({ phase: 'complete' }), false);
    expect(screen.getByText(/rules are final/)).toBeInTheDocument();
  });
});
