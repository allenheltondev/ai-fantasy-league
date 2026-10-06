import { useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Card, CardBody, LoadingPage, SegmentedControl, StatusBadge, useToast } from '@readysetcloud/ui';
import { useLeagueApi, type LeagueApi } from '../../api/league';
import type { LeagueDetail } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { DraftPage } from '../../draft/DraftPage';
import { useLoad } from '../../lib/useLoad';
import { PHASE_LABELS } from '../leagues/MyLeaguesPage';
import { HistoryPanel } from '../season/HistoryPanel';
import { AgentManagers } from './AgentManagers';
import { AiActivityPanel } from './AiActivityPanel';
import { AiControlsPanel } from './AiControlsPanel';
import { DataStatusPanel } from './DataStatusPanel';
import { DraftSchedulePanel } from './DraftSchedulePanel';
import { InvitesPanel } from './InvitesPanel';
import { RulesEditor } from './RulesEditor';
import { SeatHistoryPanel } from './SeatHistoryPanel';
import { draftIsLive } from '../../routes/leagueRoutes';
import { inferPreset } from './rules';
import { SeatManager } from './SeatManager';

async function loadSettings(api: LeagueApi, leagueId: string) {
  const [state, league] = await Promise.all([api.getLeagueState(leagueId), api.getLeague(leagueId)]);
  const defaults = await api.getDefaultSettings({
    teamCount: league.settings.teamCount,
    preset: inferPreset(league.settings),
    startWeek: league.settings.schedule.startWeek as number
  });
  return { state, league, defaults };
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3">
      <h3 id={`${id}-title`} className="text-lg font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Agent seats nobody holds: the seats an AI plays. */
export function aiSeats(league: LeagueDetail) {
  return league.teams
    .filter((t) => t.seatType === 'agent' && t.open)
    .sort((a, b) => a.draftSlot - b.draftSlot);
}

type View = 'league' | 'history' | 'draft' | 'ai' | 'data';

/**
 * The league's Settings section (League info for everyone but the commissioner): seats, AI
 * managers, invites, and the rules, with the league's history and, once the draft is over, its
 * results, and (commissioner) AI activity and data status. The view is `?view=`.
 */
export function SettingsPage() {
  const { leagueId = '' } = useParams();
  const api = useLeagueApi();
  const { toast } = useToast();
  const loaded = useLoad(() => loadSettings(api, leagueId), leagueId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [params, setParams] = useSearchParams();

  if (loaded.data === null) {
    return loaded.error ? <ApiErrorAlert error={loaded.error} /> : <LoadingPage text="Loading settings…" />;
  }
  const { state, league, defaults } = loaded.data;
  const can = (action: string) => state.allowedActions.includes(action);
  const act = (work: (api: LeagueApi) => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    work(api).then(
      () => {
        toast(success, { variant: 'success' });
        setBusy(false);
        loaded.reload();
      },
      (e: unknown) => {
        setError(e);
        setBusy(false);
      }
    );
  };
  const commissioner = state.youAreCommissioner;
  const drafted = !draftIsLive(league.phase);
  const requested = params.get('view');
  const tab: View =
    requested === 'history' ||
    (requested === 'draft' && drafted) ||
    (commissioner && (requested === 'ai' || requested === 'data'))
      ? requested
      : 'league';
  const setTab = (view: View) => setParams(view === 'league' ? {} : { view });
  const phase = PHASE_LABELS[league.phase];
  const agents = aiSeats(league);

  return (
    <div data-testid="league-section-settings" className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge tone={phase.tone}>{phase.label}</StatusBadge>
        {state.youAreCommissioner && (
          <span className="text-sm text-muted-foreground">You are the commissioner</span>
        )}
      </div>
      <SegmentedControl
        aria-label="Settings view"
        options={
          [
            { value: 'league', label: commissioner ? 'League settings' : 'Rules & seats' },
            { value: 'history', label: 'History' },
            ...(drafted ? [{ value: 'draft', label: 'Draft results' }] : []),
            ...(commissioner
              ? [
                  { value: 'ai', label: 'AI activity' },
                  { value: 'data', label: 'Data status' }
                ]
              : [])
          ] as { value: View; label: string }[]
        }
        value={tab}
        onChange={setTab}
      />
      {tab === 'history' ? (
        <HistoryPanel />
      ) : tab === 'draft' ? (
        <DraftPage />
      ) : commissioner && tab === 'data' ? (
        <Section id="data-status" title="Data status">
          <DataStatusPanel leagueId={league.id} />
        </Section>
      ) : commissioner && tab === 'ai' ? (
        <>
          <Section id="ai-controls" title="AI budget & models">
            <AiControlsPanel
              key={league.version}
              league={league}
              canEdit={can('update_league_settings')}
              onSaved={loaded.reload}
            />
          </Section>
          <Section id="ai-activity" title="AI activity">
            <AiActivityPanel leagueId={league.id} teams={league.teams} refreshKey={league.version} />
          </Section>
          <Section id="seat-history" title="Seat version history">
            <SeatHistoryPanel leagueId={league.id} teams={league.teams} />
          </Section>
        </>
      ) : (
        <>
          <ApiErrorAlert error={error} />
          <Section id="seats" title="Seats">
            <Card>
              <CardBody>
                <SeatManager league={league} state={state} can={can} act={act} busy={busy} />
              </CardBody>
            </Card>
          </Section>
          {agents.length > 0 && (
            <Section id="agents" title="AI managers">
              <AgentManagers
                leagueId={league.id}
                teams={agents}
                canConfigure={can('configure_agent_seat')}
                canNameTeams={state.youAreCommissioner && can('configure_agent_seat')}
              />
            </Section>
          )}
          {state.youAreCommissioner && (can('create_invite') || can('create_takeover_invite')) && (
            <Section id="invites" title="Invites">
              <Card>
                <CardBody>
                  <InvitesPanel
                    leagueId={league.id}
                    teams={league.teams}
                    openHumanSeats={league.teams.filter((t) => t.open && t.seatType === 'human').length}
                    canCreate={can('create_invite')}
                    canTakeover={can('create_takeover_invite')}
                    canRevoke={can('revoke_invite')}
                  />
                </CardBody>
              </Card>
            </Section>
          )}
          {league.phase === 'setup' && (
            <Section id="draft-time" title="Draft time">
              <Card>
                <CardBody>
                  <DraftSchedulePanel
                    key={league.version}
                    league={league}
                    canEdit={state.youAreCommissioner && can('update_league_settings')}
                    onSaved={loaded.reload}
                  />
                </CardBody>
              </Card>
            </Section>
          )}
          <Section id="rules" title="Rules">
            <RulesEditor
              key={league.version}
              league={league}
              defaults={defaults}
              canEdit={can('update_league_settings')}
              onSaved={loaded.reload}
            />
          </Section>
        </>
      )}
    </div>
  );
}
