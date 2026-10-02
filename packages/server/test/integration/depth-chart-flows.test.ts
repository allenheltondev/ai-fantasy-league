import { beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../../src/operations/index.js';
import { toProfile } from '../../src/players/profile.js';
import { createHarness, START, type Harness } from '../support/harness.js';
import { sourcePlayer } from '../support/jobs.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE } from '../support/leagues.js';

/** An NFL team's depth chart, from the Sleeper records the player sync stores beside profiles. */

interface DepthPlayer {
  id: string;
  name: string;
  team: string | null;
  position: string;
  depth: number | null;
  number: number | null;
  injuryStatus: string | null;
}

interface DepthChart {
  team: { code: string; city: string; nickname: string };
  slots: { slot: string; label: string; players: DepthPlayer[] }[];
  others: DepthPlayer[];
}

let h: Harness;
let alice: Caller;

const SOURCES = [
  sourcePlayer({ id: 'kc-wr-b', team: 'KC', position: 'WR', depthChartPosition: 'LWR', depthChartOrder: 2 }),
  sourcePlayer({ id: 'kc-wr-a', team: 'KC', position: 'WR', depthChartPosition: 'LWR', depthChartOrder: 1 }),
  sourcePlayer({ id: 'kc-slot', team: 'KC', position: 'WR', depthChartPosition: 'SWR', depthChartOrder: 1 }),
  sourcePlayer({
    id: 'kc-qb',
    team: 'KC',
    position: 'QB',
    depthChartPosition: 'QB',
    depthChartOrder: 1,
    number: 15,
    injuryStatus: 'Questionable'
  }),
  sourcePlayer({ id: 'kc-k', team: 'KC', position: 'K', depthChartPosition: 'K', depthChartOrder: 1 }),
  sourcePlayer({ id: 'kc-ls', team: 'KC', position: 'TE', depthChartPosition: 'LS', depthChartOrder: 1 }),
  sourcePlayer({ id: 'kc-kr', team: 'KC', position: 'WR', depthChartPosition: 'KR', depthChartOrder: 1 }),
  sourcePlayer({
    id: 'kc-te-ranked',
    team: 'KC',
    position: 'TE',
    depthChartPosition: 'TE',
    depthChartOrder: null,
    searchRank: 5
  }),
  sourcePlayer({ id: 'kc-te', team: 'KC', position: 'TE', depthChartPosition: 'TE', depthChartOrder: 1 }),
  sourcePlayer({
    id: 'kc-te-unranked',
    team: 'KC',
    position: 'TE',
    depthChartPosition: 'TE',
    depthChartOrder: null,
    searchRank: 50
  }),
  sourcePlayer({ id: 'kc-ir', team: 'KC', position: 'RB', depthChartPosition: null, depthChartOrder: null }),
  sourcePlayer({ id: 'buf-wr', team: 'BUF', position: 'WR', depthChartPosition: 'LWR', depthChartOrder: 1 })
];

beforeAll(async () => {
  h = await createHarness({ registry, players: [] });
  alice = as(h, ALICE);
  await h.services.data.reference.playerSync.upsert(
    SOURCES.map((source) => ({ player: toProfile(source, START)!, source }))
  );
  // A profile with no stored source (seeded before the sync ran) is not on the chart.
  await h.repos.players.putMany([{ ...toProfile(sourcePlayer({ id: 'kc-rb' }), START)!, position: 'RB' }]);
});

describe('get_nfl_depth_chart', () => {
  it('lists each slot starter first, in reading order, with the rest of the team apart', async () => {
    const chart = data<DepthChart>(await alice.get('/nfl-teams/KC/depth-chart'));
    expect(chart.team).toEqual({ code: 'KC', city: 'Kansas City', nickname: 'Chiefs' });
    expect(chart.slots.map((s) => [s.slot, s.label, s.players.map((p) => p.id)])).toEqual([
      ['QB', 'QB', ['kc-qb']],
      ['LWR', 'WR (left)', ['kc-wr-a', 'kc-wr-b']],
      ['SWR', 'WR (slot)', ['kc-slot']],
      ['TE', 'TE', ['kc-te', 'kc-te-ranked', 'kc-te-unranked']],
      ['K', 'K', ['kc-k']],
      ['KR', 'KR', ['kc-kr']],
      ['LS', 'LS', ['kc-ls']]
    ]);
    expect(chart.slots[0]?.players[0]).toEqual({
      id: 'kc-qb',
      name: 'Player kc-qb',
      team: 'KC',
      position: 'QB',
      depth: 1,
      number: 15,
      injuryStatus: 'Questionable'
    });
    expect(chart.others.map((p) => p.id).sort()).toEqual(['kc-ir', 'kc-rb']);
    expect(chart.others.find((p) => p.id === 'kc-rb')).toMatchObject({ depth: null, number: null });
  });

  it('is empty for a team with no synced players, and rejects an unknown team', async () => {
    const chart = data<DepthChart>(await alice.get('/nfl-teams/NYJ/depth-chart'));
    expect(chart).toMatchObject({ slots: [], others: [] });
    expect(errorCode(await alice.get('/nfl-teams/XYZ/depth-chart'))).toBe('INVALID_INPUT');
  });
});
