import { z } from 'zod';
import { ATTACHMENT_POLICY, type PlayerAttachments } from './attachments.js';
import { isOpenCommitment, type CommitmentBook } from './commitments.js';
import {
  mayHear,
  tradeVisibility,
  type AgentLeagueMemory,
  type MemoryAudience,
  type MemoryVisibility,
  type SealCheck
} from './memory.js';
import { answeredBefore, asksSomething } from '../chat/continuation.js';
import { relationshipWith } from './relationships.js';
import { checkInChatChance, socialRoll } from './social.js';

/**
 * Grounded social acts (#218): what an AI manager says on its own at a check-in, chosen by a
 * deterministic selector before the check-in's one model call (#196), from facts it can prove.
 *
 * - Candidates: `answer_question` (a person's question to it, still unanswered), `congratulate`,
 *   `acknowledge_mistake` (only from a stored record: a #216 attachment its results revised
 *   down), `callback` (a shared record with this week's opponent), `react_to_result`, and
 *   `stay_quiet`. Each carries a reason code, its counterpart, the evidence ids it rests on, the
 *   audience of the room it would go to, when it stops being fresh, and the commitment (#215) or
 *   agenda goal it relates to.
 * - Evidence: records only (results, trades, attachments, the league's own standings), each with
 *   a #206 visibility. A candidate whose evidence its destination may not hear, or that cites an id
 *   outside the supplied set, is never chosen: a private or unobserved event cannot become a
 *   callback in a public room.
 * - Selection (`selectSocialAct`): a person's question first (the oldest); otherwise at most one
 *   ambient act, only when the personality's own board-post roll passes (quiet managers stay quiet
 *   most check-ins), when the day's posts leave `humanReserve` for people, and when it scores at
 *   least `minScore` by relevance, novelty, relationship salience (#210) and personality. Stale
 *   commentary is dropped, never queued.
 * - Expression: the check-in model gets a compact pack (`socialActPack`) and may word the act or
 *   pass; `checkSocialAct` rejects a draft that cites no supplied evidence, cites an unknown id,
 *   states a number the facts do not, or names something private.
 * - History (`SocialActBook`): a bounded, tenure-scoped record of the acts chosen, keyed by topic,
 *   event and room, so a callback is not repeated and one event draws one reaction per room.
 */

export const SOCIAL_ACTS = [
  'answer_question',
  'congratulate',
  'acknowledge_mistake',
  'callback',
  'react_to_result',
  'stay_quiet'
] as const;
export type SocialActKind = (typeof SOCIAL_ACTS)[number];
export type SpokenActKind = Exclude<SocialActKind, 'stay_quiet'>;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export const SOCIAL_ACT_LIMITS = {
  /** Acts kept per agent tenure (the newest win). */
  history: 24,
  /** Evidence ids one act may cite. */
  evidence: 4,
  /** A person's question stays answerable this long... */
  questionWindowMs: DAY_MS,
  /** ...once the router's own reply (`Chat Mention`) has had this long to happen. */
  questionGraceMs: 10 * 60_000,
  /** An answer handed on and still unanswered may be handed on again after this. */
  answerRetryMs: 4 * HOUR_MS,
  /** Ambient talk about a week's results stays fresh this long after the week's final. */
  resultFreshMs: 36 * HOUR_MS,
  /** An admission stays fresh this long after the record that prompted it. */
  admissionFreshMs: 7 * DAY_MS,
  /** A callback tied to this week's matchup is looked for again at each check-in: never queued. */
  callbackFreshMs: 12 * HOUR_MS,
  /** Per-agent cooldown on one topic, by act. */
  topicCooldownMs: {
    answer_question: 0,
    congratulate: 7 * DAY_MS,
    acknowledge_mistake: 21 * DAY_MS,
    callback: 21 * DAY_MS,
    react_to_result: 7 * DAY_MS
  },
  /** How far back a similar act (same kind or counterpart) makes a new one less novel. */
  noveltyWindowMs: 3 * DAY_MS,
  /** Posts a day kept for people's questions: ambient acts never take the last ones. */
  humanReserve: 1,
  /** Agents that may speak about one league event in one room (a league-wide claim). */
  roomEventAgents: 1,
  /** The least score an ambient act needs. */
  minScore: 0.4,
  /** Characters in an act's message. */
  message: 280
} as const;

