import { useLeagueApi } from '../../api/league';
import type { MatchupOutlook } from '../../api/types';
import { useLoad } from '../../lib/useLoad';

const percent = (p: number) => `${Math.round(p * 100)}%`;
const pts = (n: number) => n.toFixed(1);

/**
 * The outlook for your matchup (#36, #58): expected final scores, win probability, and lineup advice
 * from get_matchup_outlook. It is extra help on the matchup page, so a failed load shows nothing.
 */
export function MatchupOutlookPanel({ leagueId, pollMs }: { leagueId: string; pollMs?: number }) {
  const api = useLeagueApi();
  const loaded = useLoad(() => api.getMatchupOutlook(leagueId), leagueId, pollMs);
  if (loaded.data === null) return null;
  return <OutlookView outlook={loaded.data} />;
}

export function OutlookView({ outlook }: { outlook: MatchupOutlook }) {
  const { you, opponent, insights } = outlook;
  const advice = [
    ...insights.startersOut.map((s) => ({
      key: `out-${s.player.id}`,
      text: `${s.player.name} (${s.slot}) is ${s.reason === 'bye' ? 'on bye' : 'ruled out'}: bench him.`
    })),
    ...insights.benchUpgrades.map((u) => ({
      key: `up-${u.player.id}`,
      text:
        u.replaces === null
          ? `Start ${u.player.name} in the empty ${u.slot} slot (+${pts(u.gain)}).`
          : `Start ${u.player.name} over ${u.replaces.name} at ${u.slot} (+${pts(u.gain)}).`
    })),
    ...insights.emptySlots
      .filter((e) => !insights.benchUpgrades.some((u) => u.replaces === null && u.slot === e.slot))
      .map((e) => ({ key: `empty-${e.slot}`, text: `Your ${e.slot} slot is empty.` }))
  ];

  return (
    <section aria-label="Outlook" className="rounded-lg border border-border p-4">
      <h3 className="font-semibold">Outlook</h3>
      {opponent !== null && you.winProbability !== null ? (
        <p className="mt-1" data-testid="win-probability">
          <span className="text-2xl font-semibold">{percent(you.winProbability)}</span> to win · projected{' '}
          {pts(you.projectedPoints)} to {pts(opponent.projectedPoints)}
        </p>
      ) : (
        <p className="mt-1 text-muted-foreground">
          No opponent this week · projected {pts(you.projectedPoints)}
        </p>
      )}
      {you.playersInProgress > 0 || you.currentPoints > 0 ? (
        <p className="text-sm text-muted-foreground">
          {pts(you.currentPoints)} so far, {pts(you.remainingPoints)} expected to come ·{' '}
          {you.playersYetToPlay} yet to play, {you.playersInProgress} playing
        </p>
      ) : null}
      {advice.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Your lineup looks set.</p>
      ) : (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm" aria-label="Lineup advice">
          {advice.map((a) => (
            <li key={a.key}>{a.text}</li>
          ))}
        </ul>
      )}
      {insights.lockedPlayers.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {insights.lockedPlayers.length} {insights.lockedPlayers.length === 1 ? 'player is' : 'players are'}{' '}
          locked for the week.
        </p>
      ) : null}
    </section>
  );
}
