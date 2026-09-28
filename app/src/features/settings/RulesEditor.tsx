import { useMemo, useState } from 'react';
import { Alert, Button, Card, CardBody, Input, Select, useToast } from '@readysetcloud/ui';
import { ApiError } from '../../api/client';
import { useLeagueApi } from '../../api/league';
import type { DefaultSettings, LeagueDetail, SettingsIssue, TierRule } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import {
  addTierBand,
  describeTiers,
  fieldValue,
  isEditableInPhase,
  ruleSections,
  sameValue,
  setPath,
  settingsPatch,
  tierStatLabel,
  type RuleField
} from './rules';

export interface RulesEditorProps {
  league: LeagueDetail;
  defaults: DefaultSettings;
  /** True when update_league_settings is in allowedActions. */
  canEdit: boolean;
  onSaved: () => void;
}

/** Field-level fixes from an INVALID_SETTINGS error. */
function issuesByPath(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const issues = (error.details as { issues?: SettingsIssue[] } | undefined)?.issues ?? [];
  return Object.fromEntries(issues.map((issue) => [issue.path, issue.fix]));
}

function display(field: RuleField, value: unknown): string {
  if (field.kind === 'bool') return value ? 'Yes' : 'No';
  if (field.kind === 'nullableInt' && value === null) return field.nullLabel;
  if (field.kind === 'enum') return field.options.find(([v]) => v === value)?.[1] ?? String(value);
  if (field.kind === 'statuses') return (value as string[]).join(', ');
  if (field.kind === 'tiers') return describeTiers(value as TierRule[]);
  return String(value);
}

/** The fix for a field; the tiers field collects the fixes for every band under it. */
function fieldError(field: RuleField, errors: Record<string, string>): string | undefined {
  if (field.kind !== 'tiers') return errors[field.path];
  const fixes = Object.entries(errors)
    .filter(([path]) => path === field.path || path.startsWith(`${field.path}.`))
    .map(([, fix]) => fix);
  return fixes.length === 0 ? undefined : fixes.join(' ');
}