export const SOCIAL_ACT_OUTCOMES = [
  'posted',
  'handed_on',
  'withheld',
  'rejected',
  'passed',
  'failed'
] as const;
export type SocialActOutcome = (typeof SOCIAL_ACT_OUTCOMES)[number];

export const SocialActEntrySchema = z.object({
  /** One per task and act (a retried task rewrites its own entry). */
  id: z.string().max(200),
  taskId: z.string().max(200),
  act: z.enum(SOCIAL_ACTS).exclude(['stay_quiet']),
  reason: z.string().max(40),
  /** What this agent said it about: repeats of it are held back (`topicCooldownMs`). */
  topic: z.string().max(200),
  /** The league event it is about: one agent per room speaks about it. */
  eventKey: z.string().max(200),
  roomId: z.string().max(200),
  counterpartTeamId: z.string().nullable(),
  evidence: z.array(z.string().max(200)).max(SOCIAL_ACT_LIMITS.evidence),
  commitmentId: z.string().nullable(),
  at: z.string(),
  outcome: z.enum(SOCIAL_ACT_OUTCOMES),
  /** Why it was withheld or rejected (`room_flooded`, `unsupported_number`, ...). */
  detail: z.string().max(40).nullable()
});
export type SocialActEntry = z.infer<typeof SocialActEntrySchema>;

export const SocialActBookSchema = z.object({
  schemaVersion: z.literal(1),
  acts: z.array(SocialActEntrySchema).max(SOCIAL_ACT_LIMITS.history)
});
export type SocialActBook = z.infer<typeof SocialActBookSchema>;

export const emptySocialActs = (): SocialActBook => ({ schemaVersion: 1, acts: [] });

/** Records an act (replacing an entry with the same id), newest last, within the bound. */
export function recordSocialAct(book: SocialActBook, entry: SocialActEntry): SocialActBook {
  return {
    schemaVersion: 1,
    acts: [...book.acts.filter((a) => a.id !== entry.id), entry].slice(-SOCIAL_ACT_LIMITS.history)
  };
}

/** A verified fact an act may rest on, with who may hear it (#206). */
export interface SocialEvidence {
  id: string;
  line: string;
  at: string;
  visibility: MemoryVisibility;
}

export type SocialReason =
  | 'person_asked'
  | 'rematch'
  | 'traded_with_opponent'
  | 'big_win'
  | 'close_win'
  | 'win'
  | 'close_loss'
  | 'loss'
  | 'big_loss'
  | 'top_score'
  | 'win_streak'
  | 'fell_short';

export interface SocialCandidate {
  act: SpokenActKind;
  reason: SocialReason;
  counterpartTeamId: string | null;
  /** What it is about, in words (no numbers): for the prompt and the activity line. */
  subject: string;
  topic: string;
  eventKey: string;
  roomId: string;
  /** Who reads the room it would go to. */
  audience: MemoryAudience;
  evidence: string[];
  /** When the thing it is about happened. */
  at: string;
  expiresAt: string;
  /** An unresolved interaction with a person. */
  human: boolean;
  /** How much it concerns this agent, 0-1. */
  relevance: number;
  /** How much the counterpart matters to it (#210 relationships), 0-1. */
  salience: number;
  agendaId: string | null;
  commitmentId: string | null;
  /** answer_question: the message answered. */
  replyToId: string | null;
}

