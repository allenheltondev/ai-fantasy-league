import { useState } from 'react';
import { Button, Card, CardBody, Input, SegmentedControl, Select, useToast } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { AgentCatalog, AiSettings, CatalogModel, Difficulty, LeagueDetail } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';

/** Mirrors MAX_WEEKLY_AI_BUDGET_USD and MAX_AI_OVERAGE_USD in @fantasy/core. */
const MAX_USD = 100;

const DIFFICULTIES: readonly Difficulty[] = ['rookie', 'amateur', 'pro', 'all_pro', 'hall_of_famer'];

type ModelChoices = Record<Difficulty, { decision: string; chat: string }>;

function choicesFrom(ai: AiSettings | undefined): ModelChoices {
  return Object.fromEntries(
    DIFFICULTIES.map((d) => [d, { decision: ai?.models[d]?.decision ?? '', chat: ai?.models[d]?.chat ?? '' }])
  ) as ModelChoices;
}

function modelsFrom(choices: ModelChoices): AiSettings['models'] {
  return Object.fromEntries(
    DIFFICULTIES.map((d) => [d, { decision: choices[d].decision || null, chat: choices[d].chat || null }])
  ) as AiSettings['models'];
}

const PROVIDERS: Record<string, string> = {
  amazon: 'Amazon Nova',
  anthropic: 'Anthropic',
  moonshot: 'Moonshot'
};