/** The commissioner's rules editor: Yahoo defaults, changes highlighted, locked by phase. */
export function RulesEditor({ league, defaults, canEdit, onSaved }: RulesEditorProps) {
  const api = useLeagueApi();
  const { toast } = useToast();
  const sections = useMemo(() => ruleSections(league.settings, defaults), [league.settings, defaults]);
  const fields = useMemo(() => sections.flatMap((s) => s.fields), [sections]);
  const [draft, setDraft] = useState(league.settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const patch = settingsPatch(league.settings, draft, fields);
  const dirty = Object.keys(patch).length > 0;
  const fieldErrors = issuesByPath(error);

  const editable = (field: RuleField) =>
    canEdit && isEditableInPhase(field.path, league.phase, defaults.editability);
  const change = (field: RuleField, value: unknown) => setDraft((d) => setPath(d, field.path, value));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateSettings(league.id, patch, league.version);
      toast('Rules saved.', { variant: 'success' });
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="rules-editor">
      {!canEdit && (
        <Alert variant="info">
          {league.phase === 'complete'
            ? 'This league is complete, so its rules are final.'
            : 'Only the commissioner can change the rules. You can see them here.'}
        </Alert>
      )}
      {canEdit && league.phase !== 'setup' && (
        <Alert variant="info">
          The draft has started: only trade settings, waiver timing and tiebreaks, and IR statuses can still
          change.
        </Alert>
      )}
      <ApiErrorAlert error={error} />
      {sections.map((section) => (
        <Card key={section.id}>
          <CardBody className="space-y-3">
            <h3 className="text-lg font-semibold">{section.title}</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {section.fields.map((field) => {
                const value = fieldValue(draft, field);
                const fallback = fieldValue(defaults.settings, field);
                const changed = !sameValue(value, fallback);
                const locked = !editable(field);
                return (
                  <div
                    key={field.path}
                    data-testid={`rule-${field.path}`}
                    data-changed={changed || undefined}
                    className={`space-y-1 rounded-md p-2 ${field.kind === 'tiers' ? 'sm:col-span-2 lg:col-span-3' : ''} ${changed ? 'bg-warning-50 ring-1 ring-warning-300' : ''}`}
                  >
                    <RuleInput
                      field={field}
                      value={value}
                      disabled={locked || saving}
                      error={fieldError(field, fieldErrors)}
                      options={defaults.playerStatuses}
                      statLabels={defaults.statLabels}
                      onChange={(v) => change(field, v)}
                    />
                    {changed && (
                      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        Yahoo default: {display(field, fallback)}
                        {!locked && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Reset ${field.label} to default`}
                            onClick={() => change(field, fallback)}
                          >
                            Reset to default
                          </Button>
                        )}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      ))}
      {canEdit && (
        <div className="sticky bottom-0 flex justify-end gap-2 bg-background py-3">
          <Button variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(league.settings)}>
            Discard changes
          </Button>
          <Button variant="primary" disabled={!dirty} loading={saving} onClick={() => void save()}>
            Save rules
          </Button>
        </div>
      )}
    </div>
  );
}

function RuleInput({
  field,
  value,
  disabled,
  error,
  options,
  statLabels,
  onChange
}: {
  field: RuleField;
  value: unknown;
  disabled: boolean;
  error: string | undefined;
  options: string[];
  statLabels: Record<string, string>;
  onChange: (value: unknown) => void;
}) {
  switch (field.kind) {
    case 'int':
    case 'decimal':
      return (
        <Input
          type="number"
          label={field.label}
          value={String(value)}
          disabled={disabled}
          error={error}
          step={field.kind === 'int' ? 1 : 0.01}
          {...(field.kind === 'int' ? { min: field.min, max: field.max } : {})}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
      );
    case 'nullableInt':
      return (
        <Input
          type="number"
          label={field.label}
          placeholder={field.nullLabel}
          hint={value === null ? field.nullLabel : undefined}
          value={value === null ? '' : String(value)}
          disabled={disabled}
          error={error}
          min={field.min}
          max={field.max}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    case 'bool':
      return (
        <Select
          label={field.label}
          value={value ? 'yes' : 'no'}
          disabled={disabled}
          error={error}
          onChange={(e) => onChange(e.target.value === 'yes')}
        >
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </Select>
      );
    case 'enum':
      return (
        <Select
          label={field.label}
          value={String(value)}
          disabled={disabled}
          error={error}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </Select>
      );
    case 'statuses': {
      const selected = value as string[];
      return (
        <fieldset disabled={disabled} className="space-y-1">
          <legend className="text-sm font-medium">{field.label}</legend>
          <div className="flex flex-wrap gap-3">
            {options.map((status) => (
              <label key={status} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(status)}
                  onChange={(e) =>
                    onChange(e.target.checked ? [...selected, status] : selected.filter((s) => s !== status))
                  }
                />
                {status}
              </label>
            ))}
          </div>
          {error && <p className="text-sm text-error-600">{error}</p>}
        </fieldset>
      );
    }
    case 'tiers':
      return (
        <TiersInput
          label={field.label}
          rules={value as TierRule[]}
          disabled={disabled}
          error={error}
          statLabels={statLabels}
          onChange={onChange}
        />
      );
  }
}

/** Number input value: blank stays blank (the server explains what is missing). */
const num = (text: string): number | '' => (text === '' ? '' : Number(text));

/** Each tier rule's bands as rows of from / to / points, with bands added and removed at the end. */
function TiersInput({
  label,
  rules,
  disabled,
  error,
  statLabels,
  onChange
}: {
  label: string;
  rules: TierRule[];
  disabled: boolean;
  error: string | undefined;
  statLabels: Record<string, string>;
  onChange: (value: unknown) => void;
}) {
  const setRule = (index: number, rule: TierRule) => onChange(rules.map((r, i) => (i === index ? rule : r)));
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="text-sm font-medium">{label}</legend>
      {rules.length === 0 && <p className="text-sm text-muted-foreground">No tiered stats.</p>}
      {rules.map((rule, r) => {
        const name = tierStatLabel(rule.stat, statLabels);
        const setBand = (b: number, change: Partial<TierRule['bands'][number]>) =>
          setRule(r, {
            ...rule,
            bands: rule.bands.map((band, i) => (i === b ? { ...band, ...change } : band))
          });
        return (
          <div key={rule.stat} className="space-y-2" data-testid={`tiers-${rule.stat}`}>
            <p className="text-sm font-medium">{name}</p>
            {rule.bands.map((band, b) => (
              <div key={b} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
                <Input
                  type="number"
                  label={`${name} band ${b + 1} from`}
                  value={String(band.min)}
                  onChange={(e) => setBand(b, { min: num(e.target.value) as number })}
                />
                <Input
                  type="number"
                  label={`${name} band ${b + 1} to`}
                  placeholder="No limit"
                  value={band.max === null ? '' : String(band.max)}
                  onChange={(e) => setBand(b, { max: e.target.value === '' ? null : Number(e.target.value) })}
                />
                <Input
                  type="number"
                  step={0.5}
                  label={`${name} band ${b + 1} points`}
                  value={String(band.points)}
                  onChange={(e) => setBand(b, { points: num(e.target.value) as number })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={rule.bands.length === 1}
                  aria-label={`Remove ${name} band ${b + 1}`}
                  onClick={() => setRule(r, { ...rule, bands: rule.bands.filter((_, i) => i !== b) })}
                >
                  ✕
                </Button>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => setRule(r, addTierBand(rule))}>
              Add {name} band
            </Button>
          </div>
        );
      })}
      {error && <p className="text-sm text-error-600">{error}</p>}
    </fieldset>
  );
}
