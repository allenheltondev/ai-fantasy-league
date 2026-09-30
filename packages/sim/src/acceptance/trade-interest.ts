import {
  ScriptedModelClient,
  type AgentAblation,
  type FakeScript,
  type ModelRunRequest
} from '@fantasy/agents';
import type { AgendaGoal, AgentSeatConfig, Commitment } from '@fantasy/core';
import type { AgentTaskRecord, BusEvent, ChatMessage, KillSwitch, TradeRecord } from '@fantasy/server';
import { RecordingModel, memorySection, type ModelRun } from '../scenarios/recording-model.js';
import {
  AGENT_TEAM,
  DM_ROOM,
  HOUR,
  PERSON_TEAM,
  PUBLIC_ROOM,
  buildWorld,
  playerName,
  type AcceptanceWorld
} from './world.js';

/**
 * The epic #219 acceptance scenario, deterministic on the simulated clock with the scripted model:
 * a roster need, a trade pitched in chat, a look that ends in a decline or an offer, a retry, a
 * second change and a reconsideration, the need satisfied, and a later conversation. Every step is
 * captured (`AcceptanceRun`) and judged by `checkAcceptance`, whose checks are hard assertions in
 * the sim tests and per-configuration evidence in the baseline evaluation (`eval/baseline.ts`).
 *
 * The days (13:00Z is 09:00 US Eastern):
 *
 * 0. Day 1: a marginal pitch (the person's backup QB for the agent's third QB), where a cautious
 *    manager and an eager one part ways. The person turns down any offer it brings.
 * 1. An hour later the agent's RB1 is ruled out; the check-in's agenda holds one RB goal.
 * 2. An hour later the person pitches their RB3 for the agent's WR2 in their DM (with a canary that
 *    must never leave the DM). The agent says it will look, and the look decides.
 * 3. The pitch's mention and every agent task so far are delivered again: nothing is duplicated.
 * 4. The person offers the same swap for real and withdraws it before the agent answers.
 * 5. Day 2, past the decline's cooldown: WR2 is ruled out too (the second change), and the check-in
 *    reconsiders. Every task is delivered again.
 * 6. The person accepts an offer if the agent sent one; the review runs out; RB1 is healthy on day
 *    4. Check-ins run three times a day until every goal has closed and a quiet day has passed.
 * 7. Day 6: the person asks about the trade talk in the DM and in a league room.
 */

/** A string that appears only in the person's DM. */
export const CANARY = 'quill-4e9x';

/** The pitch: the person's RB3 for the agent's WR2. */
export const PITCH = { send: 'wr2', receive: 'p-rb3' } as const;
/** The marginal pitch: worth a little by the agent's numbers (between a cautious and an eager bar). */
export const MARGINAL = { send: 'qb3', receive: 'p-qb2' } as const;

export type LookPhase = 'pitch' | 'reconsider' | 'marginal';

export interface AcceptanceRun {
  config: AgentSeatConfig;
  ablations: AgentAblation[];
  pitch: ChatMessage;
  marginalPitch: ChatMessage;
  /** The goals after the first check-in, and at the end. */
  goalsAfterInjury: AgendaGoal[];
  goalsAtEnd: AgendaGoal[];
  /** The pitch's commitment after each look (null when none was opened). */
  looks: { phase: LookPhase; commitment: Commitment | null }[];
  /** The pitch's commitment at the end. */
  finalCommitment: Commitment | null;
  /** The person's own offer, withdrawn before the agent answered. */
  withdrawnTradeId: string | null;
  /** When every goal had closed (null if one never did), and the end of the quiet days after. */
  closedAt: string | null;
  quietUntil: string;
  /** Agent lines answering the pitch, oldest first. */
  replies: string[];
  /** Trades and pitch replies before and after every redelivery. */
  redelivery: { tradesBefore: number; tradesAfter: number; repliesBefore: number; repliesAfter: number };
  trades: TradeRecord[];
  tasks: AgentTaskRecord[];
  runs: ModelRun[];
  /** The recall prompts: the DM question's and the league room question's. */
  recall: { dm: ModelRun | null; room: ModelRun | null };
  /** Every chat message in the DM and the league room, oldest first. */
  chat: ChatMessage[];
  /** Model calls, tokens, and estimated cost, from the runner's own accounting (task records). */
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; costUsd: number };
}

