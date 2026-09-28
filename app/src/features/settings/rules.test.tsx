import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@readysetcloud/ui';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { LeagueApiContext, type LeagueApi } from '../../api/league';
import type { DefaultSettings, LeagueDetail, TierRule } from '../../api/types';
import { defaults, fakeApi, league, settings } from '../../test/fakeApi';
import { RulesEditor } from './RulesEditor';
import {
  addTierBand,
  describeTiers,
  fieldValue,
  getPath,
  inferPreset,
  isEditableInPhase,
  ruleSections,
  setPath,
  settingsPatch,
  tierStatLabel
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
    expect(scoring).toEqual(['Passing touchdowns', 'Receptions', 'bonus_x', 'Tiered scoring']);
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

  it('describes, labels, and extends tier bands', () => {
    const rule: TierRule = {
      stat: 'pts_allow',
      bands: [
        { min: 0, max: 0, points: 10 },
        { min: 1, max: 6, points: 7 },
        { min: 35, max: null, points: -4 }
      ]
    };
    expect(describeTiers([])).toBe('None');
    expect(describeTiers([rule])).toBe('0: 10 · 1–6: 7 · 35+: -4');
    expect(tierStatLabel('pts_allow', {})).toBe('Points allowed');
    expect(tierStatLabel('pts_allow', { pts_allow: 'Points allowed (DEF)' })).toBe('Points allowed (DEF)');
    expect(tierStatLabel('yds_allow', {})).toBe('yds_allow');
    expect(addTierBand(rule).bands.slice(-2)).toEqual([
      { min: 35, max: 35, points: -4 },
      { min: 36, max: null, points: 0 }
    ]);
    expect(addTierBand({ stat: 'x', bands: [{ min: 0, max: 5, points: 1 }] }).bands[1]).toEqual({
      min: 6,
      max: null,
      points: 0
    });
    expect(addTierBand({ stat: 'x', bands: [] }).bands).toEqual([{ min: 0, max: null, points: 0 }]);
  });

  it('infers the scoring preset from reception points', () => {
    expect(inferPreset(settings())).toBe('yahoo_standard');
    expect(inferPreset(settings({ scoring: { perStat: { rec: 1 }, tiers: [] } }))).toBe('full_ppr');
    expect(inferPreset(settings({ scoring: { perStat: {}, tiers: [] } }))).toBe('standard');
  });
});

function renderEditor(
  detail: LeagueDetail,
  canEdit: boolean,
  api: LeagueApi = fakeApi(),
  ruleDefaults: DefaultSettings = defaults()
) {
  const onSaved = vi.fn();
  render(
    <ToastProvider>
      <LeagueApiContext.Provider value={api}>
        <RulesEditor league={detail} defaults={ruleDefaults} canEdit={canEdit} onSaved={onSaved} />
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

  it('edits the points-allowed tier bands and shows their fixes', async () => {
    const user = userEvent.setup();
    const yahoo: TierRule = {
      stat: 'pts_allow',
      bands: [
        { min: 0, max: 0, points: 10 },
        { min: 1, max: 6, points: 7 },
        { min: 7, max: null, points: 4 }
      ]
    };
    const withTiers = settings({ scoring: { perStat: { pass_td: 4, rec: 0.5 }, tiers: [yahoo] } });
    const api = fakeApi({
      updateSettings: vi.fn(async () => {
        throw new ApiError(400, {
          code: 'INVALID_SETTINGS',
          message: 'The league settings are not valid (1 problem(s)).',
          fix: 'Fix the bands.',
          details: {
            issues: [
              {
                code: 'TIER_BANDS_OVERLAP',
                path: 'scoring.tiers.0.bands.3',
                message: 'Overlap.',
                fix: 'List bands in ascending order.'
              }
            ]
          }
        });
      })
    });
    renderEditor(league({ settings: withTiers }), true, api, { ...defaults(), settings: withTiers });
    const tiers = screen.getByTestId('rule-scoring.tiers');
    expect(tiers).not.toHaveAttribute('data-changed');
    await user.clear(screen.getByLabelText('Points allowed band 1 points'));
    await user.type(screen.getByLabelText('Points allowed band 1 points'), '12');
    expect(tiers).toHaveAttribute('data-changed', 'true');
    expect(tiers).toHaveTextContent('Yahoo default: 0: 10 · 1–6: 7 · 7+: 4');
    await user.clear(screen.getByLabelText('Points allowed band 2 to'));
    await user.type(screen.getByLabelText('Points allowed band 2 to'), '5');
    await user.clear(screen.getByLabelText('Points allowed band 3 from'));
    await user.type(screen.getByLabelText('Points allowed band 3 from'), '6');
    await user.click(screen.getByRole('button', { name: 'Add Points allowed band' }));
    await user.clear(screen.getByLabelText('Points allowed band 4 from'));
    await user.click(screen.getByRole('button', { name: 'Remove Points allowed band 2' }));
    await user.clear(screen.getByLabelText('Points allowed band 3 to'));
    await user.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(api.updateSettings).toHaveBeenCalledWith(
      'L1',
      {
        scoring: {
          tiers: [
            {
              stat: 'pts_allow',
              bands: [
                { min: 0, max: 0, points: 12 },
                { min: 6, max: 6, points: 4 },
                { min: '', max: null, points: 0 }
              ]
            }
          ]
        }
      },
      3
    );
    expect(await within(tiers).findByText('List bands in ascending order.')).toBeInTheDocument();
    expect(within(tiers).getAllByRole('button', { name: /Remove/ })[0]).toBeEnabled();
  });

  it('shows a league without tiered stats, and a single band cannot be removed', () => {
    const one = settings({
      scoring: { perStat: {}, tiers: [{ stat: 'pts_allow', bands: [{ min: 0, max: null, points: 1 }] }] }
    });
    renderEditor(league({ settings: one }), true);
    expect(screen.getByRole('button', { name: 'Remove Points allowed band 1' })).toBeDisabled();
    expect(screen.getByTestId('rule-scoring.tiers')).toHaveTextContent('Yahoo default: None');
    renderEditor(league(), true);
    expect(screen.getByText('No tiered stats.')).toBeInTheDocument();
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
