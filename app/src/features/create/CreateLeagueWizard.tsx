import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  Card,
  CardBody,
  Input,
  LoadingPage,
  ProgressIndicator,
  SegmentedControl,
  Select,
  useToast,
  type ProgressStepStatus
} from '@readysetcloud/ui';
import { useAuth } from '@readysetcloud/ui/auth';
import { useLeagueApi } from '../../api/league';
import type { AgentCatalog, AgentSeatConfig, ScoringPreset } from '../../api/types';
import { ApiErrorAlert, errorText } from '../../components/ApiErrorAlert';
import { displayName } from '../../layout/AppLayout';
import { useLoad } from '../../lib/useLoad';
import { shufflePersonality } from '../agents/agentConfig';
import { AgentGrid } from '../agents/AgentGrid';

export const TEAM_COUNTS = [4, 6, 8, 10, 12] as const;
const DEFAULT_TEAMS = 8;

export const PRESETS: { value: ScoringPreset; label: string }[] = [
  { value: 'yahoo_standard', label: 'Half-PPR' },
  { value: 'full_ppr', label: 'PPR' },
  { value: 'standard', label: 'Standard' }
];

const STEPS = ['League', 'Seats', 'AI managers', 'Review'] as const;

const suggested = (catalog: AgentCatalog): AgentSeatConfig[] => catalog.suggestion?.seats ?? [];

export function CreateLeagueWizard() {
  const api = useLeagueApi();
  const catalog = useLoad(() => api.getAgentCatalog({ suggest: DEFAULT_TEAMS - 1 }), 'catalog');
  if (catalog.data === null) {
    return catalog.error ? (
      <ApiErrorAlert error={catalog.error} />
    ) : (
      <LoadingPage text="Loading AI managers…" />
    );
  }
  return <Wizard catalog={catalog.data} />;
}

