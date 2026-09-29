import type { AgentSeatConfig } from '@fantasy/core';
import { AGENT_TEAM, LEAGUE_ID, START, roster, setup, type Setup } from './support.js';

/** The trade market shared by the trade and check-in tests. */

export const HAPPY = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'trade_happy' } as const;
export const X_PLAYERS = ['xqb', 'xrb1', 'xrb2', 'xwr1', 'xwr2', 'xwr3', 'xwr4', 'xte', 'xk', 'xdef'];

/**
 * team-2 (the agent) has the support roster without rb3: qb1 (20 projected points) sits on its
 * bench behind qb2. team-3 has rb3 (30 points) on its bench and a replacement-level roster
 * otherwise. A qb1-for-rb3 swap helps both.
 */
export async function market(config: AgentSeatConfig = HAPPY): Promise<Setup> {
  const s = await setup();
  await s.seat(AGENT_TEAM, config);
  await s.repos.players.putMany(
    X_PLAYERS.map((id) => ({
      id,
      name: id.toUpperCase(),
      firstName: 'X',
      lastName: id,
      team: 'SF',
      position: (id.startsWith('xqb')
        ? 'QB'
        : id.startsWith('xrb')
          ? 'RB'
          : id.startsWith('xwr')
            ? 'WR'
            : id === 'xte'
              ? 'TE'
              : id === 'xk'
                ? 'K'
                : 'DEF') as 'QB',
      status: 'active' as const,
      injuryStatus: null,
      aliases: [],
      rank: null,
      updatedAt: START
    }))
  );
  const rosters: Record<string, string[]> = {
    'team-1': [],
    [AGENT_TEAM]: roster()
      .map((r) => r.playerId)
      .filter((id) => id !== 'rb3'),
    'team-3': ['rb3', ...X_PLAYERS],
    'team-4': []
  };
  for (const [teamId, ids] of Object.entries(rosters)) {
    const team = await s.repos.teams.get(LEAGUE_ID, teamId);
    await s.repos.teams.update({ ...team!, roster: ids });
  }
  const line = (playerId: string, stats: Record<string, number>) => ({
    playerId,
    season: 2026,
    week: 5,
    stats
  });
  const lines = [
    line('qb1', { pass_yd: 750 }),
    line('qb2', { pass_yd: 625 }),
    line('xqb', { pass_yd: 500 }),
    line('rb1', { rush_yd: 200 }),
    line('rb2', { rush_yd: 150 }),
    line('rb3', { rush_yd: 300 }),
    ...['wr1', 'wr2', 'wr3', 'wr4'].map((id) => line(id, { rec_yd: 200 })),
    ...['xrb1', 'xrb2'].map((id) => line(id, { rush_yd: 290 })),
    ...['xwr1', 'xwr2', 'xwr3', 'xwr4'].map((id) => line(id, { rec_yd: 300 }))
  ];
  await s.services.data.reference.projections.putSnapshot(
    { season: 2026, week: 5, capturedAt: '2026-10-02T12:00:00.000Z', hash: 'market', count: lines.length },
    lines
  );
  return s;
}
