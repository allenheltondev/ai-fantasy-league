import { DEFAULT_ROOM_ID, PERSONALITIES, rebrandRoll } from '@fantasy/core';
import { AGENT_CHAT_BUDGETS } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import type { BusEvent } from '../src/events.js';
import { ScriptedModelClient, type FakeScript } from '../src/fake-model.js';
import { NAMING_COOLDOWN, routeEvent } from '../src/router.js';
import { runAgentAction } from '../src/runner.js';
import { defaultTaskKinds } from '../src/tasks/index.js';
import { NAMING_ACTIONS, namingOutcome, scriptedName, type NamingPrep } from '../src/tasks/team-identity.js';
import type { TaskContext } from '../src/tasks/kinds.js';
import { createRegistry, operations } from '@fantasy/server';
import { AGENT_TEAM, LEAGUE_ID, START, setup, type Setup } from './support.js';
import type { AgentActionRequested } from '../src/events.js';

const NERD = { personalityId: 'stats-nerd', difficulty: 'rookie', archetype: 'balanced' } as const;
const FOUNDER = { personalityId: 'startup-founder', difficulty: 'pro', archetype: 'trade_happy' } as const;
const ZEN = { personalityId: 'zen-master', difficulty: 'pro', archetype: 'balanced' } as const;

function naming(
  payload: Record<string, unknown> = {},
  id = 'name-1',
  teamId = AGENT_TEAM
): AgentActionRequested {
  return {
    taskId: `team_identity.${id}`,
    leagueId: LEAGUE_ID,
    teamId,
    agentId: `${LEAGUE_ID}.${teamId}`,
    kind: 'team_identity',
    trigger: { detailType: 'Week Rolled Over', eventId: id, urgent: false },
    payload,
    requestedAt: START
  };
}

function scripted(steps: FakeScript['steps'], decision: Record<string, unknown>) {
  return new ScriptedModelClient({
    script: (request) =>
      request.systemPrompt.includes('# Current task: Name your team') ? { steps, decision } : undefined
  });
}

const rename = (name: string) => ({ tool: 'rename_team', args: { teamId: AGENT_TEAM, name } });

async function team(s: Setup, teamId = AGENT_TEAM) {
  return (await s.repos.teams.get(LEAGUE_ID, teamId))!;
}
async function agentPosts(s: Setup) {
  return (await s.repos.chat.list(LEAGUE_ID, DEFAULT_ROOM_ID, { limit: 50 })).messages.filter(
    (m) => m.kind === 'agent'
  );
}

