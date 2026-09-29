import { useCallback, useState } from 'react';
import { useParams } from 'react-router';
import { useToast } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { MarketPage, MarketPlayer, Roster } from '../../api/types';
import { useLoad } from '../../lib/useLoad';
import { useLeagueOutlet } from '../../routes/leagueContext';
import { AddPlayerSheet } from '../moves/AddPlayerSheet';
import { PlayerMarket } from '../moves/PlayerMarket';
import { addedMessage, tradeLink } from '../moves/RosterWorkspace';

const NO_ROSTER: Promise<Roster | null> = Promise.resolve(null);

/**
 * League › Players (#205): the league-wide research view. Every player, rostered ones too, with
 * the market's columns and sorts; free agents and waiver players open the same inline add flow as
 * My Team › Roster & moves, and another team's players offer a trade.
 */
export function PlayersPage() {
  const { leagueId = '' } = useParams();
  const api = useLeagueApi();
  const { toast } = useToast();
  const state = useLeagueOutlet()?.state ?? null;
  const teamId = state?.yourTeam?.id ?? null;
  const roster = useLoad(
    () => (teamId === null ? NO_ROSTER : api.getRoster(leagueId, teamId)),
    `${leagueId}:${teamId}`
  );
  const [context, setContext] = useState<MarketPage | null>(null);
  const [adding, setAdding] = useState<MarketPlayer | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const allowed = (action: string) => state?.allowedActions.includes(action) === true;
  const teams = state?.teams;
  const teamName = useCallback(
    (id: string) => teams?.find((t) => t.id === id)?.name ?? 'Another team',
    [teams]
  );
  // A refresh that reads the same FAAB and waiver type leaves the page (and the market) alone.
  const onContext = useCallback(
    (page: MarketPage) =>
      setContext((current) =>
        current?.faabRemaining === page.faabRemaining &&
        current?.waiverType === page.waiverType &&
        current?.dropClearsAt === page.dropClearsAt
          ? current
          : page
      ),
    []
  );
  const faab = context?.faabRemaining ?? null;

  return (
    <div data-testid="league-section-players" className="space-y-4">
      {faab !== null && (
        <p className="text-sm text-muted-foreground">
          {context?.waiverType === 'rolling' ? 'Rolling waivers' : `$${faab} FAAB left`}
          {!allowed('claim_waiver') && ' · Adds and claims are closed right now.'}
        </p>
      )}
      <PlayerMarket
        leagueId={leagueId}
        title="All players"
        position=""
        availableOnly={false}
        teamName={teamName}
        yourTeamId={teamId}
        canAdd={allowed('claim_waiver') && roster.data !== null}
        canTrade={allowed('propose_trade')}
        refreshKey={refreshKey}
        onContext={onContext}
        tradeHref={(row) =>
          tradeLink(leagueId, { playerId: row.player.id, teamId: row.availability.teamId as string })
        }
        onAdd={setAdding}
      />
      {adding !== null && roster.data !== null && context !== null && (
        <AddPlayerSheet
          leagueId={leagueId}
          row={adding}
          roster={roster.data}
          waiverType={context.waiverType}
          onClose={() => setAdding(null)}
          onDone={(result, dropName) => {
            setAdding(null);
            toast(addedMessage(result, dropName), { variant: 'success' });
            roster.reload();
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
