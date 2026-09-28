import { useState } from 'react';
import { EmptyState, Select, StatusBadge } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { AgentCatalog, AgentSeatConfig, AgentSeatRevision, TeamDetail } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';

type Field = 'personality' | 'difficulty' | 'strategy' | 'model';

const FIELD_LABELS: Record<Field, string> = {
  personality: 'Personality',
  difficulty: 'Difficulty',
  strategy: 'Strategy',
  model: 'Model'
};

/** A config's fields by display name, from the agent catalog (ids when the catalog lacks one). */
export function describeSeat(config: AgentSeatConfig, catalog: AgentCatalog): Record<Field, string> {
  const name = (list: { id?: string; key?: string; displayName: string }[], id: string) =>
    list.find((x) => (x.id ?? x.key) === id)?.displayName ?? id;
  const override = config.advanced?.modelOverride;
  return {
    personality: name(catalog.personalities, config.personalityId),
    difficulty: name(catalog.difficulties, config.difficulty),
    strategy: name(catalog.archetypes, config.archetype),
    model: override === undefined ? 'Difficulty default' : name(catalog.models, override)
  };
}

/** What changed from `previous` to `next`, e.g. "Difficulty: Pro → Rookie". */
export function seatChanges(
  next: AgentSeatConfig,
  previous: AgentSeatConfig | undefined,
  catalog: AgentCatalog
): string[] {
  if (previous === undefined) return ['First version'];
  const after = describeSeat(next, catalog);
  const before = describeSeat(previous, catalog);
  const changes = (Object.keys(FIELD_LABELS) as Field[])
    .filter((f) => after[f] !== before[f])
    .map((f) => `${FIELD_LABELS[f]}: ${before[f]} → ${after[f]}`);
  const tuned =
    JSON.stringify(next.advanced?.levers ?? null) !== JSON.stringify(previous.advanced?.levers ?? null) ||
    (next.advanced?.customFlavor ?? '') !== (previous.advanced?.customFlavor ?? '');
  if (tuned) changes.push('Advanced levers or flavor changed');
  return changes.length === 0 ? ['Saved with no changes'] : changes;
}

const who = (principal: string) => principal.replace(/^user#/, '');

/**
 * Each agent seat's version history (#77), in the commissioner's AI activity tab: every saved
 * config, newest first, with what changed and who changed it.
 */
export function SeatHistoryPanel({ leagueId, teams }: { leagueId: string; teams: TeamDetail[] }) {
  const api = useLeagueApi();
  const agentTeams = teams.filter((t) => t.seatType === 'agent');
  const [teamId, setTeamId] = useState(agentTeams[0]?.id ?? '');
  const loaded = useLoad(async () => {
    if (teamId === '') return null;
    const [seat, catalog] = await Promise.all([api.getAgentSeat(leagueId, teamId), api.getAgentCatalog()]);
    return { history: seat.commissioner?.history ?? [], catalog };
  }, `${leagueId}:${teamId}`);

  if (agentTeams.length === 0) {
    return <EmptyState title="No agent seats" description="Seat an AI manager to see its config history." />;
  }
  return (
    <div className="space-y-3" data-testid="seat-history">
      <Select
        label="Agent seat"
        value={teamId}
        onChange={(e) => setTeamId(e.target.value)}
        className="max-w-xs"
      >
        {agentTeams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Select>
      <ApiErrorAlert error={loaded.error} />
      {loaded.data === null ? (
        loaded.error ? null : (
          <p className="text-sm text-muted-foreground">Loading seat history…</p>
        )
      ) : loaded.data.history.length === 0 ? (
        <p className="text-sm text-muted-foreground">This seat has no saved config yet.</p>
      ) : (
        <HistoryTable history={loaded.data.history} catalog={loaded.data.catalog} />
      )}
    </div>
  );
}

function HistoryTable({ history, catalog }: { history: AgentSeatRevision[]; catalog: AgentCatalog }) {
  const newest = Math.max(...history.map((h) => h.version));
  return (
    <table className="w-full text-sm" aria-label="Seat version history">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th scope="col">Version</th>
          <th scope="col">Saved</th>
          <th scope="col">By</th>
          <th scope="col">Config</th>
          <th scope="col">Changes</th>
        </tr>
      </thead>
      <tbody>
        {history.map((revision, i) => {
          const seat = describeSeat(revision.config, catalog);
          return (
            <tr key={revision.version}>
              <td>
                v{revision.version}{' '}
                {revision.version === newest && <StatusBadge tone="success">Current</StatusBadge>}
              </td>
              <td>{new Date(revision.updatedAt).toLocaleString()}</td>
              <td>{who(revision.updatedBy)}</td>
              <td>
                {seat.personality} · {seat.difficulty} · {seat.strategy} · {seat.model}
              </td>
              <td>{seatChanges(revision.config, history[i + 1]?.config, catalog).join('; ')}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