describe('team_identity task', () => {
  it('picks a name in its own style, renames, and announces it in character', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, NERD);
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), naming());
    expect(record).toMatchObject({ status: 'completed', finalAction: 'rename_team' });
    expect(await team(s)).toMatchObject({ name: 'Regression to the Mean Machine', nameSetBy: 'agent' });
    expect(record.reasoningSummary).toMatch(/^Renamed "Team 2" to "Regression to the Mean Machine"\. Chat: /);

    // One chat-tier call, with rename_team as its only mutation, capped at a pick and one retry.
    const [run] = model.transcript;
    expect(model.transcript).toHaveLength(1);
    expect(run?.toolNames).toContain('rename_team');
    expect(run?.toolNames).not.toContain('post_message');
    expect(run?.toolNames).not.toContain('set_lineup');
    // The prompt ties the name to who the agent is.
    const nerd = PERSONALITIES.find((p) => p.id === 'stats-nerd')!;
    expect(run?.systemPrompt).toContain(`Your naming style, as The Spreadsheet: ${nerd.namingStyle}`);
    expect(run?.systemPrompt).toContain('placeholder name, "Team 2"');
    expect(run?.systemPrompt).toContain('League: Test League.');
    expect(run?.systemPrompt).toContain('"Team 3"');
    expect(run?.systemPrompt).toContain('Your strategy is Balanced');
    expect(run?.systemPrompt).toMatch(/Your players worth a pun: .+\(/);

    const posts = await agentPosts(s);
    expect(posts.map((m) => m.text)).toEqual([
      expect.stringMatching(/^New name, same .+\. Say hello to Regression to the Mean Machine\.$/)
    ]);
    expect(s.events.events.filter((e) => e.detailType === 'Team Renamed')).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ by: 'agent', from: 'Team 2' }) })
    ]);
  });

  it('retries once with the reason when a name is taken', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, NERD);
    const model = scripted([rename("Allen's  team"), rename('Standard Deviants')], {
      summary: 'Named it.',
      teamName: 'Standard Deviants',
      message: 'Standard Deviants, reporting for regression.'
    });
    const record = await runAgentAction(s.deps(model), naming());
    expect(model.transcript[0]?.results).toMatchObject([
      { error: { code: 'CONFLICT', fix: expect.any(String) } },
      { data: { team: { name: 'Standard Deviants', nameSetBy: 'agent' } } }
    ]);
    expect(record).toMatchObject({ status: 'completed', finalAction: 'rename_team' });
    expect((await team(s)).name).toBe('Standard Deviants');
    expect((await agentPosts(s)).map((m) => m.text)).toEqual([
      'Standard Deviants, reporting for regression.'
    ]);
  });

  it('gives up cleanly after a second refusal, keeping its name and saying nothing', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, NERD);
    const model = scripted([rename('Team 3'), rename('Team 99'), rename('Third Time Lucky')], {
      summary: 'Tried.',
      teamName: 'Team 99',
      message: 'Behold!'
    });
    const record = await runAgentAction(s.deps(model), naming());
    const results = model.transcript[0]?.results as { error?: { code: string; details?: unknown } }[];
    expect(results.map((r) => r.error?.code)).toEqual(['CONFLICT', 'INVALID_INPUT', 'FORBIDDEN']);
    expect(results[2]?.error?.details).toEqual({ actionsPerTrigger: NAMING_ACTIONS });
    expect(record).toMatchObject({ status: 'completed', finalAction: 'none' });
    expect(record.reasoningSummary).toBe('Kept "Team 2": "Team 99" was not accepted.');
    expect(await team(s)).toMatchObject({ name: 'Team 2', nameSetBy: 'default' });
    expect(await agentPosts(s)).toEqual([]);
    expect(s.logs.some((l) => l.includes('agent team name kept'))).toBe(true);
  });

  it('never overwrites a name the commissioner locked, nor names a team its seat does not name', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, NERD);
    const stored = await team(s);
    await s.repos.teams.update({ ...stored, name: 'Commish Pick', nameSetBy: 'commissioner' });
    const model = new ScriptedModelClient();
    expect(await runAgentAction(s.deps(model), naming({ rebrand: true }))).toMatchObject({
      status: 'skipped',
      fallbackReason: 'name_locked'
    });
    await s.seat('team-3', { ...NERD, namesTeam: false });
    expect(await runAgentAction(s.deps(model), naming({}, 'n3', 'team-3'))).toMatchObject({
      status: 'skipped',
      fallbackReason: 'name_locked'
    });
    // Even a model that tries anyway is refused by rename_team itself.
    const forced = scripted([rename('Mine Now')], { summary: 'x', message: '' });
    await s.repos.teams.update({ ...(await team(s)), name: 'Team 2', nameSetBy: 'commissioner' });
    expect(await runAgentAction(s.deps(forced), naming({}, 'n4'))).toMatchObject({
      fallbackReason: 'name_locked'
    });
    expect(model.transcript).toEqual([]);
    expect((await team(s)).name).toBe('Team 2');
  });

  it('renames quietly when the chat budget is spent, and keeps quiet without a model', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, NERD);
    for (let i = 0; i < AGENT_CHAT_BUDGETS.agentPerDay; i++) {
      await s.repos.chat.put({
        id: `m-agent-${i}`,
        leagueId: LEAGUE_ID,
        roomId: 'trash-talk',
        kind: 'agent',
        author: { teamId: AGENT_TEAM, teamName: 'Team 2', name: 'Team 2' },
        text: `beep ${i}`,
        mentionedTeamIds: [],
        event: null,
        // Half an hour apart, so a full day's budget fits inside the 24-hour window.
        createdAt: new Date(Date.parse(START) - (i + 1) * 30 * 60_000).toISOString()
      });
    }
    const before = (await agentPosts(s)).length;
    const record = await runAgentAction(s.deps(new ScriptedModelClient()), naming());
    expect(record.reasoningSummary).toMatch(
      /^Renamed "Team 2" to ".+"\. No announcement \(chat_budget_agent\)\.$/
    );
    expect((await agentPosts(s)).length).toBe(before);

    await s.seat('team-3', NERD);
    const off = await runAgentAction(
      s.deps(new ScriptedModelClient(), { killSwitch: { engaged: async () => true } }),
      naming({}, 'n5', 'team-3')
    );
    expect(off).toMatchObject({ status: 'fallback', finalAction: 'none' });
    expect((await team(s, 'team-3')).name).toBe('Team 3');
  });

  it('rebrands a real name only at a moment that calls for one', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, FOUNDER);
    await s.repos.teams.update({ ...(await team(s)), name: 'Unicorn Backfield', nameSetBy: 'agent' });
    const model = new ScriptedModelClient();
    // Not the rollover: a real name stays.
    expect(await runAgentAction(s.deps(model), naming({}, 'r0'))).toMatchObject({
      fallbackReason: 'already_named'
    });
    // Week 5 of a 0-0 league: no streak, no clinch, not the deadline.
    expect(await runAgentAction(s.deps(model), naming({ rebrand: true }, 'r1'))).toMatchObject({
      fallbackReason: 'no_rebrand_moment'
    });
    // The trade deadline week is one.
    const league = (await s.repos.leagues.get(LEAGUE_ID))!;
    await s.repos.leagues.update({
      ...league,
      settings: { ...league.settings, trades: { ...league.settings.trades, deadlineWeek: 5 } }
    });
    const record = await runAgentAction(s.deps(model), naming({ rebrand: true }, 'r2'));
    expect(record).toMatchObject({ status: 'completed', finalAction: 'rename_team' });
    expect(model.transcript.at(-1)?.systemPrompt).toContain('The trade deadline is here');
    expect((await team(s)).name).toBe('Disruptive Ground Game Inc.');
  });
});