export interface AcceptanceOptions {
  config: AgentSeatConfig;
  ablations?: readonly AgentAblation[];
  killSwitch?: KillSwitch;
  /** Human-like response delays (#189): the check-ins, and what they hand on, run late. */
  responseDelays?: boolean;
}

/**
 * The scripted model plus what a sensible chat model marks: "would you trade your X for my Y?"
 * becomes a trade takeaway naming both players; any other message gets a plain answer.
 */
export function acceptanceModel(): ScriptedModelClient {
  return new ScriptedModelClient({ script: acceptanceScript });
}

function acceptanceScript(request: ModelRunRequest<unknown>): FakeScript | undefined {
  const taskId = String((request.invocationState as { taskId?: string }).taskId ?? '');
  if (!taskId.startsWith('chat_reply.')) return undefined;
  const answering = /The message you are answering: <<<([\s\S]*?)>>>/.exec(request.systemPrompt)?.[1] ?? '';
  const named = /trade (?:your )?(.+?) for (?:my )?(.+?)\?/.exec(answering);
  if (named === null)
    return { steps: [], decision: { summary: 'Answered.', message: 'Still thinking about our last talk.' } };
  return {
    steps: [],
    decision: {
      summary: 'Said I would look at the trade.',
      message: 'Let me run the numbers on that.',
      takeaway: { kind: 'trade', players: [named[1] as string, named[2] as string] }
    }
  };
}

/** "@team-2 would you trade your X for my Y? <argument>" */
export const pitchText = (send: string, receive: string, argument = '') =>
  `@${AGENT_TEAM} would you trade your ${playerName(send)} for my ${playerName(receive)}?${argument === '' ? '' : ` ${argument}`}`;

