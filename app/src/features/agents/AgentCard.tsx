import { useState } from 'react';
import { Button, Card, CardBody, Drawer, Input, Select, StatusBadge, TextArea } from '@readysetcloud/ui';
import type { AgentCatalog, AgentLevers, AgentSeatConfig } from '../../api/types';
import { AgentAvatar } from '../../components/AgentAvatar';
import { difficultyTone, withAdvanced } from './agentConfig';

export interface AgentCardProps {
  /** Which seat this is, e.g. "Seat 3". */
  seatLabel: string;
  config: AgentSeatConfig;
  catalog: AgentCatalog;
  /** Leave out for a read-only card. */
  onChange?: (config: AgentSeatConfig) => void;
  onShuffle?: () => void;
  busy?: boolean;
}

/** One AI manager: who it is, how good it is, and the controls to change either. */
export function AgentCard({ seatLabel, config, catalog, onChange, onShuffle, busy = false }: AgentCardProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const personality = catalog.personalities.find((p) => p.id === config.personalityId);
  const difficulty = catalog.difficulties.find((d) => d.id === config.difficulty);
  const archetype = catalog.archetypes.find((a) => a.id === config.archetype);
  const name = personality?.displayName ?? config.personalityId;

  return (
    <Card data-testid="agent-card" aria-label={`${seatLabel}: ${name}`}>
      <CardBody className="space-y-3">
        <div className="flex items-start gap-3">
          <AgentAvatar seed={personality?.avatarSeed ?? config.personalityId} label={`${name} avatar`} />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{seatLabel}</p>
            <h3 className="font-display text-lg font-semibold leading-tight">{name}</h3>
            <p className="truncate text-sm text-muted-foreground" title={personality?.bio}>
              {personality?.bio}
            </p>
          </div>
          <StatusBadge tone={difficultyTone(catalog, config.difficulty)} data-testid="difficulty-pill">
            {difficulty?.displayName ?? config.difficulty}
          </StatusBadge>
        </div>
        {archetype && (
          <p className="text-sm">
            <span className="text-muted-foreground">Strategy:</span> {archetype.displayName}
          </p>
        )}
        {onChange && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-40 flex-1">
              <Select
                label="Difficulty"
                value={config.difficulty}
                disabled={busy}
                onChange={(e) => onChange({ ...config, difficulty: e.target.value })}
              >
                {catalog.difficulties.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.displayName}
                  </option>
                ))}
              </Select>
            </div>
            <Button variant="secondary" size="sm" disabled={busy} onClick={onShuffle}>
              Shuffle
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAdvancedOpen(true)}>
              Advanced
            </Button>
          </div>
        )}
      </CardBody>
      {onChange && advancedOpen && (
        <AdvancedDrawer
          title={`${name}: advanced`}
          config={config}
          catalog={catalog}
          onClose={() => setAdvancedOpen(false)}
          onApply={(next) => {
            onChange(next);
            setAdvancedOpen(false);
          }}
        />
      )}
    </Card>
  );
}

const NUMERIC_LEVERS = [
  { key: 'maxToolSteps', label: 'Max tool steps per task', min: 1, max: 40, step: 1 },
  { key: 'actionsPerTrigger', label: 'Actions per trigger', min: 1, max: 10, step: 1 },
  { key: 'cooldownMinutes', label: 'Cooldown (minutes)', min: 0, max: 1440, step: 1 },
  { key: 'negotiationRounds', label: 'Counter-offers per trade', min: 0, max: 10, step: 1 },
  { key: 'valuationNoise', label: 'Valuation noise (0-0.5)', min: 0, max: 0.5, step: 0.01 }
] as const;

const RESEARCH = [
  { key: 'projections', label: 'Projections' },
  { key: 'news', label: 'News' },
  { key: 'trending', label: 'Trending players' },
  { key: 'matchupOutlook', label: 'Matchup outlook' }
] as const;

type TriState = '' | 'on' | 'off';

