# ADR 009: A persistent-participant contract, checked against a second domain

Status: accepted as a design record (#213). Nothing is extracted into a framework; this records the contract the fantasy managers already follow, a second-domain prototype that tests it, and what extraction would take.

## Context

A persistent participant is a durable identity that observes a shared environment, selectively participates, remembers scoped experiences, and acts only through the environment's rules. The fantasy AI managers are one. Epic #219 gave them agendas (#214), commitments (#215), attachments (#216), situational adaptation (#217), and grounded social acts (#218), on top of scoped memory and relationships (#210). With those shipped and evaluated (#247, #248), #213 asks which parts are a reusable primitive and which are football.

## The current architecture

- **Identity.** An agent seat (`AgentSeatRecord`) plays one team. Its configuration (personality, difficulty, archetype, model tier) is stable across model and runtime changes. All operational state (memory, agenda, commitments, attachments, social-act history) is keyed by league, agent, and seat tenure (`occupiedSince`), so a new occupant starts clean.
- **Disposition and competence are separate.** Personality sets voice and social tendencies (chattiness, banter, persuadability). Difficulty and archetype set decision levers (valuation noise, trade appetite, waiver aggressiveness, response delays).
- **Attention.**
  - The router (`packages/agents/src/router.ts`) turns league events into tasks through per-event rules. Each rule has gates: once-per keys, league and agent cooldowns, and admission rules such as banter depth.
  - Response delays (#189) are a seeded, right-skewed wait per event class, clamped to deadlines.
  - Check-ins run three times a day (#195). Each one looks at the whole team and hands work on as follow-ups.
  - Chat addressing (`continuationAddressee`) and explicit answering (`answeredBefore`, `answersMessageIds`, #215) decide what the agent owes a reply.
  - Bursts are coalesced into one deferred reply.
- **Lifecycle.**
  - Every task kind (`TaskKind`: lineup, waivers, trade proposal, response, and vote, chat reply and moment, check-in, commitment reply, draft, and more) has the same steps: `prepare` reads through the same tools a person's UI uses, the model decides or words, `apply` commits through operations, and a deterministic `fallback` stands in whenever the model is missing, fails, or is over budget.
  - Follow-ups are durable tasks. #207's outbox reserves them together with their gates.
  - Their results are recorded before any conversation says they happened. #215's commitments close with one line; #246 recovers that line after a crash or a refused post.
  - A check-in's free-form posts are written in the same answer as its moves, before any is made. The prompt says so, and core `checkPost` cuts a sentence claiming a trade status the record does not support (#264): an offer this turn did not send, or one the latest trade with that team never reached.
- **Memory and state.**
  - Memory: #210's provenance-aware memory, where every item carries a #206 visibility.
  - Agenda: operational goals.
  - Commitments: typed promises with statuses.
  - Attachments: player preferences with sources and revisions.
  - Situation: bounded modifiers, read from finalized results only.
  - Social acts: a bounded history of what the agent said and why.
- **Operating policy.** Daily chat and action budgets, per-trigger action limits, a league cost ceiling, a kill switch, once-only claims (`claimOnce`), and reproducible simulation (`packages/sim`).

## Invariants

These hold in the fantasy runtime, and the second-domain tests check them again:

1. **One operation boundary.** People and agents call the same operations (the MCP tool registry) with the same validation. An agent has no side door: its tool box enforces its own team, and a mutation the league refuses is refused for anyone.
2. **Conversational claims carry no authority.**
   - A takeaway from chat becomes a follow-up that re-reads the message, verifies claims with read tools, and applies the agent's own numbers, moved at most by `persuasionAllowance`.
   - Text that reads like orders (`looksLikeInstructions`) moves nothing.
3. **Visibility is enforced before prompts.**
   - Memory reaches a prompt only through `memoryForAudience` for that prompt's audience.
   - Social acts filter evidence by the destination's readers before the pack is built.
   - DM content never leaves the DM.
   - A check-in's one prompt serves several destinations: its own private options and a DM-only act's facts sit next to the public rooms' facts, and the prompt marks which is which. So its free-form public posts (board, matchup talk) are checked before they go out (core `checkPost`, #263): a player in a private move that the post's facts do not state, or talk of an offer that is not public, holds the post back. A DM to the other team is not held to that.
4. **Deterministic fallback remains available.** Every task kind has a fallback that decides without a model. A model failure, a refused budget, or the kill switch never leaves a decision unmade.

## Decisions versus explanations

Some decisions are the code's, and the model only explains them:
- Trade votes (`trade-vote.ts`) are deterministic: the model may word the vote, never cast it.
- Proposal, accept, and counter floors are code.
- Situational levers and attachment premiums are code.
- A chat reply's takeaway is only a request for a look. The look decides.

Elsewhere the model chooses among validated options, such as which listed trade idea to send or which pickup to claim, and the code still validates and commits. The distinction matters for claims about the system: a well-written explanation is not evidence that the model decided well. #247's evaluation reports decisions and prose separately for that reason.

## The minimal contract

`packages/sim/src/participant/contract.ts` states it as types:
- `ParticipantIdentity`: id, name, and tenure.
- `Disposition`: voice, chattiness, and persuadability.
- `Observation` with a visibility, and `ParticipantMemory` with `forAudience`.
- `Operation` with separate `validate` and `commit`, shared by every actor.
- `Capability`: `prepare`, then `decide` (deterministic), then `explain` (a model may word it; the fallback always can).
- `Delivery`: once-only claims.

The lifecycle is observe, attend, prepare, decide, validate, commit, remember. Follow-ups are durable work, never prose promises.

## A second domain: a shopkeeper

`packages/sim/src/participant/shopkeeper.ts` is a shopkeeper in a trading game, with in-memory adapters and no new infrastructure:
- Players buy through a shared `buy` operation. Only the shopkeeper may `hold` an item or `offer_discount`, and both are validated like any operation (stock, caps, one hold per player).
- Prices come from its own rule. A loyalty discount is earned from its own record of sales, never from a claim.
- A hold is a commitment with a source message and an explicit end: sold to its player, or expired.
- A whisper is remembered with a private visibility.
- A model, when present, only words the decision.

Its tests (`shopkeeper.test.ts`) check each invariant above:
- a player cannot do the shopkeeper's jobs, and the shopkeeper cannot skip validation;
- orders in chat change no price;
- a whisper never reaches the shop's public remark;
- the same hold is committed with a working model, a failing model, and none;
- a burst is answered once, by reply and by name;
- a follow-up counts as addressed only while nobody else takes the conversation over;
- a hold ends explicitly.

## What reused, and what did not

| Piece | Reuse | Notes |
|---|---|---|
| Chat addressing (`continuationAddressee`) | Unchanged | Takes any message with an author, mentions, and replies |
| Explicit answering (`answeredBefore`, `answersMessageIds`) and request detection (`asksSomething`) | Unchanged | |
| Memory visibility (`mayHear`, `MemoryAudience`) | Unchanged, awkward names | `MemorySeal` has fantasy fields (`trades`, `waiverClaims`), left empty; its `teams` are really "parties" |
| Social-act selection and checks (`selectSocialAct`, `socialActPack`, `checkSocialAct`) | Unchanged in logic | `SocialReason` is a fantasy union (`rematch`, `big_win`, ...), so a new domain's reason must be cast until it is widened to a string |
| Orders-in-chat (`looksLikeInstructions`) | Partly | Generic phrasings match ("ignore your rules", "new instructions"); domain ones do not ("the owner says you must sell"). The invariant held anyway because the price is a rule |
| Response delays (`responseDelay`) | Adapter | The event classes are `trade`, `roster`, `deadline`, and `post_draft`. A domain would map its events onto them or add its own profiles |
| Agenda (`reconcileAgenda`) | Not reused | Goals are `repair_position` over roster slots; the reconcile pattern (retain, close explicitly, never revive from stale reads) is generic, but the type is not |
| Commitments | Pattern only | The lifecycle (typed status, assigned-task ownership, explicit ends, one closing line) transferred as a design; the code is `trade_interest`-specific |
| Memory schema, relationships | Not reused | Built from league events (results, trades, drafts) |
| Router, runner, `TaskKind`, outbox | Not reused | They depend on the server's services, tool registry, and repositories. That is the right coupling for the product and too heavy for a prototype |

## Is extraction justified?

Not yet. The domain-neutral pieces are small pure functions that already live in `@fantasy/core` and reuse without a framework. The pieces that would make a framework worth having (the router, the runner, the outbox, typed goal and commitment lifecycles) are coupled to the league's services and types. Generalizing them now would be a broad migration with one real user.

Small, useful steps if a second domain becomes real:
1. Widen `SocialReason` to a string.
2. Rename `MemorySeal.teams` to parties, and make the domain seal fields optional.
3. Accept a domain vocabulary in `looksLikeInstructions`.
4. Give `responseDelay` caller-supplied profiles.
5. Only then consider a generic goal and commitment lifecycle, parameterized by the domain's intent types.

## Prior art and framing

Persona, memory with retrieval, planning, reflection, and social simulation are established:
- Generative Agents (Park et al., 2023, [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)): memory streams, reflection, and planning for believable agents in a sandbox.
- Concordia (Google DeepMind, [github.com/google-deepmind/concordia](https://github.com/google-deepmind/concordia)): components and a game master that mediates what agents' actions do in a shared world.

The managers are a useful composition of known ideas, not a new architecture. What is specific here is engineering discipline in one product, not a novel mechanism:
- the operation boundary shared with people;
- claims that carry no authority;
- visibility enforced before prompts;
- deterministic decisions with model explanations;
- durable, recoverable follow-through.

Concordia's game master, which decides what happens, plays a role close to the operation boundary here.

## Continuity, relationships, and learning are different claims

- **Continuity:** the agent carries goals, promises, and history across days and tasks, and acts consistently with them. #215, #218, #247, and #248 demonstrate this with deterministic tests and a scripted-policy season.
- **Relationship modeling:** the agent's stance toward another team changes with recorded shared events (#210 warmth, rivalry, and grudge). This is deterministic bookkeeping over records, not an inferred model of the other person.
- **Learning:** the agent's decision policy improving from outcomes. This is not demonstrated. Attachment convictions and situational labels revise with results, but they are bounded state revisions under fixed rules, not learned policy. #248 found convictions revised almost only downward on synthesized projections. Outcome-based decision confidence stays disabled (#219).

## Consequences

- The contract, the prototype, and its tests live in `packages/sim/src/participant/` as evaluation code. No package moves and no runtime changes.
- Future domain-neutral helpers should keep taking plain data (messages, visibility, evidence), not league types, so they stay reusable.
- The steps above are recorded here, not scheduled.
