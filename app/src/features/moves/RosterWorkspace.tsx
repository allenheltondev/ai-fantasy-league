import { useCallback, useState, useSyncExternalStore } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Button, Drawer, EmptyState, useToast } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type {
  ClaimResult,
  LeagueState,
  MarketPage,
  MarketPlayer,
  Roster,
  RosterEntry
} from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';
import { useLoad } from '../../lib/useLoad';
import { LoadingSkeleton } from '../../motion/decor';
import { useLeagueOutlet } from '../../routes/leagueContext';
import { teamPath } from '../../routes/leagueRoutes';
import { Transactions } from '../players/Transactions';
import { AddPlayerSheet } from './AddPlayerSheet';
import { FaabExplainer } from './FaabExplainer';
import { MovesHelp } from '../help/PageHelp';
import { rosterNeeds, waiverTime, type RosterNeed } from './moves';
import { PlayerMarket } from './PlayerMarket';
import { RosterPanel } from './RosterPanel';

const WIDE = '(min-width: 1024px)';
const NO_PAGE: Promise<MarketPage | null> = Promise.resolve(null);

function subscribeWide(onChange: () => void): () => void {
  const list = window.matchMedia(WIDE);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

/** True on a desktop-wide screen, where the roster and the market sit side by side. */
export function useWideLayout(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches);
}

/** Trades with one of your players, or another team's, picked. */
export function tradeLink(
  leagueId: string,
  give: { playerId: string } | { playerId: string; teamId: string }
) {
  const params = new URLSearchParams(
    'teamId' in give ? { with: give.teamId, receive: give.playerId } : { send: give.playerId }
  );
  return `${teamPath(leagueId, 'trades')}?${params.toString()}`;
}

/** The toast after an add or a claim. */
export function addedMessage(result: ClaimResult, dropName: string | null): string {
  if (result.claim === null)
    return `Added ${result.player.name}${dropName === null ? '' : `, dropped ${dropName}`}.`;
  return `Claim placed for ${result.player.name}: processes ${waiverTime(result.claim.processesAt)}.`;
}

/**
 * My Team › Roster & moves (#205): your roster and the player market in one place. On a desktop the
 * roster sits beside the market, so every add is weighed against who would go; on a phone the
 * market opens as a full-height sheet from a sticky "Add players" button. Adding, claiming,
 * dropping, IR moves, and pending claims all happen here without a page change.
 */
export function RosterWorkspace() {
  const { leagueId = '' } = useParams();
  const outlet = useLeagueOutlet();
  const state = outlet?.state ?? null;
  const team = state?.yourTeam ?? null;
  return (
    <div data-testid="team-page-moves" className="space-y-4">
      {state === null ? (
        <LoadingSkeleton label="Loading your team…" />
      ) : team === null ? (
        <EmptyState title="No team" description="You do not manage a team in this league." />
      ) : (
        <Workspace leagueId={leagueId} teamId={team.id} state={state} />
      )}
    </div>
  );
}

