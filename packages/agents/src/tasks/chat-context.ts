import { fitLines, formatSeries } from '@fantasy/core';
import type { ChatContextPack, TradeLine } from '@fantasy/server';

/**
 * Renders a room's fact pack (`get_chat_context`, issue #153) as terse prompt lines. Team and
 * player names are written by people or come from outside data, so every name is flattened to one
 * line with no fence markers. The result stays within `CONTEXT_MAX_CHARS`: lines past it are dropped
 * whole, most important first.
 */

export const CONTEXT_MAX_CHARS = 1500;

/** One line, no fence markers, at most `max` characters. */
function clean(text: string, max = 40): string {
  const flat = text
    .replace(/\s+/g, ' ')
    .replace(/<<<|>>>|```/g, "''")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const pts = (n: number | null) => (n === null ? '-' : String(Math.round(n * 10) / 10));
const pct = (p: number | null) => (p === null ? '?' : `${Math.round(p * 100)}%`);
const player = (p: { name: string; position: string; nflTeam: string | null }) =>
  `${clean(p.name, 28)} (${p.position}${p.nflTeam === null ? '' : ` ${p.nflTeam}`})`;
const names = (xs: readonly string[]) =>
  xs.length === 0 ? 'nothing' : xs.map((x) => clean(x, 28)).join(', ');

function trade(t: TradeLine): string {
  return `${clean(t.fromTeamName)} sent ${names(t.fromSends)} to ${clean(t.toTeamName)} for ${names(t.toSends)} (${t.status}, ${t.at.slice(0, 10)})`;
}

function render(pack: ChatContextPack): string[] {
  switch (pack.kind) {
    case 'league': {
      const lines: string[] = [];
      if (pack.headToHead !== null)
        lines.push(
          `You vs ${clean(pack.headToHead.teamName)} this season: ${formatSeries(pack.headToHead)}.`
        );
      lines.push(
        pack.throughWeek === null
          ? 'Standings: no games final yet.'
          : `Standings through week ${pack.throughWeek}:`
      );
      if (pack.throughWeek !== null)
        for (const r of pack.standings)
          lines.push(
            `${r.rank}. ${clean(r.teamName)} ${r.record}${r.streak === null ? '' : ` ${r.streak}`}, PF ${pts(r.pointsFor)}`
          );
      if (pack.lastWeek.length > 0) {
        const name = (id: string) => clean(pack.standings.find((s) => s.teamId === id)?.teamName ?? id);
        lines.push(
          `Week ${pack.throughWeek} results: ${pack.lastWeek
            .map((g) => `${name(g.homeTeamId)} ${pts(g.homeScore)}-${pts(g.awayScore)} ${name(g.awayTeamId)}`)
            .join('; ')}.`
        );
      }
      if (pack.powerTop.length > 0)
        lines.push(
          `Power rankings: ${pack.powerTop.map((p) => `${p.rank}. ${clean(p.teamName)}`).join(', ')}.`
        );
      return lines;
    }
    case 'matchup': {
      const [a, b] = pack.sides;
      const lines = [
        `Week ${pack.week} matchup (${pack.status.replace('_', ' ')})${
          pack.series === null || a === undefined || b === undefined
            ? ''
            : `; season series ${clean(a.teamName)} ${formatSeries(pack.series)}`
        }.`
      ];
      for (const side of pack.sides) {
        lines.push(
          `${clean(side.teamName)}: ${pts(side.points)} pts, projected ${pts(side.projected)}, win chance ${pct(side.winProbability)}.`
        );
        const starters = side.starters.map((s) => {
          const flags = [
            ...(s.onBye ? ['BYE'] : []),
            ...(s.injury === null ? [] : [clean(s.injury, 12)]),
            ...(s.redZone ? ['RED ZONE'] : [])
          ];
          return `${s.slot} ${clean(s.name, 22)} ${pts(s.points)}/${pts(s.projected)}${flags.length === 0 ? '' : ` [${flags.join(', ')}]`}`;
        });
        if (starters.length > 0) lines.push(`  Starters (pts/proj): ${starters.join('; ')}`);
      }
      return lines;
    }
    case 'draft': {
      if (pack.status === 'not_started') return ['The draft has not started.'];
      const lines = [`Draft ${pack.status.replace('_', ' ')}, ${pack.picksMade} picks made.`];
      if (pack.yourPicks.length > 0) lines.push(`Your picks: ${pack.yourPicks.map(player).join(', ')}.`);
      if (pack.recentPicks.length > 0)
        lines.push(
          `Latest picks: ${pack.recentPicks.map((p) => `#${p.overall} ${clean(p.teamName)}: ${player(p.player)}`).join('; ')}.`
        );
      const recap = (label: string, xs: typeof pack.steals) =>
        xs.length === 0
          ? []
          : [
              `${label}: ${xs.map((x) => `${player(x.player)} by ${clean(x.teamName)}${x.value === null ? '' : ` (${x.value > 0 ? '+' : ''}${Math.round(x.value)} vs ADP)`}`).join('; ')}.`
            ];
      return [...lines, ...recap('Biggest steals', pack.steals), ...recap('Biggest reaches', pack.reaches)];
    }
    case 'trades': {
      const deadline = pack.deadline.passed
        ? 'The trade deadline has passed.'
        : `Trade deadline: week ${pack.deadline.week}${pack.deadline.at === null ? '' : ` (${pack.deadline.at.slice(0, 10)})`}.`;
      return [
        deadline,
        ...(pack.recent.length === 0 ? ['No trades in the last two weeks.'] : ['Recent trades:']),
        ...pack.recent.map((t) => `- ${trade(t)}`),
        ...(pack.yours.length === 0 ? [] : ['Your trades:', ...pack.yours.map((t) => `- ${trade(t)}`)]),
        ...(pack.yourOpenOffers === 0
          ? []
          : [
              `You have ${pack.yourOpenOffers} open offer(s); their terms are private, never share them here.`
            ])
      ];
    }
    case 'waivers': {
      const lines: string[] = [];
      if (pack.lastRun === null) lines.push('No waiver run has awarded a player yet.');
      else
        lines.push(
          `Last waiver run (week ${pack.lastRun.week}): ${
            pack.lastRun.awards
              .map(
                (a) =>
                  `${clean(a.teamName)} got ${player(a.player)}${a.cost === null ? '' : ` for $${a.cost}`}`
              )
              .join('; ') || 'no awards'
          }.`
        );
      if (pack.faab.length > 0)
        lines.push(`FAAB left: ${pack.faab.map((f) => `${clean(f.teamName)} $${f.remaining}`).join(', ')}.`);
      if (pack.trending.length > 0)
        lines.push(`Trending adds: ${pack.trending.map((t) => `${player(t)} ${t.adds}`).join(', ')}.`);
      return lines;
    }
    case 'dm': {
      const other = clean(pack.other.teamName);
      return [
        `Your head-to-head with ${other} this season: ${pack.headToHead === null ? 'you have not played' : formatSeries(pack.headToHead)}.`,
        `${other} cannot fill: ${pack.otherNeeds.length === 0 ? 'nothing (every starting slot is covered)' : pack.otherNeeds.join(', ')}.`,
        ...(pack.trades.length === 0
          ? [`No trades or offers between you and ${other} yet.`]
          : [`Trades and offers between you:`, ...pack.trades.map((t) => `- ${trade(t)}`)])
      ];
    }
  }
}

/** The pack as prompt lines, within `maxChars` (default `CONTEXT_MAX_CHARS`). */
export function renderChatContext(pack: ChatContextPack, maxChars: number = CONTEXT_MAX_CHARS): string[] {
  return fitLines(render(pack), maxChars);
}