function Wizard({ catalog }: { catalog: AgentCatalog }) {
  const api = useLeagueApi();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(() => `${displayName(user) ?? 'My'}'s League`);
  const [teamCount, setTeamCount] = useState<number>(DEFAULT_TEAMS);
  const [preset, setPreset] = useState<ScoringPreset>('yahoo_standard');
  const [humanSeats, setHumanSeats] = useState(1);
  const [agents, setAgents] = useState<AgentSeatConfig[]>(() => suggested(catalog));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const agentCount = teamCount - humanSeats;

  /** Runs `work` with the buttons disabled; false (with the error shown) when it fails. */
  const run = async (work: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const randomize = () =>
    run(async () => {
      setAgents(suggested(await api.getAgentCatalog({ suggest: agentCount })));
    });

  const next = async () => {
    if (step === 1 && agents.length !== agentCount) {
      if (agentCount === 0) setAgents([]);
      else if (!(await randomize())) return;
    }
    setStep((s) => s + 1);
  };

  const create = () =>
    run(async () => {
      const league = await api.createLeague({ name: name.trim(), teamCount, preset });
      try {
        const seats = [...league.teams].sort((a, b) => a.draftSlot - b.draftSlot);
        await Promise.all(
          seats.slice(1, humanSeats).map((team) => api.setSeatType(league.id, team.id, 'human'))
        );
        await Promise.all(
          seats
            .slice(humanSeats)
            .map((team, i) => api.configureAgentSeat(league.id, team.id, agents[i] as AgentSeatConfig))
        );
        toast(`${league.name} is ready.`, { variant: 'success' });
      } catch (e) {
        toast(`${league.name} was created, but a seat could not be set up: ${errorText(e).message}`, {
          variant: 'warning'
        });
      }
      navigate(`/leagues/${league.id}/settings`);
    });

  const status = (i: number): ProgressStepStatus =>
    i < step ? 'completed' : i === step ? 'in-progress' : 'pending';
  const nameMissing = name.trim() === '';

  return (
    <section aria-labelledby="create-title" className="space-y-6">
      <h1 id="create-title" className="text-2xl font-semibold">
        Create League
      </h1>
      <ProgressIndicator steps={STEPS.map((label, i) => ({ id: label, label, status: status(i) }))} />
      <ApiErrorAlert error={error} />
      <Card className="min-w-0">
        <CardBody className="space-y-4">
          <h2 className="text-xl font-semibold">{STEPS[step]}</h2>
          {step === 0 && (
            <>
              <Input
                label="League name"
                value={name}
                maxLength={60}
                error={nameMissing ? 'Give the league a name.' : undefined}
                onChange={(e) => setName(e.target.value)}
              />
              <Select
                label="Teams"
                value={teamCount}
                onChange={(e) => {
                  const count = Number(e.target.value);
                  setTeamCount(count);
                  setHumanSeats((h) => Math.min(h, count));
                }}
              >
                {TEAM_COUNTS.map((n) => (
                  <option key={n} value={n}>
                    {n} teams
                  </option>
                ))}
              </Select>
              <div className="space-y-1">
                <p className="text-sm font-medium">Scoring</p>
                <SegmentedControl
                  className="flex-wrap"
                  aria-label="Scoring"
                  options={PRESETS}
                  value={preset}
                  onChange={setPreset}
                />
              </div>
            </>
          )}
          {step === 1 && (
            <>
              <Select
                label="Human seats"
                hint="You hold the first one. Invite people to the others once the league exists."
                value={humanSeats}
                onChange={(e) => setHumanSeats(Number(e.target.value))}
              >
                {Array.from({ length: teamCount }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? '1 (just you)' : n}
                  </option>
                ))}
              </Select>
              <p className="text-sm text-muted-foreground" data-testid="seat-split">
                {humanSeats} human, {agentCount} AI
              </p>
            </>
          )}
          {step === 2 &&
            (agentCount === 0 ? (
              <p className="text-muted-foreground">
                Every seat is for a person, so there are no AI managers.
              </p>
            ) : (
              <AgentGrid
                catalog={catalog}
                busy={busy}
                seats={agents.map((config, i) => ({
                  key: String(i),
                  label: `Seat ${humanSeats + i + 1}`,
                  config
                }))}
                editor={{
                  onChange: (index, config) =>
                    setAgents((all) => all.map((c, i) => (i === index ? config : c))),
                  onShuffle: (index) =>
                    setAgents((all) =>
                      all.map((c, i) => (i === index ? shufflePersonality(all, i, catalog) : c))
                    ),
                  onRandomizeAll: () => void randomize(),
                  onDifficultyAll: (difficulty) => setAgents((all) => all.map((c) => ({ ...c, difficulty })))
                }}
              />
            ))}
          {step === 3 && (
            <dl
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 break-words"
              data-testid="review"
            >
              <dt className="text-muted-foreground">Name</dt>
              <dd>{name.trim()}</dd>
              <dt className="text-muted-foreground">Teams</dt>
              <dd>{teamCount}</dd>
              <dt className="text-muted-foreground">Scoring</dt>
              <dd>{PRESETS.find((p) => p.value === preset)?.label}</dd>
              <dt className="text-muted-foreground">Seats</dt>
              <dd>
                {humanSeats} human, {agentCount} AI
              </dd>
              <dt className="text-muted-foreground">AI managers</dt>
              <dd>
                {agents.length === 0
                  ? 'None'
                  : agents
                      .map((a) => {
                        const p = catalog.personalities.find((x) => x.id === a.personalityId);
                        const d = catalog.difficulties.find((x) => x.id === a.difficulty);
                        return `${p?.displayName ?? a.personalityId} (${d?.displayName ?? a.difficulty})`;
                      })
                      .join(', ')}
              </dd>
            </dl>
          )}
          {/* On a phone the step can run long (a card per AI seat): Back and Next stay pinned. */}
          <div
            data-testid="wizard-actions"
            className="sticky bottom-0 z-10 -mx-[1.125rem] -mb-[1.125rem] flex justify-between gap-2 rounded-b-lg border-t border-border bg-surface px-[1.125rem] pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:static sm:m-0 sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0 sm:pt-2"
          >
            <Button variant="ghost" disabled={step === 0 || busy} onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button variant="primary" disabled={nameMissing || busy} onClick={() => void next()}>
                Next
              </Button>
            ) : (
              <Button variant="primary" loading={busy} loadingLabel="Creating…" onClick={() => void create()}>
                Create league
              </Button>
            )}
          </div>
        </CardBody>
      </Card>
    </section>
  );
}
