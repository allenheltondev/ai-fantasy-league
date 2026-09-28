import { formatRecord } from '@fantasy/core';
import type { SeasonReport } from './run-season.js';

const pad = (s: string | number, n: number): string => String(s).padEnd(n);
const lpad = (s: string | number, n: number): string => String(s).padStart(n);

/** A plain-text summary of a season report, for the CLI and the nightly job log. */
export function formatSummary(report: SeasonReport): string {
  const lines: string[] = [];
  const s = report.settings;
  lines.push(
    `Season ${report.season} replay (${report.engine} engine, seed ${report.seed}): ${s.teamCount} teams, ` +
      `weeks ${s.startWeek}-${s.regularSeasonEndWeek} regular season, playoffs ${s.playoffWeeks.join(', ')}.`
  );
  lines.push(`Champion: ${report.champion ?? 'none'}`);
  lines.push('');
  lines.push(
    `${pad('Rank', 5)}${pad('Team', 12)}${pad('Record', 9)}${lpad('PF', 9)}${lpad('PA', 9)}${lpad('FAAB', 6)}`
  );
  for (const row of report.standings) {
    lines.push(
      `${pad(row.rank, 5)}${pad(row.teamId, 12)}${pad(formatRecord(row), 9)}${lpad(row.pointsFor.toFixed(2), 9)}` +
        `${lpad(row.pointsAgainst.toFixed(2), 9)}${lpad(report.finalFaab[row.teamId] ?? 0, 6)}`
    );
  }
  lines.push('');
  for (const week of report.weeks) {
    const games = week.matchups
      .map((m) => `${m.homeTeamId} ${m.homeScore.toFixed(2)}-${m.awayScore.toFixed(2)} ${m.awayTeamId}`)
      .join(' | ');
    const failed = week.invariants.filter((i) => !i.ok).map((i) => i.name);
    lines.push(
      `Week ${lpad(week.week, 2)} ${pad(week.kind, 9)}${games}${failed.length ? `  FAILED: ${failed.join(', ')}` : ''}`
    );
  }
  const adds = report.transactions.filter((t) => t.type === 'waiver_add');
  const spent = adds.reduce((sum, t) => sum + (t.type === 'waiver_add' ? t.cost : 0), 0);
  lines.push('');
  lines.push(
    `Transactions: ${report.transactions.length - adds.length} draft picks, ${adds.length} waiver adds ($${spent} FAAB).`
  );
  lines.push(
    `Data reads: ${report.dataAccess.reads} (${Object.entries(report.dataAccess.byMethod)
      .map(([m, n]) => `${m} ${n}`)
      .join(', ')}); future reads blocked: ${report.dataAccess.futureAccessAttempts}.`
  );
  if (report.rejected.length > 0) {
    lines.push(
      `Refused actions: ${report.rejected.length} (${[...new Set(report.rejected.flatMap((r) => r.codes))].join(', ')}).`
    );
  }
  lines.push(
    report.violations.length === 0
      ? `Invariants: all held across ${report.weeks.length} weeks (${report.events} timeline events).`
      : `Invariants: ${report.violations.length} violation(s):\n${report.violations
          .slice(0, 20)
          .map((v) => `  week ${v.week} ${v.name}: ${v.message}`)
          .join('\n')}`
  );
  return lines.join('\n');
}