describe('team_identity edge cases', () => {
  it('names a team before the draft without roster puns, and skips a finished league', async () => {
    const s = await setup({ league: { phase: 'setup', week: null } });
    await s.seat(AGENT_TEAM, NERD);
    const model = new ScriptedModelClient();
    expect(await runAgentAction(s.deps(model), naming())).toMatchObject({ finalAction: 'rename_team' });
    expect(model.transcript[0]?.systemPrompt).toContain('Your roster: not drafted yet.');

    const done = await setup({ league: { phase: 'complete' } });
    await done.seat(AGENT_TEAM, NERD);
    expect(await runAgentAction(done.deps(model), naming())).toMatchObject({
      fallbackReason: 'league_complete'
    });
  });

  it('goes on without a roster, and finds no rebrand moment without a week', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, NERD);
    const model = new ScriptedModelClient();
    const deps = {
      ...s.deps(model),
      registry: createRegistry(operations.filter((op) => op.name !== 'get_roster'))
    };
    expect(await runAgentAction(deps, naming())).toMatchObject({ finalAction: 'rename_team' });
    expect(model.transcript[0]?.systemPrompt).toContain('Your roster: not drafted yet.');
    // A league with no current week has no rebrand moment.
    const league = (await s.repos.leagues.get(LEAGUE_ID))!;
    await s.repos.leagues.update({ ...league, week: null });
    expect(await runAgentAction(s.deps(model), naming({ rebrand: true }, 'n2'))).toMatchObject({
      fallbackReason: 'no_rebrand_moment'
    });
  });

  it('keeps the name when nothing in its style is free, or the league cannot be read', async () => {
    const warnings: unknown[] = [];
    const ctx = {
      principal: { teamId: AGENT_TEAM },
      config: {
        name: 'Marcus Hale',
        personality: PERSONALITIES.find((p) => p.id === 'stats-nerd')!
      },
      tools: { call: async () => ({ error: { code: 'FORBIDDEN', message: 'no', fix: 'no' } }) },
      log: { warn: (...args: unknown[]) => warnings.push(args) }
    } as unknown as TaskContext;
    const nerd = PERSONALITIES.find((p) => p.id === 'stats-nerd')!;
    const prep: NamingPrep = {
      current: 'Team 2',
      occasion: 'placeholder',
      others: [nerd.teamNameSuggestion, ...nerd.teamNameIdeas].map((name) => ({ name, managerName: null })),
      highlights: []
    };
    expect(scriptedName(ctx, prep)).toBeNull();
    expect(await namingOutcome(ctx, prep, undefined)).toEqual({
      renamed: false,
      name: 'Team 2',
      summary: 'Kept "Team 2".'
    });
    expect(warnings).toHaveLength(1);
  });
});

