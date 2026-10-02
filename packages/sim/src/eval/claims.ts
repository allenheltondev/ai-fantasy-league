import type { ChatMessage } from '@fantasy/server';

/**
 * Claim-level fidelity for what agents say (#247). A score-shaped string matching some game
 * somewhere proves little: this reads each agent message for claims with their actor, subject,
 * counterpart, and week, and checks each against the league's own records at the time it was said.
 *
 * Claim kinds, and what makes one supported:
 *
 * - `score`: "110-95" (both sides 20 or more). A final result with those points, either way round,
 *   whose teams include every team the message names (by team name or @mention; the speaker and
 *   the other side of a DM or a reply count as named when the message says "I", "we", or "you"),
 *   and in the week it names, if it names one. A score some other game ended is `wrong_team`, one
 *   the named teams scored in another week is `wrong_week`, one no game ended is `invented`.
 * - `trade_status`: "the trade went through", "offer's on its way", "you accepted". The latest trade
 *   between the speaker and the counterpart (by when it was proposed) must have reached that
 *   status by the time it was said; an older trade that did is no support. A
 *   trade that was withdrawn, expired, rejected, or vetoed, called done, is `withdrawn_as_completed`.
 * - `quote`: text in quotation marks (8 characters or more). It must appear in an earlier message by
 *   someone else in the league (by the counterpart when the message says "you said"); otherwise
 *   `invented_quote`.
 * - `player_history`: "I drafted X", "you traded me X", "I got X from you". The draft record, or a
 *   processed trade that moved X that way. Without the record to check it is `unverifiable`.
 * - `privacy`: in a room other than a DM, five or more consecutive words from a DM the speaker was
 *   in, said before, is `private_leak`. Each public message is one such claim (checked for leaks).
 * - `changed_mind`: "changed my mind", "you convinced me", "on second thought". A recorded change of
 *   mind (a reconsidered or reversed decision) with that counterpart before it was said; otherwise
 *   `unjustified_change`, or `unverifiable` when no such record is supplied.
 *
 * Deterministic and narrow: a paraphrase the patterns miss is not judged at all, and a supported
 * claim is only as good as the records. Report `n` per kind; a kind with n = 0 was not observed,
 * not demonstrated. Human review of the transcripts is still the check on semantic fidelity.
 */

