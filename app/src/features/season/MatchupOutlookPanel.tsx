import type { ReactNode } from 'react';
import { useLeagueApi } from '../../api/league';
import type { MatchupOutlook } from '../../api/types';
import { useLoad } from '../../lib/useLoad';

const percent = (p: number) => `${Math.round(p * 100)}%`;
const pts = (n: number) => n.toFixed(1);

/**
 * Loads the outlook for your matchup (#36, #58) from get_matchup_outlook and hands it to `children`
 * (null while loading or when it fails: it is extra help, so the page shows without it).
 */
export function OutlookLoader({
  leagueId,
  pollMs,
  version = 0,
  enabled = true,
  children
}: {
  leagueId: string;
  pollMs?: number;
  /** Bumped on each live event (`Scores Updated`, `NFL Games Updated`): reloads the outlook. */
  version?: number;
  /** False on another team's matchup: the outlook is yours, so nothing loads. */
  enabled?: boolean;
  children: (outlook: MatchupOutlook | null) => ReactNode;
}) {
  const api = useLeagueApi();
  const loaded = useLoad(
    () => (enabled ? api.getMatchupOutlook(leagueId) : Promise.resolve(null)),
    `${leagueId}:${version}:${enabled}`,
    enabled ? pollMs : undefined
  );
  return <>{children(enabled ? loaded.data : null)}</>;
}

/** The standalone outlook, for a week with no matchup to put the win probability in. */
export function MatchupOutlookPanel(props: Omit<Parameters<typeof OutlookLoader>[0], 'children'>) {
  return <OutlookLoader {...props}>{(o) => (o === null ? null : <OutlookView outlook={o} />)}</OutlookLoader>;
}

export function OutlookView({
  outlook,
  odds = true
}: {
  outlook: MatchupOutlook;
  /** Show the win probability here; the matchup page shows it in the score bar instead. */
  odds?: boolean;
}) {
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
    <section aria-label={odds ? 'Outlook' : 'Lineup advice'} className="rounded-lg border border-border p-4">
      <h3 className="font-semibold">{odds ? 'Outlook' : 'Lineup advice'}</h3>
      {odds &&
        (opponent !== null && you.winProbability !== null ? (
          <>
            <p className="mt-1" data-testid="win-probability">
              <span className="text-2xl font-semibold">{percent(you.winProbability)}</span> to win · projected{' '}
              {pts(you.projectedPoints)} to {pts(opponent.projectedPoints)}
            </p>
            {/* The bar eases to each new probability as live scores move it. */}
            <div aria-hidden="true" className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
              <div
                data-testid="win-probability-bar"
                className="h-full rounded-full bg-primary-500 transition-[width] duration-700 ease-out"
                style={{ width: percent(you.winProbability) }}
              />
            </div>
          </>
        ) : (
          <p className="mt-1 text-muted-foreground">
            No opponent this week · projected {pts(you.projectedPoints)}
          </p>
        ))}
      {/* Who is playing and the projected totals sit in the score bar above (#193). */}
      {you.currentPoints > 0 && you.remainingPoints > 0 ? (
        <p className="text-sm text-muted-foreground">
          {pts(you.remainingPoints)} more points expected to come.
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
    </section>
  );
}