function AdvancedDrawer({
  title,
  config,
  catalog,
  onClose,
  onApply
}: {
  title: string;
  config: AgentSeatConfig;
  catalog: AgentCatalog;
  onClose: () => void;
  onApply: (config: AgentSeatConfig) => void;
}) {
  const [archetype, setArchetype] = useState(config.archetype);
  const [modelOverride, setModelOverride] = useState(config.advanced?.modelOverride ?? '');
  const [flavor, setFlavor] = useState(config.advanced?.customFlavor ?? '');
  const [levers, setLevers] = useState<AgentLevers>(config.advanced?.levers ?? {});
  const setLever = (key: keyof AgentLevers, value: unknown) => setLevers((l) => ({ ...l, [key]: value }));
  const research = levers.research ?? {};
  const researchState = (key: string): TriState => {
    const value = research[key as keyof typeof research];
    return value === undefined ? '' : value ? 'on' : 'off';
  };
  const setResearch = (key: string, value: TriState) => {
    const next: Record<string, boolean> = { ...research };
    if (value === '') delete next[key];
    else next[key] = value === 'on';
    setLever('research', next);
  };

  return (
    <Drawer
      open
      modal
      hideTab
      title={title}
      titleAs="h3"
      size="26rem"
      onOpenChange={(open) => !open && onClose()}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          onApply(withAdvanced({ ...config, archetype }, { modelOverride, customFlavor: flavor, levers }));
        }}
      >
        <Select label="Strategy" value={archetype} onChange={(e) => setArchetype(e.target.value)}>
          {catalog.archetypes.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}: {a.description}
            </option>
          ))}
        </Select>
        <Select
          label="Decision model tier"
          hint="Overrides the tier the difficulty picks."
          value={levers.decisionModelTier ?? ''}
          onChange={(e) => setLever('decisionModelTier', e.target.value || undefined)}
        >
          <option value="">Difficulty default</option>
          {catalog.modelTiers.map((tier) => (
            <option key={tier} value={tier}>
              {tier}
            </option>
          ))}
        </Select>
        <Select
          label="Chat model tier"
          value={levers.chatModelTier ?? ''}
          onChange={(e) => setLever('chatModelTier', e.target.value || undefined)}
        >
          <option value="">Difficulty default</option>
          {catalog.modelTiers.map((tier) => (
            <option key={tier} value={tier}>
              {tier}
            </option>
          ))}
        </Select>
        <Select
          label="Preferred model"
          hint="Tried first for decisions, ahead of the tier's models."
          value={modelOverride}
          onChange={(e) => setModelOverride(e.target.value)}
        >
          <option value="">Tier default</option>
          {catalog.models.map((m) => (
            <option key={m.key} value={m.key}>
              {m.displayName} ({m.tier})
            </option>
          ))}
        </Select>
        <Select
          label="Reasoning effort"
          value={levers.reasoningEffort ?? ''}
          onChange={(e) => setLever('reasoningEffort', e.target.value || undefined)}
        >
          <option value="">Difficulty default</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </Select>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Research</legend>
          {RESEARCH.map((r) => (
            <Select
              key={r.key}
              label={r.label}
              value={researchState(r.key)}
              onChange={(e) => setResearch(r.key, e.target.value as TriState)}
            >
              <option value="">Difficulty default</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </Select>
          ))}
        </fieldset>
        {NUMERIC_LEVERS.map((lever) => (
          <Input
            key={lever.key}
            type="number"
            label={lever.label}
            placeholder="Difficulty default"
            min={lever.min}
            max={lever.max}
            step={lever.step}
            value={levers[lever.key] ?? ''}
            onChange={(e) => setLever(lever.key, e.target.value === '' ? undefined : Number(e.target.value))}
          />
        ))}
        <TextArea
          label="Extra personality flavor"
          hint="Up to 280 characters."
          maxLength={280}
          value={flavor}
          onChange={(e) => setFlavor(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Apply
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