describe('team_identity quiet paths', () => {
  it('renames without a word when the model has nothing to say', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, NERD);
    const model = scripted([rename('Standard Deviants')], { summary: 'Named it.', message: '' });
    const record = await runAgentAction(s.deps(model), naming());
    expect(record.reasoningSummary).toBe('Renamed "Team 2" to "Standard Deviants". Chat: Named it.');
    expect(await agentPosts(s)).toEqual([]);
  });

  it('keeps its name when every name in its style is taken or too close to a rival', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, NERD);
    await s.seat('team-3', { ...ZEN, name: 'Menu' });
    const taken = {
      'team-1': 'Regression to the Mean Machine',
      'team-3': 'Statistically Significant',
      'team-4': 'Standard Deviants'
    };
    for (const [id, name] of Object.entries(taken))
      await s.repos.teams.update({ ...(await team(s, id)), name });
    const record = await runAgentAction(s.deps(new ScriptedModelClient()), naming());
    expect(record).toMatchObject({ status: 'completed', finalAction: 'none' });
    expect(record.reasoningSummary).toBe('Kept "Team 2".');
  });
});

describe('team_identity triggers', () => {
  const event = (detailType: string, detail: Record<string, unknown>, id = 'evt-1'): BusEvent => ({
    id,
    'detail-type': detailType,
    source: 'fantasy',
    detail
  });
  const rollover = {
    leagueId: LEAGUE_ID,
    season: 2026,
    fromWeek: 4,
    week: 5,
    phase: 'regular_season',
    rolledOverAt: START
  };

  async function seated() {
    const s = await setup();
    await s.seat(AGENT_TEAM, NERD);
    await s.seat('team-3', ZEN);
    await s.seat('team-4', FOUNDER);
    const route = (e: BusEvent, responseDelays = false) =>
      routeEvent({ services: s.services, kinds: defaultTaskKinds, responseDelays }, e);
    const naming = (decisions: Awaited<ReturnType<typeof route>>) =>
      decisions.filter((d) => d.kind === 'team_identity').map((d) => [d.teamId, d.decision]);
    return { ...s, route, naming };
  }

  it('names placeholder teams on the rollover, once a week and once a day per team', async () => {
    const s = await seated();
    await s.repos.teams.update({
      ...(await team(s, 'team-3')),
      name: 'The Patient River',
      nameSetBy: 'agent'
    });
    // team-4 never rolls a rebrand for this event (a real name that is not up for change).
    await s.repos.teams.update({
      ...(await team(s, 'team-4')),
      name: 'Unicorn Backfield',
      nameSetBy: 'agent'
    });
    const seedHit = rebrandRoll(0.7, `${LEAGUE_ID}:team-4:week-5`);
    expect(s.naming(await s.route(event('Week Rolled Over', rollover)))).toEqual([
      ['team-2', 'requested'],
      ['team-3', 'declined'],
      ['team-4', seedHit ? 'requested' : 'declined']
    ]);
    expect(s.naming(await s.route(event('Week Rolled Over', rollover, 'evt-2')))).toEqual([
      ['team-2', 'repeat'],
      ['team-3', 'repeat'],
      ['team-4', 'repeat']
    ]);
    // The next week's rollover the same day: the daily cooldown holds the team back.
    expect(s.naming(await s.route(event('Week Rolled Over', { ...rollover, week: 6 }, 'evt-3')))[0]).toEqual([
      'team-2',
      'cooldown'
    ]);
    expect(NAMING_COOLDOWN.agentMinutes).toBe(24 * 60);
  });

  it('names a seat an agent takes back or one changed after the draft, never in setup or once complete', async () => {
    const s = await seated();
    expect(
      s.naming(
        await s.route(
          event('Member Left', { leagueId: LEAGUE_ID, teamId: 'team-3', userId: 'u', reason: 'left' })
        )
      )
    ).toEqual([['team-3', 'requested']]);
    expect(
      s.naming(
        await s.route(event('Agent Seat Changed', { leagueId: LEAGUE_ID, teamId: 'team-4', changes: [] }))
      )
    ).toEqual([['team-4', 'requested']]);
    // A real name is left alone outside the rollover.
    await s.repos.teams.update({ ...(await team(s)), name: 'Big Brain Ball', nameSetBy: 'agent' });
    expect(
      s.naming(await s.route(event('Agent Seat Changed', { leagueId: LEAGUE_ID, teamId: AGENT_TEAM }, 'e2')))
    ).toEqual([[AGENT_TEAM, 'declined']]);
    // A person's seat, or a name the commissioner locked, is never the agent's to name.
    await s.repos.teams.update({
      ...(await team(s, 'team-4')),
      ownerUserId: 'someone',
      ownerName: 'Someone'
    });
    await s.repos.teams.update({ ...(await team(s, 'team-3')), name: 'Locked', nameSetBy: 'commissioner' });
    for (const teamId of ['team-3', 'team-4'])
      expect(
        s.naming(await s.route(event('Agent Seat Changed', { leagueId: LEAGUE_ID, teamId }, `e-${teamId}`)))
      ).toEqual([[teamId, 'declined']]);
    await s.repos.teams.update({ ...(await team(s, 'team-3')), name: 'Team 3', nameSetBy: 'default' });
    for (const phase of ['setup', 'drafting', 'complete'] as const) {
      const league = (await s.repos.leagues.get(LEAGUE_ID))!;
      await s.repos.leagues.update({ ...league, phase });
      expect(
        s.naming(
          await s.route(event('Member Left', { leagueId: LEAGUE_ID, teamId: 'team-3' }, `e-${phase}`))
        ),
        phase
      ).toEqual([['team-3', 'declined']]);
    }
  });

  it('waits a human-like while with the roster delay class', async () => {
    const s = await seated();
    const decisions = await s.route(event('Member Left', { leagueId: LEAGUE_ID, teamId: AGENT_TEAM }), true);
    const [named] = decisions;
    expect(named).toMatchObject({ kind: 'team_identity', decision: 'requested' });
    // A rookie mostly waits (#189); the task is scheduled rather than published, named by its id.
    const delayed = named !== undefined && 'delayMs' in named && named.delayMs > 0;
    const scheduled = s.events.events.filter((e) => e.detailType === 'Schedule Event');
    expect(scheduled.length).toBe(delayed ? 1 : 0);
  });
});