export interface SocialOpportunities {
  candidates: SocialCandidate[];
  evidence: SocialEvidence[];
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
const round2 = (x: number) => Math.round(x * 100) / 100;
const plus = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();
const pair = (a: string, b: string) => [a, b].sort().join('|');

/** A chat message as the question finder reads it (newest first, as get_chat returns them). */
export interface QuestionMessage {
  id: string;
  kind: 'user' | 'agent' | 'system';
  author: { teamId: string | null; name: string };
  text: string;
  mentionedTeamIds: readonly string[];
  /** The agent a person was going back and forth with, when the message named nobody. */
  addressedTeamIds?: readonly string[] | undefined;
  replyToId?: string | null | undefined;
  /** An agent's reply: the earlier messages it answers besides the one it replies to (#215). */
  answersMessageIds?: readonly string[] | undefined;
  createdAt: string;
}

export interface PendingQuestion {
  messageId: string;
  roomId: string;
  fromTeamId: string | null;
  author: string;
  dm: boolean;
  at: string;
}

/**
 * A person's questions to this agent in one room that it has not answered: a message from a person
 * (not an agent, not the league) in its DM, or one that @mentions its team or continues a
 * conversation with it (`addressedTeamIds`), that asks something (core `asksSomething`: a question
 * mark, or a sentence that opens like a question or a request), asked within `questionWindowMs`
 * and at least `questionGraceMs` ago (the router's own reply goes first). Answered is core
 * `answeredBefore`, explicit (#215): a reply of its own to that message, or one that names it among
 * the messages it answered. An unrelated message of its own, in a DM or anywhere, answers nothing.
 */
export function pendingQuestions(
  newestFirst: readonly QuestionMessage[],
  room: { roomId: string; dm: boolean },
  self: string,
  now: string
): PendingQuestion[] {
  const t = Date.parse(now);
  return newestFirst.flatMap((m, i) => {
    const age = t - Date.parse(m.createdAt);
    if (
      m.kind !== 'user' ||
      m.author.teamId === self ||
      !asksSomething(m.text) ||
      !(room.dm || m.mentionedTeamIds.includes(self) || (m.addressedTeamIds ?? []).includes(self)) ||
      age < SOCIAL_ACT_LIMITS.questionGraceMs ||
      age > SOCIAL_ACT_LIMITS.questionWindowMs
    )
      return [];
    return answeredBefore(newestFirst, i, self)
      ? []
      : [
          {
            messageId: m.id,
            roomId: room.roomId,
            fromTeamId: m.author.teamId,
            author: m.author.name,
            dm: room.dm,
            at: m.createdAt
          }
        ];
  });
}

/**
 * Candidates to answer people's questions. A question that opened a #215 commitment is left to the
 * commitment's own closing line; one from a team with an open commitment carries its id.
 */
export function questionOpportunities(
  questions: readonly PendingQuestion[],
  commitments: CommitmentBook | null
): SocialOpportunities {
  const book = commitments?.commitments ?? [];
  const sources = new Set(book.map((c) => c.source.messageId));
  const out: SocialOpportunities = { candidates: [], evidence: [] };
  for (const q of questions) {
    if (sources.has(q.messageId)) continue;
    const audience: MemoryAudience = q.dm && q.fromTeamId !== null ? { teams: [q.fromTeamId] } : 'public';
    const id = `message:${q.messageId}`;
    out.evidence.push({
      id,
      line: `${q.author} asked you a question${q.dm ? ' in your DM' : ''}.`,
      at: q.at,
      visibility:
        audience === 'public' ? 'public' : { teams: [...audience.teams], trades: [], waiverClaims: [] }
    });
    const open = book.find((c) => isOpenCommitment(c) && c.counterpartTeamId === q.fromTeamId);
    out.candidates.push({
      act: 'answer_question',
      reason: 'person_asked',
      counterpartTeamId: q.fromTeamId,
      subject: `a question from ${q.author}`,
      topic: `answer:${q.messageId}`,
      eventKey: `answer:${q.messageId}`,
      roomId: q.roomId,
      audience,
      evidence: [id],
      at: q.at,
      expiresAt: plus(q.at, SOCIAL_ACT_LIMITS.questionWindowMs),
      human: true,
      relevance: 1,
      salience: 1,
      agendaId: open?.agendaId ?? null,
      commitmentId: open?.id ?? null,
      replyToId: q.messageId
    });
  }
  return out;
}

/** The league's own facts (the `league` chat context pack): public by construction. */
export interface LeagueFacts {
  throughWeek: number | null;
  standings: readonly { teamId: string; teamName: string; streak: string | null }[];
  lastWeek: readonly { homeTeamId: string; homeScore: number; awayTeamId: string; awayScore: number }[];
}

export interface AmbientInput {
  self: string;
  now: string;
  /** The league's current week. */
  week: number | null;
  /** The agent's memory, already filtered for the destination's readers (`memoryForAudience`). */
  memory: AgentLeagueMemory;
  league: LeagueFacts | null;
  /** This week's matchup opponent, when there is one. */
  opponentTeamId: string | null;
  attachments?: PlayerAttachments | undefined;
  /** The room ambient acts go to, and who reads it. */
  roomId: string;
  audience: MemoryAudience;
}

function margin(pf: number, pa: number): SocialReason {
  const m = pf - pa;
  if (m >= 30) return 'big_win';
  if (m > 0) return m < 10 ? 'close_win' : 'win';
  if (m <= -30) return 'big_loss';
  return m > -10 ? 'close_loss' : 'loss';
}

const VERBS: Record<string, string> = {
  big_win: 'beat',
  close_win: 'edged',
  win: 'beat',
  close_loss: 'lost a close one to',
  loss: 'lost to',
  big_loss: 'lost to'
};

/**
 * Ambient candidates from records the agent actually holds (so an event it never observed cannot
 * appear): its own last result, a rival's big week, a shared record with this week's opponent, and
 * an admission from an attachment its results revised down. Results are dated by the agent's own
 * record of the week's final; without one the week is not fresh and yields nothing.
 */
export function ambientOpportunities(input: AmbientInput): SocialOpportunities {
  const { self, now, memory, league, roomId, audience } = input;
  const out: SocialOpportunities = { candidates: [], evidence: [] };
  const names = new Map((league?.standings ?? []).map((s) => [s.teamId, s.teamName]));
  const name = (id: string) => names.get(id) ?? id;
  const salience = (teamId: string) => {
    const bond = relationshipWith(memory, teamId, now);
    return bond === null ? 0 : round2(clamp01((bond.warmth + bond.rivalry + bond.grudge) / 10));
  };
  const base = {
    roomId,
    audience,
    human: false,
    agendaId: null,
    commitmentId: null,
    replyToId: null
  } as const;
  const evidence = (e: SocialEvidence) => {
    if (!out.evidence.some((x) => x.id === e.id)) out.evidence.push(e);
    return e.id;
  };

  const week = league?.throughWeek ?? null;
  const final = week === null ? undefined : memory.results.find((r) => r.week === week);
  if (league !== null && week !== null && final !== undefined) {
    const expiresAt = plus(final.at, SOCIAL_ACT_LIMITS.resultFreshMs);
    const mine = league.lastWeek.find((g) => g.homeTeamId === self || g.awayTeamId === self);
    if (mine !== undefined) {
      const home = mine.homeTeamId === self;
      const [pf, pa, opp] = home
        ? [mine.homeScore, mine.awayScore, mine.awayTeamId]
        : [mine.awayScore, mine.homeScore, mine.homeTeamId];
      const reason = margin(pf, pa);
      const id = evidence({
        id: `result:w${week}`,
        line: `Week ${week} final: you ${VERBS[reason]} ${name(opp)} ${pf}-${pa}.`,
        at: final.at,
        visibility: 'public'
      });
      out.candidates.push({
        ...base,
        act: 'react_to_result',
        reason,
        counterpartTeamId: opp,
        subject: `your week ${week} game against ${name(opp)}`,
        topic: `react:w${week}`,
        eventKey: `game:w${week}:${pair(self, opp)}`,
        evidence: [id],
        at: final.at,
        expiresAt,
        relevance: reason === 'win' || reason === 'loss' ? 0.6 : 0.9,
        salience: salience(opp)
      });
    }
    const scores = league.lastWeek.flatMap((g) => [
      { teamId: g.homeTeamId, pts: g.homeScore },
      { teamId: g.awayTeamId, pts: g.awayScore }
    ]);
    const top = [...scores].sort((a, b) => b.pts - a.pts || a.teamId.localeCompare(b.teamId))[0];
    if (top !== undefined && top.teamId !== self) {
      const id = evidence({
        id: `top:w${week}`,
        line: `Week ${week}'s top score: ${name(top.teamId)} with ${top.pts}.`,
        at: final.at,
        visibility: 'public'
      });
      out.candidates.push({
        ...base,
        act: 'congratulate',
        reason: 'top_score',
        counterpartTeamId: top.teamId,
        subject: `${name(top.teamId)}'s top score in week ${week}`,
        topic: `congratulate:w${week}:${top.teamId}`,
        eventKey: `top:w${week}`,
        evidence: [id],
        at: final.at,
        expiresAt,
        relevance: 0.5,
        salience: salience(top.teamId)
      });
    }
    for (const s of league.standings) {
      const streak = /^W(\d+)$/.exec(s.streak ?? '');
      if (s.teamId === self || streak === null || Number(streak[1]) < 3) continue;
      const id = evidence({
        id: `streak:w${week}:${s.teamId}`,
        line: `${name(s.teamId)} has won ${streak[1]} in a row.`,
        at: final.at,
        visibility: 'public'
      });
      out.candidates.push({
        ...base,
        act: 'congratulate',
        reason: 'win_streak',
        counterpartTeamId: s.teamId,
        subject: `${name(s.teamId)}'s winning streak`,
        topic: `congratulate:streak:${s.teamId}:${streak[1]}`,
        eventKey: `streak:w${week}:${s.teamId}`,
        evidence: [id],
        at: final.at,
        expiresAt,
        relevance: 0.45,
        salience: salience(s.teamId)
      });
    }
  }

  // A callback: a record both teams share, brought back because they meet again this week.
  const opp = input.opponentTeamId;
  const current = input.week;
  if (opp !== null && current !== null) {
    const meeting = [...memory.results]
      .filter((r) => r.teamId === opp && r.week < current)
      .sort((a, b) => b.week - a.week)[0];
    const deal = [...memory.trades]
      .filter((t) => t.teamId === opp && (t.outcome === 'processed' || t.outcome === 'accepted'))
      .sort((a, b) => b.at.localeCompare(a.at))[0];
    const tie = () =>
      evidence({
        id: `matchup:w${current}`,
        line: `This week (week ${current}) you play ${name(opp)}.`,
        at: now,
        visibility: 'public'
      });
    const callback = {
      ...base,
      act: 'callback' as const,
      counterpartTeamId: opp,
      eventKey: `callback:w${current}:${pair(self, opp)}`,
      expiresAt: plus(now, SOCIAL_ACT_LIMITS.callbackFreshMs),
      relevance: 0.85,
      salience: salience(opp)
    };
    if (meeting !== undefined) {
      const reason = margin(meeting.pointsFor, meeting.pointsAgainst);
      const id = evidence({
        id: `result:w${meeting.week}`,
        line: `Week ${meeting.week}: you ${VERBS[reason]} ${name(opp)} ${meeting.pointsFor}-${meeting.pointsAgainst}.`,
        at: meeting.at,
        visibility: 'public'
      });
      out.candidates.push({
        ...callback,
        reason: 'rematch',
        subject: `your week ${meeting.week} game against ${name(opp)}`,
        topic: `callback:${opp}:result:w${meeting.week}`,
        evidence: [id, tie()],
        at: meeting.at
      });
    }
    if (deal !== undefined) {
      const moved =
        deal.sent !== undefined && deal.received !== undefined
          ? `: you sent ${deal.sent.join(', ') || 'nothing'} for ${deal.received.join(', ') || 'nothing'}`
          : '';
      const id = evidence({
        id: `trade:${deal.tradeId}`,
        line: `On ${deal.at.slice(0, 10)} a trade with ${name(opp)} went through${moved}.`,
        at: deal.at,
        visibility: tradeVisibility(deal)
      });
      out.candidates.push({
        ...callback,
        reason: 'traded_with_opponent',
        subject: `your trade with ${name(opp)}`,
        topic: `callback:${opp}:trade:${deal.tradeId}`,
        evidence: [id, tie()],
        at: deal.at
      });
    }
  }

  // An admission, only from a stored record: a player it chose whose results revised it down.
  for (const pref of input.attachments?.preferences ?? []) {
    const revision = pref.revisions.at(-1);
    if (
      revision === undefined ||
      !revision.reason.startsWith('Fell short') ||
      revision.from - revision.to < ATTACHMENT_POLICY.revisionDelta ||
      Date.parse(now) - Date.parse(revision.at) > SOCIAL_ACT_LIMITS.admissionFreshMs
    )
      continue;
    const source = pref.sources.at(-1);
    const how =
      source?.kind === 'drafted'
        ? `You drafted ${pref.name}${source.round === undefined ? '' : ` in round ${source.round}`}`
        : `You traded for ${pref.name}`;
    const id = evidence({
      id: `attachment:${pref.playerId}:${revision.at}`,
      line: `${how}; he ${revision.reason.charAt(0).toLowerCase()}${revision.reason.slice(1)}`,
      at: revision.at,
      visibility: pref.visibility
    });
    out.candidates.push({
      ...base,
      act: 'acknowledge_mistake',
      reason: 'fell_short',
      counterpartTeamId: null,
      subject: `your faith in ${pref.name}`,
      topic: `admit:${pref.playerId}`,
      eventKey: `admit:${self}:${pref.playerId}`,
      evidence: [id],
      at: revision.at,
      expiresAt: plus(revision.at, SOCIAL_ACT_LIMITS.admissionFreshMs),
      relevance: 0.7,
      salience: 0
    });
  }
  return out;
}

/** Whether the personality's roll lets it speak on its own this check-in (the board-post roll). */
export function ambientTurn(chattiness: number, seed: string): boolean {
  return socialRoll(checkInChatChance(chattiness), seed);
}

export type SocialRejection = 'expired' | 'unverified_evidence' | 'private_evidence' | 'repeat' | 'last_word';
export type SocialAbstention = 'no_opportunity' | 'budget' | 'quiet' | 'low_score';

export interface SocialSelectionInput {
  now: string;
  taskId: string;
  /** The check-in's board-post roll seed (`ambientTurn`). */
  seed: string;
  personality: { chattiness: number; persuadability: number };
  candidates: readonly SocialCandidate[];
  evidence: readonly SocialEvidence[];
  history: SocialActBook;
  /** Treat a seal as holding unless the caller knows better (a failed read keeps a secret). */
  sealed?: SealCheck;
  /** Posts the agent may still make in the day (its and the league's budgets); null: unknown. */
  postsLeft: number | null;
  /** Rooms where the agent had the last word. */
  lastWord: readonly string[];
}

export interface SocialSelection {
  act: SocialActKind;
  chosen: SocialCandidate | null;
  abstention: SocialAbstention | null;
  /** People's questions kept for a later check-in (no post left today). */
  waiting: SocialCandidate[];
  /** Candidates not chosen, and why: ambient ones are dropped, never queued. */
  dropped: {
    candidate: SocialCandidate;
    why: SocialRejection | 'budget' | 'yield' | 'quiet' | 'low_score' | 'outscored';
  }[];
  scores: { topic: string; act: SpokenActKind; score: number }[];
}

/** Whether the agent already did this, recently enough that it would be a repeat. */
function repeated(c: SocialCandidate, history: SocialActBook, now: number, taskId: string): boolean {
  if (c.act === 'answer_question')
    return history.acts.some(
      (a) =>
        a.topic === c.topic && a.taskId !== taskId && now - Date.parse(a.at) < SOCIAL_ACT_LIMITS.answerRetryMs
    );
  const cooldown = SOCIAL_ACT_LIMITS.topicCooldownMs[c.act];
  return history.acts.some((a) => a.topic === c.topic && now - Date.parse(a.at) < cooldown);
}

/**
 * How worth saying an ambient act is, 0-1: its relevance to this agent (half), how new it is next to
 * what the agent said lately (novelty: a like act or the same counterpart within `noveltyWindowMs`
 * counts against it), and the relationship's salience; scaled by the personality's affinity for
 * the act (a stubborn manager rarely admits it was wrong).
 */
export function socialScore(
  c: SocialCandidate,
  history: SocialActBook,
  personality: { persuadability: number },
  now: string
): number {
  const since = Date.parse(now) - SOCIAL_ACT_LIMITS.noveltyWindowMs;
  const recent = history.acts.filter((a) => Date.parse(a.at) >= since && a.outcome === 'posted');
  const novelty =
    1 -
    (recent.some((a) => a.act === c.act) ? 0.4 : 0) -
    (c.counterpartTeamId !== null && recent.some((a) => a.counterpartTeamId === c.counterpartTeamId)
      ? 0.3
      : 0);
  const affinity = c.act === 'acknowledge_mistake' ? 0.4 + 0.6 * clamp01(personality.persuadability) : 1;
  return round2(clamp01(0.5 * c.relevance + 0.3 * novelty + 0.2 * c.salience) * affinity);
}

/**
 * The selector (pure): which one social act, if any, this check-in carries. See the module comment
 * for the order. Every candidate not chosen is reported with its reason.
 */
export function selectSocialAct(input: SocialSelectionInput): SocialSelection {
  const now = Date.parse(input.now);
  const sealed = input.sealed ?? (() => true);
  const known = new Map(input.evidence.map((e) => [e.id, e]));
  const dropped: SocialSelection['dropped'] = [];
  const eligible: SocialCandidate[] = [];
  for (const c of input.candidates) {
    const cited = c.evidence.map((id) => known.get(id));
    const why: SocialRejection | null =
      Date.parse(c.expiresAt) <= now
        ? 'expired'
        : cited.length === 0 || cited.some((e) => e === undefined)
          ? 'unverified_evidence'
          : cited.some((e) => !mayHear((e as SocialEvidence).visibility, c.audience, sealed))
            ? 'private_evidence'
            : repeated(c, input.history, now, input.taskId)
              ? 'repeat'
              : !c.human && input.lastWord.includes(c.roomId)
                ? 'last_word'
                : null;
    if (why === null) eligible.push(c);
    else dropped.push({ candidate: c, why });
  }
  const quiet = (abstention: SocialAbstention, waiting: SocialCandidate[] = []): SocialSelection => ({
    act: 'stay_quiet',
    chosen: null,
    abstention,
    waiting,
    dropped,
    scores: []
  });
  const humans = eligible.filter((c) => c.human).sort((a, b) => a.at.localeCompare(b.at));
  const ambient = eligible.filter((c) => !c.human);
  const left = input.postsLeft;
  const first = humans[0];
  if (first !== undefined) {
    // A person's question comes first; ambient talk yields to it (and never waits for later).
    for (const c of ambient) dropped.push({ candidate: c, why: 'yield' });
    if (left !== null && left <= 0) return quiet('budget', humans);
    return { act: first.act, chosen: first, abstention: null, waiting: humans.slice(1), dropped, scores: [] };
  }
  if (ambient.length === 0) return quiet('no_opportunity');
  const drop = (why: 'budget' | 'quiet') => {
    for (const c of ambient) dropped.push({ candidate: c, why });
  };
  if (left !== null && left <= SOCIAL_ACT_LIMITS.humanReserve) {
    drop('budget');
    return quiet('budget');
  }
  if (!ambientTurn(input.personality.chattiness, input.seed)) {
    drop('quiet');
    return quiet('quiet');
  }
  const scores = ambient
    .map((c) => ({ c, score: socialScore(c, input.history, input.personality, input.now) }))
    .sort((a, b) => b.score - a.score || a.c.topic.localeCompare(b.c.topic));
  const best = scores[0] as { c: SocialCandidate; score: number };
  const listed = scores.map((s) => ({ topic: s.c.topic, act: s.c.act, score: s.score }));
  if (best.score < SOCIAL_ACT_LIMITS.minScore) {
    for (const s of scores) dropped.push({ candidate: s.c, why: 'low_score' });
    return { ...quiet('low_score'), scores: listed };
  }
  for (const s of scores.slice(1)) dropped.push({ candidate: s.c, why: 'outscored' });
  return { act: best.c.act, chosen: best.c, abstention: null, waiting: [], dropped, scores: listed };
}

const PURPOSE: Record<SpokenActKind, string> = {
  answer_question: 'answer the question put to you',
  congratulate: 'give credit where it is due',
  acknowledge_mistake: 'own up to a call of yours that has not worked out',
  callback: 'bring back a real moment you share with them, because it bears on this week',
  react_to_result: 'react to your own result'
};

/** What the check-in model is given for the chosen act: the purpose and only the facts it may use. */
export interface SocialActPack {
  act: SpokenActKind;
  reason: SocialReason;
  roomId: string;
  counterpartTeamId: string | null;
  purpose: string;
  /** Citable facts, by id. */
  facts: { id: string; line: string }[];
  /** Public context it may lean on but not cite (the #217 situation lines). */
  context: string[];
}

export function socialActPack(
  chosen: SocialCandidate,
  evidence: readonly SocialEvidence[],
  context: readonly string[] = []
): SocialActPack {
  return {
    act: chosen.act,
    reason: chosen.reason,
    roomId: chosen.roomId,
    counterpartTeamId: chosen.counterpartTeamId,
    purpose: `${PURPOSE[chosen.act]}: ${chosen.subject}`,
    facts: chosen.evidence.flatMap((id) => {
      const e = evidence.find((x) => x.id === id);
      return e === undefined ? [] : [{ id: e.id, line: e.line }];
    }),
    context: [...context]
  };
}

export type SocialActCheck =
  | { ok: true; message: string; evidence: string[] }
  | {
      ok: false;
      reason: 'empty' | 'no_evidence' | 'unknown_evidence' | 'unsupported_number' | 'private_detail';
    };

const numbers = (text: string) => text.match(/\d+(?:\.\d+)?/g) ?? [];

/**
 * Checks a drafted act against its pack before it is posted: it must say something, cite at least
 * one supplied fact and nothing else, state no number the facts and context do not, and name none
 * of `privateTerms` (players in private offers or claims) unless a fact already does. Evidence ids
 * prove where it came from, not that the sentence is faithful; this narrows what it can get wrong.
 */
export function checkSocialAct(
  pack: SocialActPack,
  draft: { message: string; evidence: readonly string[] },
  privateTerms: readonly string[] = []
): SocialActCheck {
  const message = draft.message.replace(/\s+/g, ' ').trim().slice(0, SOCIAL_ACT_LIMITS.message);
  if (message === '') return { ok: false, reason: 'empty' };
  const cited = [...new Set(draft.evidence)];
  if (cited.length === 0) return { ok: false, reason: 'no_evidence' };
  if (cited.some((id) => !pack.facts.some((f) => f.id === id)))
    return { ok: false, reason: 'unknown_evidence' };
  const known = [...pack.facts.map((f) => f.line), ...pack.context];
  const allowed = new Set(known.flatMap(numbers));
  if (numbers(message).some((n) => !allowed.has(n))) return { ok: false, reason: 'unsupported_number' };
  const said = message.toLowerCase();
  const facts = known.join(' ').toLowerCase();
  if (
    privateTerms.some(
      (t) => t.trim() !== '' && said.includes(t.toLowerCase()) && !facts.includes(t.toLowerCase())
    )
  )
    return { ok: false, reason: 'private_detail' };
  return { ok: true, message, evidence: cited.slice(0, SOCIAL_ACT_LIMITS.evidence) };
}

const ACT_WORDS: Record<SpokenActKind, string> = {
  answer_question: 'an answer',
  congratulate: 'congratulations',
  acknowledge_mistake: 'an admission',
  callback: 'a callback',
  react_to_result: 'a reaction to my result'
};

/** The act in the activity log's words (no evidence ids, no message text). */
export function socialActWords(act: SpokenActKind): string {
  return ACT_WORDS[act];
}
