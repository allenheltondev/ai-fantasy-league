# ADR 006: Evidence-backed player attachments

Status: accepted, first slice of #216 (drafted and traded-for attachment, one override rule). The broader player-behavior roadmap is #219.

## Problem and decision

Managers treat every roster player as interchangeable value. A person who drafted a player they believe in holds out for a better offer; one who needs a healthy starter this week moves him anyway. Natural-language memory cannot carry that reliably: it is lossy, a model can write anything into it, and it has no bounded effect on a decision. Keep a small, typed set of player preferences beside memory (#210) and the agenda (#214), created only from league records, revised by results, and applied through one pure, capped policy.

## State and lifecycle

- Core owns the schema, pure updates, conviction, policy, and prompt projection in `packages/core/src/agents/attachments.ts`.
- Repositories store one schema-versioned row per league, agent, and seat tenure: `pk=LEAGUE#<leagueId>`, `sk=AGENTATTACH#<agentId>#<occupiedSince-or-createdAt>`. A new occupant starts empty, and a pick or trade from before its tenure is never recorded for it. DynamoDB uses consistent reads, a revision condition, and up to three compare-and-swap attempts, like the agenda. No migration or index; a missing row reads as empty.
- One preference type, `attachment`. Each records the player, strength (the strongest source, 0.4-0.7), stored conviction and confidence, up to four source refs, up to six weeks of results, up to three revisions, created/updated/review/held-since/departed times, and a #206 visibility (`public`: every source so far is a public move). At most five held players and ten former ones; source keys are remembered (96) so a pick that did not make the cut cannot reshuffle the set on redelivery.
- Sources (`packages/agents/src/attachments.ts`, from `ingestLeagueEvent`, adding no new event subscriptions): `Draft Completed` reads the draft record and attaches the agent to its own non-autopick picks it still rosters; `Trade Processed` attaches it to players received and ends attachments to players sent or dropped. Keys are `draft:<leagueId>:<overall>` and `trade:<tradeId>:<playerId>`, so redelivery and replay are no-ops, and sources never add up (the strongest wins).
- Revision (before a trade decision, `refreshAttachments`): the team record ends attachments to players no longer rostered; while something is held, one `get_roster` read of the previous week records each held player's final points against his projection. Results are stored per week, so a later read of the same week (a stat correction) replaces it and an older read is ignored. Conviction is derived, not accumulated: the source strength decays with a 42-day half-life toward half of itself, and results shift it by at most 0.1 a week and 0.5 in all. One bad week cannot erase a conviction; five straight short weeks can. A departure or return, or a change of at least 0.15 since the last revision (or crossing the 0.2 point where it stops counting), keeps a short causal record ("Fell short of projection in 3 of the last 4 weeks", "Traded away") for a later admission.

## Decision effects

`attachmentAdjustment` returns the premium, the part waived, the applied adjustment, and per-player detail, so base bar, adjustment, and result are separately inspectable. Each held attachment above the conviction threshold adds `conviction × 4 × personality scale` trade-score points (capped at 4 per player, 6 per decision) to the bar when the trade would send that player away. The scale comes from the archetype's `tradeFrequency` (1.1 cautious down to 0.58 trade-happy), so a cautious manager holds on harder. The premium only raises the bar: attachment is never a reason to accept a worse deal and never lowers a floor.

The override rule: when the incoming players can fill an active agenda goal this week (#214), the premium on attached players who cannot fill that slot themselves is waived. A favorite is not moved to repair his own position. The base bar, the #208 accept and counter floors, legality, locks, and action limits apply unchanged; a waived premium brings the bar back to its base, not below.

- Trade answers (`trade_response`): bar and accept floor include the adjustment; the suggested counter keeps the favorite out, and a counter is floored by its own terms' adjustment. A plain answer now reads the agenda deterministically (`guide_only`); a chat-driven one cannot (`refresh_only`), so its chat reply and its choice see the same inputs.
- Trade scouting (`trade_proposal`, the check-in's trade look, chat pitches): a swap sending an attached player must clear bar plus adjustment.
- Summaries say which way the conflict went. The activity log (sealed while the offer is private) says "Held X to a higher bar" or, generically, "Set aside my attachment to X for a roster need", with no slot or goal id. The agent's own decision memory, which later chat prompts may recall once the trade is public, records only the attachment side and no agenda information.

## Privacy and prompts

Trade prompts name only held, non-waived attachments on the players the decision would send, as evidence ("you drafted him in round 1 and still believe in him"), never the premium. The agenda need that waives one is not named, since that model writes to the other manager (ADR 004). The visibility filter treats seals as holding. Chat tasks get no attachment context in this slice. No model call is added; a failure to read or write attachments is logged and the decision proceeds without them.

## Deferred

Waiver-pickup sources, other preference types (belief in upside, disappointment, willingness to move), chat and check-in conversation use of revisions, outcome-based confidence beyond week results, and the multi-seed simulation evaluation of personality differentiation and hoarding (#211) remain open. The constants are calibration choices to revisit with that evaluation.

## Validation

Core tests cover attribution, idempotency, non-additive sources, bounded decay, sustained versus one-week revision, stat-correction replacement and out-of-order reads, departure and return, bounds, caps across personalities, the agenda override, the base floor, and empty state for new agents. Both repository backends test tenure isolation, idempotent writes, and concurrent updates. Runtime tests cover draft and trade ingestion, summaries that keep the need generic and out of memory, (autopicks, released players, human seats, pre-tenure records, redelivery, ingestion failure), revision from last week, trade answers, counters, scouting, chat pitches, and the prompt through the runner.