/** Runs the scenario (see the module comment) and captures what the checks read. */
export async function runTradeInterestScenario(options: AcceptanceOptions): Promise<AcceptanceRun> {
  const model = new RecordingModel(acceptanceModel());
  const w = await buildWorld({
    config: options.config,
    model,
    ...(options.killSwitch === undefined ? {} : { killSwitch: options.killSwitch }),
    ...(options.ablations === undefined ? {} : { ablations: options.ablations }),
    ...(options.responseDelays === undefined ? {} : { responseDelays: options.responseDelays })
  });
  model.clock = w.clock;
  const looks: AcceptanceRun['looks'] = [];
  const count = async () => ({
    trades: (await w.repos.trades.list(w.league.id)).length,
    replies: (await answers(w, pitch)).length
  });
  /** Every agent task so far, delivered again. */
  const redeliverAll = async () => {
    for (const request of w.requests()) await w.rerun(request);
  };
  /** A check-in, then (with response delays) the hours its tasks may wait before they run. */
  const settle = options.responseDelays === true ? 4 * HOUR : 0;
  const checkIn = async (slot: 'morning' | 'afternoon' | 'evening') => {
    await w.checkIn(slot);
    await w.advance(settle);
  };

  // 0. The marginal pitch, before anything else happens; the person turns down any offer it brings.
  const marginalPitch = await w.say(pitchText(MARGINAL.send, MARGINAL.receive));
  looks.push({ phase: 'marginal', commitment: await commitmentFor(w, marginalPitch) });
  const marginalOffer = (await commitmentFor(w, marginalPitch))?.tradeId ?? null;
  if (marginalOffer !== null)
    await w.person('respond_to_trade', { tradeId: marginalOffer, teamId: PERSON_TEAM, response: 'reject' });

  // 1. The injury, and the morning check-in's agenda.
  await w.advance(HOUR);
  await w.injure(['rb1'], 'Out');
  await checkIn('morning');
  const goalsAfterInjury = await goals(w);

  // 2. The pitch, in the DM.
  await w.advance(HOUR);
  const pitch = await w.say(pitchText(PITCH.send, PITCH.receive, `He fills your RB hole. ${CANARY}`));
  looks.push({ phase: 'pitch', commitment: await commitmentFor(w, pitch) });

  // 3. The pitch's mention and every task it caused, delivered again.
  const before = await count();
  const mention = w.delivered.find(
    (e) => e['detail-type'] === 'Chat Mention' && (e.detail as { messageId?: string }).messageId === pitch.id
  ) as BusEvent;
  await w.redeliver(mention);
  await redeliverAll();

  // 4. The same swap offered for real, and withdrawn before the agent gets to it.
  await w.advance(HOUR);
  const offered = await w.attempt('propose_trade', {
    teamId: PERSON_TEAM,
    withTeamId: AGENT_TEAM,
    send: [PITCH.receive],
    receive: [PITCH.send]
  });
  const withdrawnTradeId = 'error' in offered ? null : (offered.data as { trade: { id: string } }).trade.id;
  if (withdrawnTradeId !== null)
    await w.attempt('withdraw_trade', { tradeId: withdrawnTradeId, teamId: PERSON_TEAM });
  await w.loop.drain();

  // 5. The second change, once the decline's cooldown has passed: WR2 is out too.
  await w.advance(12 * HOUR);
  await w.injure([PITCH.send], 'Out');
  await checkIn('evening');
  looks.push({ phase: 'reconsider', commitment: await commitmentFor(w, pitch) });
  const beforeRetry = await count();
  await redeliverAll();
  const afterRetry = await count();
  // The person's withdrawn offer is the one trade made between the two redeliveries.
  const redelivery = {
    tradesBefore: before.trades,
    tradesAfter: before.trades + (afterRetry.trades - beforeRetry.trades),
    repliesBefore: before.replies,
    repliesAfter: before.replies + (afterRetry.replies - beforeRetry.replies)
  };

  // 6. The person takes the offer if one came; the review runs out; RB1 comes back on day 4.
  await w.advance(HOUR);
  const sent = (await commitmentFor(w, pitch))?.tradeId ?? null;
  if (sent !== null)
    await w.attempt('respond_to_trade', { tradeId: sent, teamId: PERSON_TEAM, response: 'accept' });
  let closedAt: string | null = null;
  for (let day = 0; day < 4; day++) {
    if (day === 2) await w.injure(['rb1'], null);
    for (const slot of ['morning', 'afternoon', 'evening'] as const) {
      await w.advance((slot === 'morning' ? 14 * HOUR : 5 * HOUR) - settle);
      await checkIn(slot);
      if (closedAt === null && (await goals(w)).every((g) => g.status !== 'active'))
        closedAt = w.clock.now().toISOString();
    }
  }
  const finalCommitment = await commitmentFor(w, pitch);

  // 7. Later conversation: once in the DM, once in a league room.
  await w.advance(14 * HOUR);
  const quietUntil = w.clock.now().toISOString();
  await w.say(`@${AGENT_TEAM} how do you feel about our trade talk this week?`);
  const dmRecall = lastChatRun(model.runs);
  await w.advance(HOUR);
  await w.say(`@${AGENT_TEAM} been busy on the trade market?`, PUBLIC_ROOM);
  const roomRecall = lastChatRun(model.runs);

  const tasks = await w.repos.agents.listTasks(w.league.id, { limit: 10_000 });
  return {
    config: options.config,
    ablations: [...(options.ablations ?? [])],
    pitch,
    marginalPitch,
    goalsAfterInjury,
    goalsAtEnd: await goals(w),
    looks,
    finalCommitment,
    withdrawnTradeId,
    closedAt,
    quietUntil,
    replies: await answers(w, pitch),
    redelivery,
    trades: await w.repos.trades.list(w.league.id),
    tasks,
    runs: model.runs,
    recall: { dm: dmRecall, room: roomRecall },
    chat: await chatIn(w, [DM_ROOM, PUBLIC_ROOM]),
    usage: usageOf(tasks)
  };
}