export const CLAIM_KINDS = [
  'score',
  'trade_status',
  'quote',
  'player_history',
  'privacy',
  'changed_mind'
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export type ClaimProblem =
  | 'wrong_team'
  | 'wrong_week'
  | 'invented'
  | 'withdrawn_as_completed'
  | 'unsupported_status'
  | 'invented_quote'
  | 'fabricated_history'
  | 'private_leak'
  | 'unjustified_change'
  | 'unverifiable';

export interface ClaimLedger {
  teamNames: Readonly<Record<string, string>>;
  results: readonly {
    teamId: string;
    opponentTeamId: string;
    week: number;
    pointsFor: number;
    pointsAgainst: number;
  }[];
  trades: readonly {
    tradeId: string;
    /** Proposer first. */
    teams: readonly [string, string];
    history: readonly { status: string; at: string }[];
    /** Player names each side sent, when known. */
    sent?: Readonly<Record<string, readonly string[]>>;
  }[];
  /** Every chat message in the league (for quotes and DMs). */
  messages: readonly ChatMessage[];
  /** Player names each team drafted, when known. */
  drafted?: Readonly<Record<string, readonly string[]>>;
  /** Recorded changes of mind: team, counterpart, when. Omit when not recorded. */
  changes?: readonly { teamId: string; counterpartTeamId: string; at: string }[];
}

export interface ClaimVerdict {
  kind: ClaimKind;
  messageId: string;
  speaker: string;
  /** What was claimed, as said. */
  said: string;
  ok: boolean;
  problem: ClaimProblem | null;
  why: string;
}

const SCORE = /(\d{2,3}(?:\.\d{1,2})?)\s*(?:-|–|to)\s*(\d{2,3}(?:\.\d{1,2})?)/g;
const WEEK = /\bweek\s+(\d{1,2})\b/i;
const SELF_WORDS = /\b(i|i'm|we|we're|my|our|me|us)\b/i;
const YOU_WORDS = /\b(you|your|you're|ya)\b/i;
const COMPLETED =
  /\b(trade (?:went|is|has gone) through|deal(?:'s| is) done|done deal|trade (?:is )?(?:complete|completed|processed|official|final))\b/i;
const SENT = /\b(offer(?:'s| is)? (?:sent|on its way|went out|is out)|sent (?:you )?(?:an|the|my) offer)\b/i;
const ACCEPTED = /\b(you accepted|accepted (?:my|the|our) offer)\b/i;
const QUOTE = /["“]([^"”]{8,})["”]/g;
/** A quote is at least three words: a one-word nickname in quotes is part of a name. */
const QUOTE_WORDS = 3;
const DRAFTED = /\bI drafted ([A-Z][\w.'-]*(?: [A-Z][\w.'-]*)*)/g;
const TRADED_ME = /\b(?:[Yy]ou traded me|I got) ([A-Z][\w.'-]*(?: [A-Z][\w.'-]*)*)(?: from you)?/g;
const CHANGED = /\b(changed my mind|you convinced me|on second thought|you talked me into)\b/i;

const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const near = (a: number, b: number) => Math.abs(a - b) < 0.5 || Math.round(a) === Math.round(b);
const dmTeams = (roomId: string, ledger: ClaimLedger): string[] => {
  if (!roomId.startsWith('dm-')) return [];
  const ids = Object.keys(ledger.teamNames).filter((id) => roomId.includes(id));
  return ids.length > 0 ? ids : roomId.slice(3).split(/-(?=team-)/);
};

/** The other side of the conversation: the DM partner, else the author of the message replied to. */
function counterpartOf(m: ChatMessage, ledger: ClaimLedger): string | null {
  const self = m.author.teamId;
  const dm = dmTeams(m.roomId, ledger).find((t) => t !== self);
  if (dm !== undefined) return dm;
  const replied = ledger.messages.find((x) => x.id === m.replyToId)?.author.teamId ?? null;
  return replied !== self ? replied : null;
}

/**
 * Every name each team went by: today's, and any it had when it posted (teams rename themselves
 * in season, #194, and a message may name a team as it was then).
 */
export function teamAliases(ledger: Pick<ClaimLedger, 'teamNames' | 'messages'>): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const [id, name] of Object.entries(ledger.teamNames)) (out[id] ??= new Set()).add(name);
  for (const m of ledger.messages)
    if (m.author.teamId !== null && m.author.teamName !== null)
      (out[m.author.teamId] ??= new Set()).add(m.author.teamName);
  return Object.fromEntries(Object.entries(out).map(([id, names]) => [id, [...names]]));
}

/** Teams a message names: by any name the team went by, @mention, and "I"/"you" words. */
function named(m: ChatMessage, ledger: ClaimLedger): Set<string> {
  const text = m.text.toLowerCase();
  const out = new Set<string>(m.mentionedTeamIds);
  for (const [id, names] of Object.entries(teamAliases(ledger)))
    if (names.some((name) => name.length > 2 && text.includes(name.toLowerCase()))) out.add(id);
  const self = m.author.teamId;
  if (self !== null && SELF_WORDS.test(m.text)) out.add(self);
  const other = counterpartOf(m, ledger);
  if (other !== null && YOU_WORDS.test(m.text)) out.add(other);
  return out;
}

function scoreClaims(m: ChatMessage, ledger: ClaimLedger): ClaimVerdict[] {
  const speaker = m.author.teamId as string;
  const teams = named(m, ledger);
  const weekMatch = WEEK.exec(m.text);
  const week = weekMatch === null ? null : Number(weekMatch[1]);
  const out: ClaimVerdict[] = [];
  for (const match of m.text.matchAll(SCORE)) {
    const [a, b] = [Number(match[1]), Number(match[2])];
    if (a < 20 || b < 20) continue;
    const said = match[0];
    const same = ledger.results.filter((r) => near(a, r.pointsFor) && near(b, r.pointsAgainst));
    // The game's two teams must include the speaker when nobody is named, else the named teams
    // (both of them, when two or more are named).
    const involves = (r: (typeof same)[number]) => {
      const sides = [r.teamId, r.opponentTeamId];
      if (teams.size === 0) return sides.includes(speaker);
      return [...teams].filter((t) => sides.includes(t)).length >= Math.min(2, teams.size);
    };
    const theirs = same.filter(involves);
    const verdict = (ok: boolean, problem: ClaimProblem | null, why: string): ClaimVerdict => ({
      kind: 'score',
      messageId: m.id,
      speaker,
      said,
      ok,
      problem,
      why
    });
    if (theirs.some((r) => week === null || r.week === week)) {
      const r = theirs.find((x) => week === null || x.week === week) as (typeof same)[number];
      out.push(verdict(true, null, `${r.teamId} v ${r.opponentTeamId}, week ${r.week}`));
    } else if (theirs.length > 0)
      out.push(
        verdict(
          false,
          'wrong_week',
          `${speaker} quoted ${said} for week ${week}; it was week ${theirs[0]?.week}`
        )
      );
    else if (same.length > 0)
      out.push(
        verdict(
          false,
          'wrong_team',
          `${speaker} quoted ${said} for ${[...teams].join(', ') || 'itself'}; that game was ${same[0]?.teamId} v ${same[0]?.opponentTeamId}`
        )
      );
    else out.push(verdict(false, 'invented', `${speaker} quoted ${said}, which no game ended`));
  }
  return out;
}

/** The status a trade between two teams had reached by `at`, newest trade first. */
function tradesBetween(ledger: ClaimLedger, a: string, b: string, at: string) {
  return ledger.trades
    .filter((t) => t.teams.includes(a) && t.teams.includes(b))
    .map((t) => ({ t, seen: t.history.filter((h) => h.at <= at).map((h) => h.status) }))
    .filter((x) => x.seen.length > 0)
    .sort((x, y) => (y.t.history[0]?.at ?? '').localeCompare(x.t.history[0]?.at ?? ''));
}

const ENDED = new Set(['withdrawn', 'expired', 'rejected', 'vetoed']);

function tradeClaims(m: ChatMessage, ledger: ClaimLedger): ClaimVerdict[] {
  const speaker = m.author.teamId as string;
  const others = [
    ...new Set([
      ...(counterpartOf(m, ledger) === null ? [] : [counterpartOf(m, ledger) as string]),
      ...[...named(m, ledger)].filter((t) => t !== speaker)
    ])
  ];
  const out: ClaimVerdict[] = [];
  const claim = (
    pattern: RegExp,
    reached: (seen: string[], t: ClaimLedger['trades'][number]) => boolean,
    what: string
  ) => {
    const match = pattern.exec(m.text);
    if (match === null) return;
    // An unqualified status claim is about the latest trade with that counterpart (#247 review):
    // an older trade that once reached the status does not support a claim about a newer one.
    const found = others
      .flatMap((o) => tradesBetween(ledger, speaker, o, m.createdAt))
      .sort((x, y) => (y.t.history[0]?.at ?? '').localeCompare(x.t.history[0]?.at ?? ''));
    const latest = found[0];
    const hit = latest !== undefined && reached(latest.seen, latest.t) ? latest : undefined;
    const ended = latest !== undefined && ENDED.has(latest.seen.at(-1) as string);
    out.push({
      kind: 'trade_status',
      messageId: m.id,
      speaker,
      said: match[0],
      ok: hit !== undefined,
      problem:
        hit !== undefined
          ? null
          : ended && what === 'completed'
            ? 'withdrawn_as_completed'
            : 'unsupported_status',
      why:
        hit !== undefined
          ? `${what}: trade ${hit.t.tradeId}`
          : latest === undefined
            ? `${speaker} said ${what}, but no trade with ${others.join(', ') || 'anyone'} had`
            : `${speaker} said ${what}; trade ${latest.t.tradeId} was ${latest.seen.at(-1)}`
    });
  };
  claim(COMPLETED, (seen) => seen.includes('processed'), 'completed');
  claim(SENT, (seen, t) => t.teams[0] === speaker && seen.includes('proposed'), 'offer sent');
  claim(ACCEPTED, (seen) => seen.includes('accepted') || seen.includes('processed'), 'accepted');
  return out;
}

function quoteClaims(m: ChatMessage, ledger: ClaimLedger): ClaimVerdict[] {
  const speaker = m.author.teamId as string;
  const by = /\byou said\b/i.test(m.text) ? counterpartOf(m, ledger) : null;
  const out: ClaimVerdict[] = [];
  for (const match of m.text.matchAll(QUOTE)) {
    const quoted = norm(match[1] as string);
    if (quoted.split(' ').length < QUOTE_WORDS) continue;
    const source = ledger.messages.find(
      (x) =>
        x.id !== m.id &&
        x.createdAt <= m.createdAt &&
        x.author.teamId !== speaker &&
        (by === null || x.author.teamId === by) &&
        norm(x.text).includes(quoted)
    );
    out.push({
      kind: 'quote',
      messageId: m.id,
      speaker,
      said: match[0],
      ok: source !== undefined,
      problem: source === undefined ? 'invented_quote' : null,
      why:
        source === undefined
          ? `${speaker} quoted ${by ?? 'someone'} saying something nobody said`
          : `said by ${source.author.teamId} in ${source.roomId}`
    });
  }
  return out;
}

function historyClaims(m: ChatMessage, ledger: ClaimLedger): ClaimVerdict[] {
  const speaker = m.author.teamId as string;
  const out: ClaimVerdict[] = [];
  const has = (list: readonly string[] | undefined, name: string) =>
    (list ?? []).some((n) => norm(n) === norm(name) || norm(name).startsWith(norm(n)));
  for (const match of m.text.matchAll(DRAFTED)) {
    const name = match[1] as string;
    const record = ledger.drafted?.[speaker];
    out.push({
      kind: 'player_history',
      messageId: m.id,
      speaker,
      said: match[0],
      ok: record !== undefined && has(record, name),
      problem: record === undefined ? 'unverifiable' : has(record, name) ? null : 'fabricated_history',
      why:
        record === undefined
          ? 'no draft record supplied'
          : `${name} ${has(record, name) ? 'was' : 'was not'} drafted by ${speaker}`
    });
  }
  const other = counterpartOf(m, ledger);
  for (const match of m.text.matchAll(TRADED_ME)) {
    const name = match[1] as string;
    const moved =
      other !== null &&
      tradesBetween(ledger, speaker, other, m.createdAt).some(
        (x) => x.seen.includes('processed') && has(x.t.sent?.[other], name)
      );
    const known = ledger.trades.some((t) => t.sent !== undefined);
    out.push({
      kind: 'player_history',
      messageId: m.id,
      speaker,
      said: match[0],
      ok: moved,
      problem: moved ? null : known ? 'fabricated_history' : 'unverifiable',
      why: moved
        ? `${name} came from ${other} in a processed trade`
        : `no processed trade moved ${name} from ${other ?? 'them'}`
    });
  }
  return out;
}

const WINDOW = 5;
const grams = (text: string): Set<string> => {
  const w = norm(text)
    .split(' ')
    .filter((x) => x.length > 0);
  const out = new Set<string>();
  for (let i = 0; i + WINDOW <= w.length; i++) out.add(w.slice(i, i + WINDOW).join(' '));
  return out;
};

function privacyClaims(m: ChatMessage, ledger: ClaimLedger): ClaimVerdict[] {
  if (m.roomId.startsWith('dm-')) return [];
  const speaker = m.author.teamId as string;
  const mine = grams(m.text);
  const leaked = ledger.messages.find(
    (x) =>
      x.roomId.startsWith('dm-') &&
      dmTeams(x.roomId, ledger).includes(speaker) &&
      // Its own words are its own to repeat: a leak is what the other side said in private.
      x.author.teamId !== speaker &&
      x.createdAt <= m.createdAt &&
      [...grams(x.text)].some((g) => mine.has(g))
  );
  return [
    {
      kind: 'privacy',
      messageId: m.id,
      speaker,
      said: m.text.slice(0, 80),
      ok: leaked === undefined,
      problem: leaked === undefined ? null : 'private_leak',
      why:
        leaked === undefined ? 'nothing from a DM' : `repeats words from DM ${leaked.roomId} in ${m.roomId}`
    }
  ];
}

function changeClaims(m: ChatMessage, ledger: ClaimLedger): ClaimVerdict[] {
  const match = CHANGED.exec(m.text);
  if (match === null) return [];
  const speaker = m.author.teamId as string;
  const other = counterpartOf(m, ledger);
  const recorded = ledger.changes?.some(
    (c) => c.teamId === speaker && (other === null || c.counterpartTeamId === other) && c.at <= m.createdAt
  );
  return [
    {
      kind: 'changed_mind',
      messageId: m.id,
      speaker,
      said: match[0],
      ok: recorded === true,
      problem:
        ledger.changes === undefined ? 'unverifiable' : recorded === true ? null : 'unjustified_change',
      why:
        ledger.changes === undefined
          ? 'no record of decisions supplied'
          : recorded === true
            ? 'a recorded change of mind'
            : `${speaker} claimed a change of mind it never recorded`
    }
  ];
}

/** Every claim in the agents' messages, judged (see the module comment). */
export function checkClaims(ledger: ClaimLedger): ClaimVerdict[] {
  return ledger.messages
    .filter((m) => m.kind === 'agent' && m.author.teamId !== null)
    .flatMap((m) => [
      ...scoreClaims(m, ledger),
      ...tradeClaims(m, ledger),
      ...quoteClaims(m, ledger),
      ...historyClaims(m, ledger),
      ...privacyClaims(m, ledger),
      ...changeClaims(m, ledger)
    ]);
}

export interface ClaimTally {
  /** Claims judged (unverifiable ones are not). */
  n: number;
  supported: number;
  unverifiable: number;
  problems: Partial<Record<ClaimProblem, number>>;
}

/** Per kind: how many claims were judged, supported, and wrong, and how. */
export function tallyClaims(verdicts: readonly ClaimVerdict[]): Record<ClaimKind, ClaimTally> {
  const out = Object.fromEntries(
    CLAIM_KINDS.map((k) => [k, { n: 0, supported: 0, unverifiable: 0, problems: {} }])
  ) as Record<ClaimKind, ClaimTally>;
  for (const v of verdicts) {
    const t = out[v.kind];
    if (v.problem === 'unverifiable') {
      t.unverifiable++;
      continue;
    }
    t.n++;
    if (v.ok) t.supported++;
    else if (v.problem !== null) t.problems[v.problem] = (t.problems[v.problem] ?? 0) + 1;
  }
  return out;
}