function price(n: number): string {
  return `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;
}

function modelLabel(m: CatalogModel): string {
  return m.price === undefined
    ? m.displayName
    : `${m.displayName} · ${price(m.price.inputPerMTok)} in / ${price(m.price.outputPerMTok)} out`;
}

/** Catalog models grouped by provider, Nova first, cheapest first within each. */
function ModelOptions({ models }: { models: CatalogModel[] }) {
  const groups = new Map<string, CatalogModel[]>();
  for (const m of models) {
    const key = m.provider ?? 'other';
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const order = ['amazon', 'moonshot', 'anthropic'];
  const sorted = [...groups.entries()].sort(
    ([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)
  );
  const cost = (m: CatalogModel) => m.price?.inputPerMTok ?? 0;
  return (
    <>
      {sorted.map(([provider, list]) => (
        <optgroup key={provider} label={PROVIDERS[provider] ?? provider}>
          {[...list]
            .sort((a, b) => cost(a) - cost(b))
            .map((m) => (
              <option key={m.key} value={m.key}>
                {modelLabel(m)}
              </option>
            ))}
        </optgroup>
      ))}
    </>
  );
}

/** A dollar amount from 0 to MAX_USD with at most two decimals, or null. */
function parseUsd(value: string, min = 0): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  const n = Number(value);
  return n >= min && n <= MAX_USD ? n : null;
}

/**
 * The commissioner's AI controls: the league's weekly model budget (automatic from the AI
 * managers' difficulties, or a set amount), overage past it, and which model each difficulty tries
 * first for decisions and for chat. Changes apply from the agents' next task.
 */
export function AiControlsPanel({
  league,
  canEdit,
  onSaved
}: {
  league: LeagueDetail;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const api = useLeagueApi();
  const { toast } = useToast();
  const catalog = useLoad(() => api.getAgentCatalog(), 'catalog');
  const saved = league.settings.ai;
  const [mode, setMode] = useState<'auto' | 'custom'>(saved?.weeklyBudgetUsd == null ? 'auto' : 'custom');
  const [budget, setBudget] = useState(saved?.weeklyBudgetUsd == null ? '' : String(saved.weeklyBudgetUsd));
  const [overageOn, setOverageOn] = useState((saved?.overageUsd ?? 0) > 0);
  const [overage, setOverage] = useState((saved?.overageUsd ?? 0) > 0 ? String(saved?.overageUsd) : '');
  const [models, setModels] = useState<ModelChoices>(choicesFrom(saved));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const budgetUsd = mode === 'auto' ? null : parseUsd(budget);
  const overageUsd = overageOn ? parseUsd(overage, 0.01) : 0;
  const budgetInvalid = mode === 'custom' && budgetUsd === null;
  const overageInvalid = overageUsd === null;
  const anyModel = DIFFICULTIES.some((d) => models[d].decision !== '' || models[d].chat !== '');

  const next: AiSettings = {
    weeklyBudgetUsd: budgetUsd,
    overageUsd: overageUsd ?? 0,
    models: modelsFrom(models)
  };
  const current: AiSettings = {
    weeklyBudgetUsd: saved?.weeklyBudgetUsd ?? null,
    overageUsd: saved?.overageUsd ?? 0,
    models: modelsFrom(choicesFrom(saved))
  };
  const unchanged = JSON.stringify(next) === JSON.stringify(current);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateSettings(league.id, { ai: next }, league.version);
      toast('AI settings saved.', { variant: 'success' });
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const setModel = (d: Difficulty, role: 'decision' | 'chat', value: string) =>
    setModels((current) => ({ ...current, [d]: { ...current[d], [role]: value } }));

  const cat: AgentCatalog | null = catalog.data;
  const difficultyName = (d: Difficulty) => cat?.difficulties.find((x) => x.id === d)?.displayName ?? d;
  const tierOf = (d: Difficulty) => cat?.difficulties.find((x) => x.id === d)?.decisionModelTier;

  return (
    <div className="space-y-4" data-testid="ai-controls">
      <Card>
        <CardBody className="space-y-4">
          <div className="space-y-2">
            <h4 className="font-semibold">Weekly budget</h4>
            <SegmentedControl
              aria-label="Weekly budget"
              options={[
                { value: 'auto', label: 'Automatic', disabled: !canEdit },
                { value: 'custom', label: 'Set an amount', disabled: !canEdit }
              ]}
              value={mode}
              onChange={(v) => setMode(v as 'auto' | 'custom')}
            />
            {mode === 'auto' ? (
              <p className="text-sm text-muted-foreground">
                Sized from each AI manager&apos;s difficulty: tougher managers get a bigger share.
              </p>
            ) : (
              <Input
                label="Budget per week (USD)"
                inputMode="decimal"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                disabled={!canEdit}
                className="max-w-xs"
                {...(budgetInvalid && budget !== ''
                  ? { error: `Enter an amount from $0 to $${MAX_USD}.` }
                  : {})}
                hint="Shared by every AI manager, in proportion to difficulty. $0 turns model calls off."
              />
            )}
          </div>

          <div className="space-y-2">
            <h4 className="font-semibold">Overage</h4>
            <SegmentedControl
              aria-label="Overage"
              options={[
                { value: 'off', label: 'Stop at the budget', disabled: !canEdit },
                { value: 'on', label: 'Allow overage', disabled: !canEdit }
              ]}
              value={overageOn ? 'on' : 'off'}
              onChange={(v) => setOverageOn(v === 'on')}
            />
            {overageOn ? (
              <Input
                label="Extra per week (USD)"
                inputMode="decimal"
                value={overage}
                onChange={(e) => setOverage(e.target.value)}
                disabled={!canEdit}
                className="max-w-xs"
                {...(overageInvalid && overage !== ''
                  ? { error: `Enter an amount from $0.01 to $${MAX_USD}.` }
                  : {})}
                hint="Past the budget, AI managers keep using their models until this much more is spent."
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                When the week&apos;s budget is spent, AI managers play on autopilot (optimizer lineups,
                autopicks, no waiver claims) until the week rolls over.
              </p>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <div>
            <h4 className="font-semibold">Models by difficulty</h4>
            <p className="text-sm text-muted-foreground">
              The model each difficulty tries first. If it is unavailable, the difficulty&apos;s usual models
              take over. A manager&apos;s own preferred model (in its Advanced settings) still comes first.
              Prices are estimates per million tokens.
            </p>
          </div>
          <ApiErrorAlert error={catalog.error} />
          {cat !== null && (
            <ul className="divide-y divide-border" aria-label="Models by difficulty">
              {DIFFICULTIES.map((d) => (
                <li key={d} className="space-y-2 py-3 first:pt-0 last:pb-0">
                  <p className="font-medium">
                    {difficultyName(d)}
                    {tierOf(d) !== undefined && (
                      <span className="text-sm font-normal text-muted-foreground"> · {tierOf(d)} tier</span>
                    )}
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select
                      label="Decisions"
                      aria-label={`${difficultyName(d)} decision model`}
                      value={models[d].decision}
                      onChange={(e) => setModel(d, 'decision', e.target.value)}
                      disabled={!canEdit}
                    >
                      <option value="">Difficulty default</option>
                      <ModelOptions models={cat.models} />
                    </Select>
                    <Select
                      label="Chat"
                      aria-label={`${difficultyName(d)} chat model`}
                      value={models[d].chat}
                      onChange={(e) => setModel(d, 'chat', e.target.value)}
                      disabled={!canEdit}
                    >
                      <option value="">Difficulty default</option>
                      <ModelOptions models={cat.models} />
                    </Select>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {mode === 'auto' && anyModel && (
            <p className="text-sm text-muted-foreground" role="note">
              The automatic budget assumes each difficulty&apos;s usual models. If you pick pricier ones, set
              an amount so the budget keeps up.
            </p>
          )}
        </CardBody>
      </Card>

      <ApiErrorAlert error={error} />
      {canEdit && (
        <Button
          onClick={() => void save()}
          disabled={saving || unchanged || budgetInvalid || overageInvalid}
          loading={saving}
        >
          Save AI settings
        </Button>
      )}
    </div>
  );
}