/** Model calls, tokens, and estimated cost from task records (the runner's ledger lines). */
export function usageOf(tasks: readonly AgentTaskRecord[]): AcceptanceRun['usage'] {
  const lines = tasks.flatMap((t) => t.usage);
  return {
    modelCalls: lines.length,
    inputTokens: lines.reduce((a, u) => a + u.inputTokens, 0),
    outputTokens: lines.reduce((a, u) => a + u.outputTokens, 0),
    costUsd: Math.round(lines.reduce((a, u) => a + u.estimatedCostUsd, 0) * 1e6) / 1e6
  };
}

async function tenure(w: AcceptanceWorld): Promise<string> {
  const team = await w.repos.teams.get(w.league.id, AGENT_TEAM);
  /* v8 ignore next -- the world created the team */
  return team?.occupiedSince ?? team?.createdAt ?? '';
}

export async function goals(w: AcceptanceWorld): Promise<AgendaGoal[]> {
  return (await w.repos.agents.getAgenda(w.league.id, w.agentId, await tenure(w))).goals;
}

/** The commitment a message opened, if any. */
export async function commitmentFor(w: AcceptanceWorld, message: ChatMessage): Promise<Commitment | null> {
  const book = await w.repos.agents.getCommitments(w.league.id, w.agentId, await tenure(w));
  return book.commitments.find((c) => c.source.messageId === message.id) ?? null;
}

