import { useState } from 'react';
import {
  Card,
  CardBody,
  EmptyState,
  Select,
  StatTile,
  StatusBadge,
  type StatusBadgeTone
} from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { AgentTaskRecord, TeamDetail } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { formatUsd } from '../season/ModelLeaderboardPanel';
import { TableScroll } from '../../components/TableScroll';

const STATUS: Record<AgentTaskRecord['status'], { tone: StatusBadgeTone; label: string }> = {
  completed: { tone: 'success', label: 'Model decided' },
  fallback: { tone: 'warning', label: 'Fallback' },
  failed: { tone: 'error', label: 'Failed' },
  skipped: { tone: 'neutral', label: 'Skipped' }
};

const KIND_LABELS: Record<string, string> = {
  draft_pick: 'Draft pick',
  lineup: 'Lineup',
  waivers: 'Waivers',
  chat_reply: 'Chat reply',
  chat_moment: 'Chat moment',
  trade_response: 'Trade response',
  check_in: 'Check-in'
};

/**
 * The commissioner's AI activity tab (#77): the kill switch, the week's estimated model spend
 * against the league ceiling and each agent's allowance, and the decision log with each task's
 * reasoning summary and tool calls.
 */
export function AiActivityPanel({ leagueId, teams }: { leagueId: string; teams: TeamDetail[] }) {
  const api = useLeagueApi();
  const [teamId, setTeamId] = useState('');
  const loaded = useLoad(
    () => api.getAgentActivity(leagueId, { limit: 50, ...(teamId === '' ? {} : { teamId }) }),
    `${leagueId}:${teamId}`
  );
  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? id ?? 'Removed seat';

  if (loaded.data === null) {
    return loaded.error ? (
      <ApiErrorAlert error={loaded.error} />
    ) : (
      <p className="text-sm text-muted-foreground">Loading AI activity…</p>
    );
  }
  const { tasks, budget, killSwitch } = loaded.data;
  const agentTeams = teams.filter((t) => t.seatType === 'agent');

  return (
    <div className="space-y-6" data-testid="ai-activity">
      <ApiErrorAlert error={loaded.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Kill switch"
          value={!killSwitch.configured ? 'Not set up' : killSwitch.engaged ? 'On' : 'Off'}
          meta={
            killSwitch.engaged
              ? 'Every agent is using deterministic moves (no model calls).'
              : 'Agents may call their models.'
          }
          {...(killSwitch.engaged ? { status: { tone: 'error' as const, label: 'Agents paused' } } : {})}
        />
        <StatTile
          label={`Week ${budget.week} spend`}
          value={`${formatUsd(budget.spentUsd)} of ${formatUsd(budget.ceilingUsd)}`}
          meta={`${formatUsd(budget.remainingUsd)} left · estimates, not billing`}
          {...(budget.exceeded ? { status: { tone: 'warning' as const, label: 'Over budget' } } : {})}
        />
        <StatTile label="Tasks shown" value={String(tasks.length)} meta="Newest first" />
      </div>
      {budget.exceeded && (
        <p className="text-sm text-muted-foreground" role="status">
          This league reached its weekly model budget. Agents use deterministic fallbacks (the lineup
          optimizer, autopick, no waiver claims) until the week rolls over.
        </p>
      )}

      <section aria-labelledby="agent-spend-title" className="space-y-2">
        <h4 id="agent-spend-title" className="font-semibold">
          Spend by agent
        </h4>
        <TableScroll label="Spend by agent">
          <table className="w-full text-sm" aria-label="Spend by agent">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col">Team</th>
                <th scope="col">Spent</th>
                <th scope="col">Allowance</th>
                <th scope="col">Tasks</th>
              </tr>
            </thead>
            <tbody>
              {budget.byAgent.map((a) => (
                <tr key={a.agentId}>
                  <td>{teamName(a.teamId)}</td>
                  <td>{formatUsd(a.costUsd)}</td>
                  <td>{formatUsd(a.allowanceUsd)}</td>
                  <td>{a.tasks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </section>

      <section aria-labelledby="decision-log-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h4 id="decision-log-title" className="font-semibold">
            Decision log
          </h4>
          <Select
            label="Filter by team"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            className="max-w-xs"
          >
            <option value="">All agents</option>
            {agentTeams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
        {tasks.length === 0 ? (
          <EmptyState
            title="No agent activity yet"
            description="Agents act on league events: draft turns, waivers, lineups, and chat."
          />
        ) : (
          <ul className="space-y-3" aria-label="Agent decisions">
            {tasks.map((task) => (
              <li key={task.taskId}>
                <Card>
                  <CardBody className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{teamName(task.teamId)}</span>
                      <span className="text-sm text-muted-foreground">
                        {KIND_LABELS[task.kind] ?? task.kind} · {task.trigger.detailType}
                      </span>
                      <StatusBadge tone={STATUS[task.status].tone}>{STATUS[task.status].label}</StatusBadge>
                      {task.fallbackReason !== null && (
                        <span className="text-xs text-muted-foreground">
                          ({task.fallbackReason.replace(/_/g, ' ')})
                        </span>
                      )}
                    </div>
                    <p className="text-sm">{task.reasoningSummary}</p>
                    {task.errorDetail !== undefined && (
                      <p className="text-xs text-error-700 break-words">Model error: {task.errorDetail}</p>
                    )}
                    {task.toolsCalled.some((c) => !c.ok) && (
                      <p className="text-xs text-error-700">
                        Failed tool call(s):{' '}
                        {task.toolsCalled
                          .filter((c) => !c.ok)
                          .map((c) => `${c.name} (${c.errorCode ?? 'error'})`)
                          .join(', ')}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {task.finalAction} · {task.toolsCalled.length} tool call(s)
                      {task.toolsCalled.length > 0 &&
                        `: ${task.toolsCalled.map((c) => c.name).join(', ')}`} · {formatUsd(task.costUsd)} ·{' '}
                      {(task.latencyMs / 1000).toFixed(1)}s · {new Date(task.startedAt).toLocaleString()}
                    </p>
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
