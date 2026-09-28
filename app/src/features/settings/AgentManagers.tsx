import { useEffect, useState } from 'react';
import { Button, LoadingPage, useToast } from '@readysetcloud/ui';
import { ApiError } from '../../api/client';
import { useLeagueApi, type LeagueApi } from '../../api/league';
import type { AgentCatalog, AgentSeatConfig, AgentSeatView, TeamDetail } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { shufflePersonality } from '../agents/agentConfig';
import { AgentGrid } from '../agents/AgentGrid';

interface Seat {
  team: TeamDetail;
  config: AgentSeatConfig | null;
}

/**
 * The config a seat shows: the commissioner's full config, or the public persona for everyone else,
 * with the manager's name and avatar (#159) filled in from the seat when the config has none yet.
 */
export function seatConfig(view: AgentSeatView): AgentSeatConfig {
  const config = view.commissioner?.current.config ?? {
    personalityId: view.seat.personality.id,
    difficulty: view.seat.difficulty.id,
    archetype: ''
  };
  const manager = view.seat.manager;
  if (manager === undefined) return config;
  return {
    ...config,
    name: config.name ?? manager.name,
    avatarSeed: config.avatarSeed ?? manager.avatarSeed
  };
}

async function loadSeats(api: LeagueApi, leagueId: string, teams: TeamDetail[]) {
  const [catalog, seats] = await Promise.all([
    api.getAgentCatalog(),
    Promise.all(
      teams.map(async (team): Promise<Seat> => {
        try {
          return { team, config: seatConfig(await api.getAgentSeat(leagueId, team.id)) };
        } catch (e) {
          if (e instanceof ApiError && e.code === 'NOT_FOUND') return { team, config: null };
          throw e;
        }
      })
    )
  ]);
  return { catalog, seats };
}

export interface AgentManagersProps {
  leagueId: string;
  /** The seats an AI plays: agent seats nobody holds. */
  teams: TeamDetail[];
  /** True when configure_agent_seat is in allowedActions. */
  canConfigure: boolean;
}

/** The league's AI managers as cards; the commissioner can change them until the draft. */
export function AgentManagers({ leagueId, teams, canConfigure }: AgentManagersProps) {
  const api = useLeagueApi();
  const key = `${leagueId}:${teams.map((t) => t.id).join(',')}`;
  const loaded = useLoad(() => loadSeats(api, leagueId, teams), key);
  if (loaded.data === null) {
    return loaded.error ? (
      <ApiErrorAlert error={loaded.error} />
    ) : (
      <LoadingPage text="Loading AI managers…" />
    );
  }
  return (
    <SeatCards
      key={key}
      leagueId={leagueId}
      catalog={loaded.data.catalog}
      initial={loaded.data.seats}
      canConfigure={canConfigure}
      refreshing={loaded.loading}
      reload={loaded.reload}
    />
  );
}

function SeatCards({
  leagueId,
  catalog,
  initial,
  canConfigure,
  refreshing,
  reload
}: {
  leagueId: string;
  catalog: AgentCatalog;
  initial: Seat[];
  canConfigure: boolean;
  /** A reload is in flight: hold edits until it lands so it cannot overwrite them. */
  refreshing: boolean;
  reload: () => void;
}) {
  const api = useLeagueApi();
  const { toast } = useToast();
  const [seats, setSeats] = useState(initial);
  useEffect(() => setSeats(initial), [initial]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const busy = saving || refreshing;
  const configured = seats.filter((s): s is Seat & { config: AgentSeatConfig } => s.config !== null);
  const unconfigured = seats.filter((s) => s.config === null);

  const run = async (work: () => Promise<void>) => {
    setSaving(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  /** Saves new configs for some seats, then shows them. */
  const save = (changes: { teamId: string; config: AgentSeatConfig }[]) =>
    run(async () => {
      await Promise.all(changes.map((c) => api.configureAgentSeat(leagueId, c.teamId, c.config)));
      setSeats((all) =>
        all.map((s) => ({ ...s, config: changes.find((c) => c.teamId === s.team.id)?.config ?? s.config }))
      );
    });

  const randomizeAll = () =>
    run(async () => {
      await api.randomizeAgentSeats(
        leagueId,
        seats.map((s) => s.team.id)
      );
      toast('AI managers randomized.', { variant: 'success' });
      reload();
    });

  const configs = configured.map((s) => s.config);
  return (
    <div className="space-y-4">
      <ApiErrorAlert error={error} />
      {unconfigured.length > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="unconfigured-seats">
          No AI manager picked yet for {unconfigured.map((s) => s.team.name).join(', ')}.
          {canConfigure && ' Randomize to fill them.'}
        </p>
      )}
      {configured.length === 0 && canConfigure ? (
        <Button variant="secondary" loading={busy} onClick={() => void randomizeAll()}>
          Randomize all
        </Button>
      ) : (
        <AgentGrid
          catalog={catalog}
          busy={busy}
          seats={configured.map((s) => ({ key: s.team.id, label: s.team.name, config: s.config }))}
          {...(canConfigure
            ? {
                editor: {
                  onChange: (index, config) => void save([{ teamId: configured[index]!.team.id, config }]),
                  onShuffle: (index) =>
                    void save([
                      {
                        teamId: configured[index]!.team.id,
                        config: shufflePersonality(configs, index, catalog)
                      }
                    ]),
                  onRandomizeAll: () => void randomizeAll(),
                  onDifficultyAll: (difficulty) =>
                    void save(
                      configured.map((s) => ({ teamId: s.team.id, config: { ...s.config, difficulty } }))
                    )
                }
              }
            : {})}
        />
      )}
    </div>
  );
}