/** The agent's lines answering `message`, oldest first. */
export async function answers(w: AcceptanceWorld, message: ChatMessage): Promise<string[]> {
  return (await w.repos.chat.list(w.league.id, message.roomId, { limit: 100 })).messages
    .filter((m) => m.kind === 'agent' && m.replyToId === message.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((m) => m.text);
}

export async function chatIn(w: AcceptanceWorld, rooms: readonly string[]): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for (const roomId of rooms)
    out.push(...(await w.repos.chat.list(w.league.id, roomId, { limit: 200 })).messages);
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const lastChatRun = (runs: readonly ModelRun[]): ModelRun | null =>
  [...runs].reverse().find((r) => r.kind === 'chat_reply') ?? null;

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export type AcceptanceCheckName =
  | 'one_objective'
  | 'commitment_from_pitch'
  | 'accurate_decisions'
  | 'linked_once'
  | 'reconsidered'
  | 'goal_closed'
  | 'audience_recall';

export interface AcceptanceCheck {
  name: AcceptanceCheckName;
  ok: boolean;
  evidence: string[];
  violations: string[];
}

export function checkAcceptance(run: AcceptanceRun): AcceptanceCheck[] {
  return [
    checkOneObjective(run),
    checkCommitment(run),
    checkDecisions(run),
    checkLinks(run),
    checkReconsidered(run),
    checkGoalClosed(run),
    checkRecall(run)
  ];
}

function verdict(name: AcceptanceCheckName, evidence: string[], violations: string[]): AcceptanceCheck {
  return { name, ok: violations.length === 0 && evidence.length > 0, evidence, violations };
}

const look = (run: AcceptanceRun, phase: LookPhase) => run.looks.find((l) => l.phase === phase)?.commitment;

/** The injury leaves exactly one active goal: repair RB. */
function checkOneObjective(run: AcceptanceRun): AcceptanceCheck {
  const active = run.goalsAfterInjury.filter((g) => g.status === 'active');
  const violations =
    active.length === 1 && active[0]?.slot === 'RB'
      ? []
      : [`expected one active RB goal, found ${active.map((g) => g.slot).join(', ') || 'none'}`];
  return verdict(
    'one_objective',
    active.map((g) => `${g.id} (${g.reason})`),
    violations
  );
}

/** The pitch became a trade_interest commitment tied to the message and, when it could fill it, the goal. */
function checkCommitment(run: AcceptanceRun): AcceptanceCheck {
  const c = look(run, 'pitch');
  if (c === undefined || c === null)
    return verdict('commitment_from_pitch', [], ['the pitch opened no commitment']);
  const violations: string[] = [];
  if (c.kind !== 'trade_interest') violations.push(`kind ${c.kind}`);
  if (c.source.messageId !== run.pitch.id || c.source.visibility !== 'dm')
    violations.push(`source ${JSON.stringify(c.source)} is not the DM pitch`);
  if (c.intent.send.join() !== PITCH.send || c.intent.receive.join() !== PITCH.receive)
    violations.push(`intent ${JSON.stringify(c.intent)} is not the pitched swap`);
  const goal = run.goalsAfterInjury.find((g) => g.status === 'active' && g.slot === 'RB');
  if (goal !== undefined && c.agendaId !== goal.id)
    violations.push(`agenda link ${c.agendaId}, not ${goal.id}`);
  return verdict(
    'commitment_from_pitch',
    [`${c.id} -> ${c.childTaskIds[0]} (agenda ${c.agendaId})`],
    violations
  );
}

/**
 * Every recorded decision agrees with its own facts: an offer only when the score cleared the bar
 * (after the argument's credit) and the league has that very trade; a decline on value or depth
 * only when it did not (depth when the lineup got worse); a lopsided decline only when the value
 * math says so, whichever side it favours.
 */
export function decisionViolations(c: Commitment, trades: readonly TradeRecord[]): string[] {
  const d = c.decision;
  if (d === null) return [];
  const f = d.facts;
  const out: string[] = [];
  const cleared = f !== null && f.score !== null && f.bar !== null && f.score >= f.bar - (f.credit ?? 0);
  switch (d.reason) {
    case 'offer_sent': {
      const trade = trades.find((t) => t.trade.tradeId === c.tradeId)?.trade;
      if (!cleared) out.push(`${c.id}: offer sent below its bar (${JSON.stringify(f)})`);
      if (trade === undefined) out.push(`${c.id}: offer ${c.tradeId} is not in the league`);
      else if (
        trade.sides[0].teamId !== AGENT_TEAM ||
        trade.sides[0].sends.join() !== c.intent.send.join() ||
        trade.sides[1].sends.join() !== c.intent.receive.join()
      )
        out.push(`${c.id}: offer ${trade.tradeId} is not the pitched swap`);
      break;
    }
    case 'value_below_floor':
    case 'insufficient_depth':
      if (cleared)
        out.push(`${c.id}: declined (${d.reason}) though the score cleared the bar (${JSON.stringify(f)})`);
      else if ((d.reason === 'insufficient_depth') !== (f?.lineupDelta ?? 0) < 0)
        out.push(`${c.id}: ${d.reason} with a lineup change of ${f?.lineupDelta}`);
      break;
    default:
      break;
  }
  return out;
}

function checkDecisions(run: AcceptanceRun): AcceptanceCheck {
  const evidence: string[] = [];
  const violations: string[] = [];
  for (const l of run.looks) {
    if (l.commitment === null) continue;
    const d = l.commitment.decision;
    evidence.push(
      `${l.phase}: ${l.commitment.status}/${d?.reason ?? '-'} (score ${d?.facts?.score ?? '-'}, bar ${d?.facts?.bar ?? '-'}, credit ${d?.facts?.credit ?? '-'}, lineup ${d?.facts?.lineupDelta ?? '-'})`
    );
    violations.push(...decisionViolations(l.commitment, run.trades));
  }
  return verdict('accurate_decisions', evidence, violations);
}

/**
 * Message -> commitment -> child tasks -> trade -> closing lines stay linked, and redelivery
 * duplicated nothing: one reply to the pitch, one closing line per look, and no trade twice.
 */
function checkLinks(run: AcceptanceRun): AcceptanceCheck {
  const c = run.finalCommitment;
  if (c === null) return verdict('linked_once', [], ['no commitment to follow']);
  const violations: string[] = [];
  const evidence: string[] = [];
  for (const id of c.childTaskIds) {
    const task = run.tasks.find((t) => t.taskId === id);
    if (task?.kind !== 'trade_proposal') violations.push(`child task ${id} is not a recorded trade_proposal`);
    else evidence.push(`${id}: ${task.status} ${task.finalAction}`);
  }
  if (c.tradeId !== null && !run.trades.some((t) => t.trade.tradeId === c.tradeId))
    violations.push(`trade ${c.tradeId} is not in the league`);
  // One reply to the pitch plus one closing line per look that was claimed.
  const closing = run.replies.length - 1;
  const expected = c.reply === null ? 0 : c.reconsiderations + 1;
  if (closing !== expected)
    violations.push(`${closing} closing lines for ${expected} looks: ${run.replies.join(' | ')}`);
  evidence.push(`${run.replies.length} lines answer the pitch`);
  const { tradesBefore, tradesAfter, repliesBefore, repliesAfter } = run.redelivery;
  if (tradesAfter !== tradesBefore || repliesAfter !== repliesBefore)
    violations.push(
      `redelivery added ${tradesAfter - tradesBefore} trades and ${repliesAfter - repliesBefore} lines`
    );
  // No two offers from the agent with the same swap.
  const swaps = run.trades
    .filter((t) => t.trade.sides[0].teamId === AGENT_TEAM)
    .map((t) => `${t.trade.sides[0].sends.join()}>${t.trade.sides[1].sends.join()}`);
  if (new Set(swaps).size !== swaps.length) violations.push(`a swap was offered twice: ${swaps.join(', ')}`);
  return verdict('linked_once', evidence, violations);
}

/**
 * The second change brought one more look, with the new need in its facts, and the person's
 * withdrawn offer stayed withdrawn: never answered, never the commitment's trade, and never
 * remembered as open.
 */
function checkReconsidered(run: AcceptanceRun): AcceptanceCheck {
  const first = look(run, 'pitch');
  const again = look(run, 'reconsider');
  const violations: string[] = [];
  const evidence: string[] = [];
  if (first === undefined || first === null || again === undefined || again === null)
    return verdict('reconsidered', [], ['no commitment to reconsider']);
  if (again.reconsiderations !== 1 || again.childTaskIds.length !== first.childTaskIds.length + 1)
    violations.push(`the second change brought ${again.reconsiderations} reconsiderations`);
  const newNeeds = (again.decision?.facts?.needs ?? []).filter(
    (n) => !(first.decision?.facts?.needs ?? []).includes(n)
  );
  if (newNeeds.length === 0) violations.push('the reconsidered decision names no new need');
  else evidence.push(`reconsidered for ${newNeeds.join(', ')}: ${again.decision?.reason}`);
  const withdrawn = run.trades.find((t) => t.trade.tradeId === run.withdrawnTradeId)?.trade;
  if (withdrawn?.status !== 'withdrawn')
    violations.push(`the withdrawn offer is ${withdrawn?.status ?? 'missing'}`);
  else evidence.push(`the person's offer ${withdrawn.tradeId} stayed withdrawn`);
  if (run.withdrawnTradeId !== null && again.tradeId === run.withdrawnTradeId)
    violations.push('the commitment adopted the withdrawn offer');
  const dm = memorySection(run.recall.dm?.systemPrompt ?? '');
  if (/An offer from [^.]+ was proposed/.test(dm))
    violations.push('memory still holds the withdrawn offer as open');
  return verdict('reconsidered', evidence, violations);
}

/** Every goal closed once the need was met, and no trade outreach followed in the quiet days after. */
function checkGoalClosed(run: AcceptanceRun): AcceptanceCheck {
  const violations: string[] = [];
  // Without a goal there is nothing to close (an agenda switched off): not a pass.
  if (run.goalsAtEnd.length === 0) return verdict('goal_closed', [], ['no goal was ever set']);
  if (run.closedAt === null) return verdict('goal_closed', [], ['a goal never closed']);
  const active = run.goalsAtEnd.filter((g) => g.status === 'active');
  if (active.length > 0) violations.push(`still active: ${active.map((g) => g.slot).join(', ')}`);
  const closed = Date.parse(run.closedAt);
  const until = Date.parse(run.quietUntil);
  const within = (at: string) => Date.parse(at) >= closed && Date.parse(at) < until;
  const looks = run.tasks.filter((t) => t.kind === 'trade_proposal' && within(t.startedAt));
  const offers = run.trades.filter(
    (t) => t.trade.sides[0].teamId === AGENT_TEAM && within(t.trade.proposedAt)
  );
  if (looks.length > 0 || offers.length > 0)
    violations.push(`${looks.length} trade looks and ${offers.length} offers after the goals closed`);
  return verdict('goal_closed', [`every goal closed at ${run.closedAt}`], violations);
}

/**
 * The DM question's prompt recalls the trade with the person; the league room's recalls nothing
 * private (no offer that never became public); and the DM's canary reached only chat tasks of the
 * agent in that DM, never a decision, a league room, or a public post.
 */
function checkRecall(run: AcceptanceRun): AcceptanceCheck {
  const violations: string[] = [];
  const evidence: string[] = [];
  const dm = memorySection(run.recall.dm?.systemPrompt ?? '');
  const room = memorySection(run.recall.room?.systemPrompt ?? '');
  if (!/Trade with [^(]+\(/.test(dm)) violations.push('the DM prompt recalls no trade with the person');
  else evidence.push(`DM recall: ${(/- Trade with[^\n]*/.exec(dm) ?? [''])[0]}`);
  const privateLines = room
    .split('\n')
    .filter((l) => /\((proposed|countered|rejected|expired|withdrawn);/.test(l));
  if (privateLines.length > 0)
    violations.push(`the league room prompt recalls private offers: ${privateLines.join(' | ')}`);
  else evidence.push('the league room prompt holds no private offer');
  const heard = run.runs.filter((x) => x.systemPrompt.includes(CANARY) || x.input.includes(CANARY));
  for (const r of heard)
    if (r.kind !== 'chat_reply' || r.teamId !== AGENT_TEAM || r === run.recall.room)
      violations.push(`${r.kind} (${r.taskId}) saw the DM`);
  evidence.push(`${heard.length} prompts held the DM's canary, all DM replies`);
  for (const m of run.chat.filter((x) => x.roomId !== DM_ROOM && x.text.includes(CANARY)))
    violations.push(`the canary leaked into ${m.roomId}`);
  return verdict('audience_recall', evidence, violations);
}

// ---------------------------------------------------------------------------
// Archetypes
// ---------------------------------------------------------------------------

/** What an archetype chose, as numbers: its bar, its marginal-pitch outcome, and its offers. */
export interface ChoiceProfile {
  archetype: string;
  bar: number | null;
  marginal: string;
  offersSent: number;
  offersAccepted: number;
}

export function choiceProfile(run: AcceptanceRun): ChoiceProfile {
  const marginal = look(run, 'marginal');
  const mine = run.trades.filter((t) => t.trade.sides[0].teamId === AGENT_TEAM);
  return {
    archetype: run.config.archetype,
    bar: look(run, 'pitch')?.decision?.facts?.bar ?? null,
    marginal: marginal?.decision?.reason ?? 'none',
    offersSent: mine.length,
    offersAccepted: mine.filter((t) => ['accepted', 'in_review', 'processed'].includes(t.trade.status)).length
  };
}
