import { yahooDefaultSettings, type Archetype } from '@fantasy/core';
import { fixtureDraftPool } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import type { AgentActionRequested } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { OFF_SWITCH } from '../src/kill-switch.js';
import { runAgentAction } from '../src/runner.js';
import { draftSetup } from './draft-support.js';
import { AGENT_TEAM, LEAGUE_ID, START, setup } from './support.js';

/**
 * Replay comparison (issue #73): the same situation, played by agents that differ only in their
 * archetype, ends in measurably different decisions. Each scenario runs twice: with the fake model
 * (which confirms the deterministic recommendation) and with the kill switch on (the fallback).
 */

const AGENT_ID = `${LEAGUE_ID}.${AGENT_TEAM}`;
// Hall of Famers value players exactly (no valuation noise), so only the archetype differs.
const seatFor = (archetype: Archetype) =>
  ({ personalityId: 'stats-nerd', difficulty: 'hall_of_famer', archetype }) as const;
/** The board's top two: a running back ranked 3rd and a receiver ranked 4th. */
const RERANKED: Record<string, number> = { 'fx-cmc': 3, 'fx-lamb': 4, 'fx-jjefferson': 7, 'fx-chase': 8 };
const pool = fixtureDraftPool.map((p) => ({ ...p, rank: RERANKED[p.id] ?? p.rank }));
const ENGAGED = { engaged: async () => true };
const MODES = [
  ['fake model', OFF_SWITCH],
  ['fallback', ENGAGED]
] as const;

function request(kind: string, payload: Record<string, unknown>, detailType: string): AgentActionRequested {
  return {
    taskId: `${kind}.cmp`,
    leagueId: LEAGUE_ID,
    teamId: AGENT_TEAM,
    agentId: AGENT_ID,
    kind,
    trigger: { detailType, eventId: 'evt-cmp', urgent: true },
    payload,
    requestedAt: START
  };
}

describe('archetypes change decisions', () => {
  describe('draft ranking', () => {
    for (const [mode, killSwitch] of MODES) {
      it(`zero RB drafts a receiver where a balanced drafter takes the top back (${mode})`, async () => {
        const firstPick = async (archetype: Archetype) => {
          const s = await draftSetup({
            order: ['team-2', 'team-1', 'team-3', 'team-4'],
            players: pool,
            beforeStart: async (d) => {
              await d.run('configure_agent_seat', {
                leagueId: d.leagueId,
                teamId: 'team-2',
                ...seatFor(archetype)
              });
            }
          });
          await runAgentAction(s.deps(new ScriptedModelClient(), { killSwitch }), s.turnRequest());
          const pick = (await s.repos.drafts.get(s.leagueId))?.state.picks[0];
          return fixtureDraftPool.find((p) => p.id === pick?.playerId)?.position;
        };
        expect(await firstPick('zero_rb')).toBe('WR');
        expect(await firstPick('balanced')).toBe('RB');
      });
    }
  });

  describe('lineup risk', () => {
    /** qb1 is questionable and projects 10; qb2 is healthy and projects 9.52. */
    async function lineupLeague(archetype: Archetype) {
      const s = await setup();
      await s.seat(AGENT_TEAM, seatFor(archetype));
      const [qb1] = await s.repos.players.getMany(['qb1']);
      if (qb1 === undefined) throw new Error('qb1');
      await s.repos.players.putMany([{ ...qb1, injuryStatus: 'Questionable' }]);
      await s.services.data.reference.projections.putSnapshot(
        { season: 2026, week: 5, capturedAt: '2026-10-02T12:00:00.000Z', hash: 'risk', count: 3 },
        [
          { playerId: 'qb1', season: 2026, week: 5, stats: { pass_yd: 250 } },
          { playerId: 'qb2', season: 2026, week: 5, stats: { pass_yd: 238 } },
          { playerId: 'rb3', season: 2026, week: 5, stats: { rush_yd: 300 } }
        ]
      );
      return s;
    }

    for (const [mode, killSwitch] of MODES) {
      it(`win-now benches the questionable QB, the gut-feel homer starts him (${mode})`, async () => {
        const starterQb = async (archetype: Archetype) => {
          const s = await lineupLeague(archetype);
          await runAgentAction(
            s.deps(new ScriptedModelClient(), { killSwitch }),
            request('lineup', { reason: 'lock', week: 5 }, 'Lineup Lock Approaching')
          );
          const saved = await s.savedLineups();
          return saved[0]?.lineup.find((e) => e.slot === 'QB')?.playerId;
        };
        expect(await starterQb('win_now')).toBe('qb2');
        expect(await starterQb('gut_feel_homer')).toBe('qb1');
      });
    }
  });

  describe('waiver aggressiveness', () => {
    /** One trending pickup worth +0.5 projected points over the agent's worst player. */
    async function marginalPickup(archetype: Archetype) {
      const settings = yahooDefaultSettings(4);
      settings.roster.slots = { QB: 1, RB: 1, BN: 1 };
      const s = await setup({ league: { settings } });
      await s.seat(AGENT_TEAM, seatFor(archetype));
      const team = await s.repos.teams.get(LEAGUE_ID, AGENT_TEAM);
      await s.repos.teams.update({ ...team!, roster: ['qb2', 'rb2', 'te2'] });
      const other = await s.repos.teams.get(LEAGUE_ID, 'team-3');
      await s.repos.teams.update({ ...other!, roster: ['rb1'] });
      await s.repos.waivers.putWireEntry({
        leagueId: LEAGUE_ID,
        playerId: 'rb3',
        droppedByTeamId: 'team-4',
        droppedAt: START,
        clearsAt: '2026-10-06T15:00:00.000Z'
      });
      await s.services.data.reference.projections.putSnapshot(
        { season: 2026, week: 5, capturedAt: '2026-10-02T12:00:00.000Z', hash: 'marginal', count: 1 },
        [{ playerId: 'rb3', season: 2026, week: 5, stats: { rush_yd: 5 } }]
      );
      await s.services.data.reference.trending.put({
        type: 'add',
        capturedAt: '2026-10-04T14:00:00.000Z',
        lookbacks: { '72': [{ playerId: 'rb3', count: 900 }] }
      });
      await runAgentAction(
        s.deps(new ScriptedModelClient()),
        request('waivers', { week: 5 }, 'Waiver Window Opened')
      );
      return s.repos.waivers.listClaims(LEAGUE_ID, 'pending');
    }

    it('a waiver hawk claims a marginal upgrade that trade-happy and balanced managers pass on', async () => {
      expect(await marginalPickup('waiver_hawk')).toEqual([
        expect.objectContaining({ teamId: AGENT_TEAM, addPlayerId: 'rb3' })
      ]);
      expect(await marginalPickup('trade_happy')).toEqual([]);
      expect(await marginalPickup('balanced')).toEqual([]);
    });
  });
});