function Workspace({ leagueId, teamId, state }: { leagueId: string; teamId: string; state: LeagueState }) {
  const api = useLeagueApi();
  const { toast } = useToast();
  const wide = useWideLayout();
  const [params, setParams] = useSearchParams();
  const roster = useLoad(() => api.getRoster(leagueId, teamId), `${leagueId}:${teamId}`);
  const claims = useLoad(() => api.listClaims(leagueId), leagueId);
  const [context, setContext] = useState<MarketPage | null>(null);
  // On a phone the market waits in its sheet; read one row for the FAAB and waiver context.
  const phoneContext = useLoad(
    () => (wide ? NO_PAGE : api.listLeaguePlayers(leagueId, { limit: 1 })),
    `${leagueId}:${String(wide)}`
  );
  const [adding, setAdding] = useState<MarketPlayer | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [problem, setProblem] = useState<unknown>(null);
  const allowed = (action: string) => state.allowedActions.includes(action);
  // `?market=RB` (a roster need, a deep link) opens the market on that position.
  const marketPosition = params.get('market');
  const sheetOpen = marketPosition !== null && !wide;
  const teamName = (id: string) => state.teams?.find((t) => t.id === id)?.name ?? 'Another team';

  const refresh = useCallback(
    (message: string) => {
      toast(message, { variant: 'success' });
      roster.reload();
      claims.reload();
      setRefreshKey((k) => k + 1);
    },
    [toast, roster, claims]
  );
  // Each request to find a position counts, even the same one twice (the viewer changed the chip).
  const [findCount, setFindCount] = useState(0);
  const openMarket = (position: string) => {
    setFindCount((n) => n + 1);
    setParams({ market: position }, { replace: false });
  };
  const closeMarket = () => setParams({}, { replace: true });

  const moveToIr = (entry: RosterEntry, data: Roster) => {
    setProblem(null);
    api.setLineup(leagueId, teamId, data.week, [{ playerId: entry.player.id, slot: 'IR' }]).then(
      () => refresh(`Moved ${entry.player.name} to IR.`),
      (e: unknown) => setProblem(e)
    );
  };

  if (roster.data === null) {
    return roster.error ? (
      <ApiErrorAlert error={roster.error} />
    ) : (
      <LoadingSkeleton label="Loading your roster…" rows={8} />
    );
  }
  const data = roster.data;
  const known = context ?? phoneContext.data;
  const waiverType = known?.waiverType ?? 'faab';
  const faab = known?.faabRemaining ?? null;
  const market = (
    <PlayerMarket
      leagueId={leagueId}
      title="Available players"
      titleHidden={!wide}
      position={marketPosition ?? ''}
      positionKey={findCount}
      availableOnly
      teamName={teamName}
      yourTeamId={teamId}
      canAdd={allowed('claim_waiver')}
      canTrade={allowed('propose_trade')}
      refreshKey={refreshKey}
      onContext={setContext}
      tradeHref={(row) =>
        tradeLink(leagueId, { playerId: row.player.id, teamId: row.availability.teamId as string })
      }
      onAdd={(row) => {
        if (!wide) closeMarket();
        setAdding(row);
      }}
    />
  );

  return (
    <>
      {/* A div, not a p: the help panels inside hold headings and lists. */}
      <div className="min-h-5 text-sm text-muted-foreground" data-testid="moves-summary">
        {[
          known == null ? null : waiverType === 'faab' ? `$${faab as number} FAAB left` : 'Rolling waivers',
          allowed('claim_waiver') ? null : 'Adds and claims are closed right now.'
        ]
          .filter((part) => part !== null)
          .join(' · ')}
        {known != null && waiverType === 'faab' && <FaabExplainer remaining={faab} />}
        <MovesHelp waiverType={known == null ? null : waiverType} />
      </div>
      <RosterNeeds
        needs={rosterNeeds(data)}
        onFind={openMarket}
        onIr={(e) => moveToIr(e, data)}
        canIr={allowed('set_lineup')}
      />
      <ApiErrorAlert error={problem} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
        <RosterPanel
          leagueId={leagueId}
          roster={data}
          claims={claims.data ?? []}
          waiverType={waiverType}
          dropClearsAt={known?.dropClearsAt ?? null}
          canDrop={allowed('drop_player')}
          canSetLineup={allowed('set_lineup')}
          canEditClaims={allowed('update_waiver_claim')}
          tradeHref={(entry) => tradeLink(leagueId, { playerId: entry.player.id })}
          onFind={openMarket}
          onChanged={refresh}
        />
        {wide && (
          <div className="rounded-lg border border-border bg-surface p-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            {market}
          </div>
        )}
      </div>
      <Transactions leagueId={leagueId} refreshKey={refreshKey} teamId={teamId} title="Your moves" />
      {!wide && (
        <>
          <div className="sticky bottom-3 z-20 flex justify-center pb-[env(safe-area-inset-bottom)]">
            <Button
              variant="primary"
              className="min-h-12 w-full max-w-md shadow-lg"
              onClick={() => openMarket('')}
            >
              Add players
            </Button>
          </div>
          <Drawer
            open={sheetOpen}
            modal
            hideTab
            side="bottom"
            size="100dvh"
            title="Available players"
            titleAs="h2"
            aria-label="Add players sheet"
            onOpenChange={(open) => !open && closeMarket()}
          >
            {sheetOpen && market}
          </Drawer>
        </>
      )}
      {adding !== null && (
        <AddPlayerSheet
          leagueId={leagueId}
          row={adding}
          roster={data}
          waiverType={waiverType}
          onClose={() => setAdding(null)}
          onDone={(result, dropName) => {
            setAdding(null);
            refresh(addedMessage(result, dropName));
          }}
        />
      )}
    </>
  );
}

/** What the roster needs this week, each with the fix one tap away. */
function RosterNeeds(props: {
  needs: RosterNeed[];
  onFind: (position: string) => void;
  onIr: (entry: RosterEntry) => void;
  canIr: boolean;
}) {
  if (props.needs.length === 0) return null;
  return (
    <section
      aria-label="Roster needs"
      className="rounded-lg border border-warning-500 bg-warning-50 p-3"
      data-testid="roster-needs"
    >
      <h2 className="text-sm font-semibold">This week, your roster needs</h2>
      <ul className="mt-1 divide-y divide-warning-500/30">
        {props.needs.map((need) => (
          <li key={need.key} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
            <span>{need.text}</span>
            {need.toIr !== undefined ? (
              props.canIr && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="min-h-11"
                  onClick={() => props.onIr(need.toIr as RosterEntry)}
                >
                  Move to IR
                </Button>
              )
            ) : (
              <Button
                variant="secondary"
                size="sm"
                className="min-h-11"
                onClick={() => props.onFind(need.find as string)}
              >
                {need.find === '' ? 'Find a player' : `Find ${String(need.find)}`}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
