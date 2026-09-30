# ADR 008: Grounded social acts

Status: accepted, first slice of #218 (epic #219 step 3, and the first part of step 5).

## Problem and decision

An AI manager's own talk (#196) came from dice and league news: a chatty manager posted about whatever was in the standings, and nothing tied a line to what this manager had actually been through with the people it talks to. Nothing answered a question a person asked once the router dropped the mention (a cooldown, a spent budget), and several agents could post the same reaction to one event. A model asked to "recall shared history" freely would make up quotes, predictions, and scores.

Choose what to say deterministically, from facts the agent can prove, before the check-in's one model call. The model only words the chosen act, or passes. Record what was chosen, so it is not repeated and one event draws one reaction per room.

## Selection

Core owns the rules in `packages/core/src/agents/social-acts.ts`, all pure:

- **Candidates.** `answer_question`, `congratulate`, `acknowledge_mistake`, `callback`, `react_to_result`, and `stay_quiet` (the empty choice). Each carries a reason code (`person_asked`, `rematch`, `traded_with_opponent`, `big_win`, `close_loss`, `top_score`, `win_streak`, `fell_short`, ...), a counterpart, a subject in words, a topic (what this agent said) and an event key (what happened in the league), the destination room and its audience, evidence ids, when it happened and when it stops being fresh, and the #215 commitment or #214 agenda goal it relates to. `ask_relevant_question` is deferred.
- **Evidence.** Records only, each with a #206 visibility. `pendingQuestions` finds a person's messages to this agent (its DM, an @mention, or an untagged follow-up in a conversation with it, `addressedTeamIds`) that asks something (core `asksSomething`: a question mark, or a sentence opening like a question or a request), asked within a day and at least ten minutes ago (the router's own reply goes first), that it has not answered (core `answeredBefore`, explicit since #215: a reply to it, or a reply naming it in `answersMessageIds`; nothing else the agent wrote counts). `ambientOpportunities` reads the agent's memory as the destination may hear it (`memoryForAudience`, records only: no chat snapshots or relationship notes), the league's own standings and last week's results, this week's opponent, and #216 attachments. A callback needs a record both teams share (an earlier game, or a processed trade) and a reason it bears on now (they meet this week). An admission needs a stored record: an attachment whose results revised it down ("You drafted X in round 1; he fell short of projection in 3 of the last 3 weeks"). Without one the candidate never appears. Results are dated by the agent's own record of the week's final; without it the week is not fresh.
- **Order.** `selectSocialAct` first drops what cannot or should not be said: expired, citing an id outside the supplied set, citing evidence the destination may not hear (a seal is treated as holding), a topic this agent spoke to within its cooldown (7 days for reactions and congratulations, 21 for callbacks and admissions), or a room where it had the last word. Then:
  1. A person's question, the oldest first, whatever the personality. With no post left today it waits (`waiting`), and nothing ambient goes out.
  2. Otherwise at most one ambient act. It needs the day's posts to leave `humanReserve` (1) for people, and the personality's board-post roll (`ambientTurn`, the same seed as #196's board post) to pass: a quiet manager stays quiet most check-ins.
  3. It needs a score of at least 0.4: half relevance to this agent, 0.3 novelty (a like act or the same counterpart posted in the last three days counts against it), 0.2 relationship salience (#210 warmth, rivalry, and grudge), scaled by personality (persuadability for an admission).

  Everything not chosen is reported with why. Ambient candidates are dropped, never queued: the next check-in derives them again from the facts, and stale ones have expired by then.

## Expression

Runtime is `packages/agents/src/tasks/social-acts.ts`, inside #196's check-in social look:

- **Questions** go to `chat_reply` as a follow-up (#207's outbox), so the ordinary reply path answers them: its prompt, DM privacy, takeaways into #215 commitments, and its `already_answered` guard. The check-in itself needs no model call for it, and adds no board post, matchup talk, or DM alongside it. A question that opened a commitment is left to the commitment's closing line, which #215 already posts; an open commitment with the asker is recorded on the act.
- **One reply per message, whichever path asked.** A mention's own `chat_reply` and a check-in's hand-off have different task ids, and two runs at once can both pass `already_answered`. So `chat_reply` (every trigger, not only #218's) claims the message's reply slot right before posting: an owner-keyed, atomic trigger-state gate (`claimOnce`, `admitTrigger` with `slot=<agentId>#once#reply#<messageId>`, `owner=<taskId>`, held two days). The run that loses skips with `already_answered` and posts nothing. A retry of the task that holds the slot is its owner and re-takes it, so a crash between the claim and the post does not lose the line; the post itself replays by the task's idempotency key, so the retry cannot post twice either. The slot rows have no TTL; there is at most one per answered message, bounded by the daily chat budget.
- **An ambient act takes the board post's place** (it came from the same roll), so the check-in's message count is unchanged. The model gets a compact pack: the purpose, the facts by id, fenced, and the #217 situation lines as context. It adds a `social_act` action (`message`, `evidence`) or leaves it out.
- **Before posting,** `checkSocialAct` requires at least one cited id, all from the pack; no number the facts and context do not state; and no player named in the check-in's private options (pickups, drops, trade ideas) unless a fact already names him. Then the room's last word is checked again, and a league-wide claim on `social#<room>#<eventKey>` (`claimShared`, the #196 rolling-window limit store) lets one agent speak about one event in one room. Evidence ids prove where a line came from, not that it is faithful; the narrow pack and these checks limit what it can get wrong, and #211 evaluates the rest.

No extra model call: questions use the reply task's existing call, and ambient acts use the check-in's.

## State and observability

- One bounded row per league, agent, and seat tenure: `pk=LEAGUE#<leagueId>`, `sk=AGENTSOCIAL#<agentId>#<tenure>`, schema-versioned, at most 24 acts, revision-checked in DynamoDB with up to three compare-and-swap attempts like the agenda and commitments. A new occupant starts with none. Each entry records the act, reason, topic, event key, room, counterpart, evidence ids, commitment id, time, and outcome: `handed_on`, `posted`, `passed` (the model left it out), `rejected` (with the check that failed), `withheld` (`last_word`, `room_flooded`), or `failed` (the post was refused). Operational state only: it never reaches a prompt or memory.
- Operators get a log line per selection (act, reason, evidence ids, abstention, counts of expired, private, and repeated candidates) and per act. The activity log gets a generic line ("Posted a callback in #trash-talk.", "Held back a reaction to my result: someone already spoke to that.", "A question waiting on me gets its own reply.") with no evidence ids and no DM content.
- A history that cannot be read turns ambient acts off for that check-in, since repeats cannot be ruled out; questions are still answered. A failed history write is logged and the act stands.

## Privacy

What may reach a public room is decided before the prompt: the pack holds only facts the room may hear, filtered through #206 visibility. A rejected or pending offer, a waiver bid, a DM, the agenda, a commitment, bars, and thresholds are never in it. An event the agent never recorded (a trade between two other teams) cannot become a callback. The check-in's model still sees its own private options, as before; the posting check keeps their players out of the act.

## Limitations and next steps

- One ambient act per check-in, in the default board room. No acts in DMs or matchup rooms yet, and no `ask_relevant_question`.
- The number check is literal; a paraphrased number ("a dozen") or a wrong name is not caught. #211's evaluation is still needed for semantic fidelity and repetition across agents with different wording.
- A callback's tie to now is this week's matchup only. Player-level callbacks ("the back you laughed at is starting against you") need player-level records and chat evidence that is not yet stored as records.
- Outcome follow-up for promised looks stays with #215's closing lines.

## Validation

Core tests cover question finding, commitment ownership, each ambient source and its expiry, unobserved and private events, admissions only from a stored revision, precedence, the quiet roll, budget and the human reserve, every drop reason, novelty, personality affinity, the pack, each check failure, and bounded history. Agent tests run the real runner on an in-memory league: a grounded callback in place of a board post and not repeated, no callback from a private offer or an unobserved trade, rejected drafts (unknown id, unstated number, no evidence), a model pass, several agents on one event, a contended claim, a question the router never answered handed to `chat_reply` and answered in place, a question kept through budget exhaustion while ambient talk is dropped, the human reserve, and a three-day transcript with one identifiable callback and no more posts than the personality's rolls allowed. Both repository backends test tenure isolation and racing writes.
