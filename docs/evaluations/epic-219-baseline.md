# Epic #219 baseline: managers with ongoing goals, against their ablations

The first measurement the epic asks for (#219, "Measurement and definition of done"): the managers' new state, merged in #237–#241, compared with matched runs that switch one part of it off. Everything here is offline and deterministic: the scripted model, #211's season scenario on the committed fixture, and the epic's acceptance scenario. It records a baseline. It sets no thresholds and says nothing about live-model prose.

Reproduce (a few minutes on a laptop; the numbers are identical on every run):

```sh
npm run sim:baseline -w @fantasy/sim -- --seeds base-1,base-2,base-3 --markdown baseline.md
```

CI runs the same code on seeds `base-1` and `base-2` (`packages/sim/src/eval/baseline.<config>.test.ts`) and asserts only invariants: agent chat inside its budgets (25 per agent and 100 per league in any 24 hours), no refused agent action, no duplicate offer or reply, no invariant violation or event-loop failure. No test pins the numbers below.

## Configurations

| Configuration | What is switched off (`@fantasy/agents` `AGENT_ABLATIONS`) |
|---|---|
| `full` | Nothing: production's runtime |
| `no_agenda_commitments` | No agenda goals (#214) and no chat commitments (#215). A trade pitched in chat takes #196's plain follow-up |
| `no_situation` | No situational modifiers (#217). Every lever is the archetype's baseline |
| `no_attachments` | Attachments (#216) are never read: no premium, override, or admission. Ingestion still records them |
| `no_social_acts` | No social-act selection (#218): no question hand-off and no grounded act. The board roll is league news again |

The seam is one optional runner dependency (`RunnerDeps.ablations`, passed through `inProcessAgentDeps`, `replayLeague`, and `runSeasonScenario`). Production never sets it, so every default is unchanged. The opt-in live evaluation accepts the same four names in `--conditions` ([agent-eval.md](../agent-eval.md#ablations)).

## Headline

Season-layer means over three seeds (change from `full` in brackets), and acceptance checks held by the balanced, cautious, and trade-happy managers.

| Configuration | Adds (churn) | Offers sent | Agent messages | Model calls | Est. cost (USD) | Repeated lines | Unanswered questions | Invalid actions | Acceptance checks |
|---|---|---|---|---|---|---|---|---|---|
| `full` | 46 | 5 | 76.3 | 503.7 | 1.099 | 24 | 0 | 0 | 7/7 · 7/7 · 7/7 |
| `no_agenda_commitments` | 45.3 (−0.7) | 5 (0) | 75.3 (−1) | 510 (+6.3) | 1.132 (+0.033) | 25.7 (+1.7) | 0 | 0 | 1/7 · 1/7 · 1/7 |
| `no_situation` | 45.3 (−0.7) | 5 (0) | 76.3 (0) | 504 (+0.3) | 1.074 (−0.025) | 24 (0) | 0 | 0 | 7/7 · 7/7 · 7/7 |
| `no_attachments` | 39.7 (−6.3) | 5.3 (+0.3) | 72.7 (−3.7) | 499.7 (−4) | 1.088 (−0.011) | 23.7 (−0.3) | 0 | 0 | 7/7 · 7/7 · 7/7 |
| `no_social_acts` | 46 (0) | 4.7 (−0.3) | 78 (+1.7) | 504.3 (+0.7) | 1.099 (0) | 31 (+7) | 0 | 0 | 7/7 · 7/7 · 7/7 |

What the numbers say, and do not:

- **The new state costs nothing measurable.** Model calls, tokens, and message volume stay within about 1% of every ablation, and no configuration came near a chat budget (at most 5 messages from one agent in a day against 25). The epic's aim, continuity without more volume or spend, holds on this baseline.
- **Agenda and commitments are what the acceptance scenario rests on.** Without them the same pitch gets #196's plain look: no goal, no commitment, no recorded reason, no closing line after a decline, and no reconsideration after the second injury. The manager never comes back to the person. Six of the seven checks fail for all three managers; only the audience check still holds.
- **Social acts reduce repetition.** Without the selector, repeated agent lines rise from 24 to 31 per season (+29%) and messages rise slightly, because a board roll falls back to generic league news.
- **Situation is nearly inert over three weeks.** A heuristic label needs two consecutive finalized weeks and three final games (ADR 005), so on the fixture it barely engages; only prompt tokens change (−17k). A full-season archive is needed to measure it.
- **Attachments move trades, and everything after them.** Without the premium one more trade was processed across three seeds, and the diverging rosters changed waiver churn (−6.3 adds). With three seeds this is within the variation between seeds (38 to 55 adds in `full`), so treat it as a direction to look at, not an effect.

## Season layer

Season layer: #211's season scenario, 3 fixture weeks, seeds base-1, base-2, base-3, scripted model. Each cell is the mean over seeds, the change from `full`, then each seed's value.

#### Roster churn (agents)

| Configuration | adds | drops | tradesProcessed |
|---|---|---|---|
| full | 46 (—; 45 / 55 / 38) | 46 (—; 45 / 55 / 38) | 0.6667 (—; 0 / 1 / 1) |
| no_agenda_commitments | 45.3 (-0.6667; 42 / 50 / 44) | 45.3 (-0.6667; 42 / 50 / 44) | 0.6667 (+0; 0 / 1 / 1) |
| no_situation | 45.3 (-0.6667; 44 / 54 / 38) | 45.3 (-0.6667; 44 / 54 / 38) | 0.6667 (+0; 0 / 1 / 1) |
| no_attachments | 39.7 (-6.3; 35 / 46 / 38) | 39.7 (-6.3; 35 / 46 / 38) | 1.3 (+0.6667; 1 / 2 / 1) |
| no_social_acts | 46 (+0; 45 / 55 / 38) | 46 (+0; 45 / 55 / 38) | 0.6667 (+0; 0 / 1 / 1) |

#### Invalid action attempts

| Configuration | invalidActions |
|---|---|
| full | 0 (—; 0 / 0 / 0) |
| no_agenda_commitments | 0 (+0; 0 / 0 / 0) |
| no_situation | 0 (+0; 0 / 0 / 0) |
| no_attachments | 0 (+0; 0 / 0 / 0) |
| no_social_acts | 0 (+0; 0 / 0 / 0) |

#### Trade offers

| Configuration | offersSent | offersAccepted |
|---|---|---|
| full | 5 (—; 3 / 6 / 6) | 0 (—; 0 / 0 / 0) |
| no_agenda_commitments | 5 (+0; 3 / 5 / 7) | 0 (+0; 0 / 0 / 0) |
| no_situation | 5 (+0; 3 / 6 / 6) | 0 (+0; 0 / 0 / 0) |
| no_attachments | 5.3 (+0.3333; 4 / 6 / 6) | 0.3333 (+0.3333; 0 / 1 / 0) |
| no_social_acts | 4.7 (-0.3333; 3 / 5 / 6) | 0 (+0; 0 / 0 / 0) |

#### Message volume and cost

| Configuration | agentMessages | maxAgentPerDay | modelCalls | inputTokens | outputTokens | costUsd |
|---|---|---|---|---|---|---|
| full | 76.3 (—; 80 / 80 / 69) | 3.3 (—; 3 / 3 / 4) | 503.7 (—; 508 / 509 / 494) | 710141 (—; 713851 / 722411 / 694161) | 15677 (—; 15918 / 16145 / 14968) | 1.1 (—; 0.9864 / 1.0 / 1.3) |
| no_agenda_commitments | 75.3 (-1; 80 / 80 / 66) | 3.7 (+0.3333; 3 / 4 / 4) | 510 (+6.3; 515 / 505 / 510) | 718731.7 (+8590.7; 724391 / 712200 / 719604) | 15817.7 (+140.7; 16155 / 15818 / 15480) | 1.1 (+0.0333; 1.0 / 0.9998 / 1.4) |
| no_situation | 76.3 (+0; 80 / 80 / 69) | 3.3 (+0; 3 / 3 / 4) | 504 (+0.3333; 508 / 510 / 494) | 693187.7 (-16953.3; 696594 / 705673 / 677296) | 15700 (+23; 15906 / 16226 / 14968) | 1.1 (-0.0247; 0.9649 / 1.0 / 1.2) |
| no_attachments | 72.7 (-3.7; 68 / 81 / 69) | 4 (+0.6667; 3 / 5 / 4) | 499.7 (-4; 489 / 516 / 494) | 704803.3 (-5337.7; 686202 / 734119 / 694089) | 15282.3 (-394.7; 14867 / 16012 / 14968) | 1.1 (-0.0103; 0.9319 / 1.1 / 1.3) |
| no_social_acts | 78 (+1.7; 82 / 83 / 69) | 3.3 (+0; 3 / 3 / 4) | 504.3 (+0.6667; 506 / 513 / 494) | 711378.3 (+1237.3; 712822 / 727359 / 693954) | 15650.7 (-26.3; 15893 / 16145 / 14914) | 1.1 (+0.0004; 0.9904 / 1.0 / 1.3) |

#### Unanswered human questions

| Configuration | questions | unansweredQuestions |
|---|---|---|
| full | 3 (—; 3 / 3 / 3) | 0 (—; 0 / 0 / 0) |
| no_agenda_commitments | 3 (+0; 3 / 3 / 3) | 0 (+0; 0 / 0 / 0) |
| no_situation | 3 (+0; 3 / 3 / 3) | 0 (+0; 0 / 0 / 0) |
| no_attachments | 3 (+0; 3 / 3 / 3) | 0 (+0; 0 / 0 / 0) |
| no_social_acts | 3 (+0; 3 / 3 / 3) | 0 (+0; 0 / 0 / 0) |

#### Repeated or duplicate lines

| Configuration | repeatedLines | duplicateReplies | duplicateOffers |
|---|---|---|---|
| full | 24 (—; 28 / 24 / 20) | 0 (—; 0 / 0 / 0) | 0 (—; 0 / 0 / 0) |
| no_agenda_commitments | 25.7 (+1.7; 28 / 29 / 20) | 0 (+0; 0 / 0 / 0) | 0 (+0; 0 / 0 / 0) |
| no_situation | 24 (+0; 28 / 24 / 20) | 0 (+0; 0 / 0 / 0) | 0 (+0; 0 / 0 / 0) |
| no_attachments | 23.7 (-0.3333; 20 / 31 / 20) | 0 (+0; 0 / 0 / 0) | 0 (+0; 0 / 0 / 0) |
| no_social_acts | 31 (+7; 34 / 35 / 24) | 0 (+0; 0 / 0 / 0) | 0 (+0; 0 / 0 / 0) |

#### Personality differentiation (season)

Per-agent means by archetype over every seed (offers sent / adds / messages), then the agents counted.

| Configuration | Archetypes |
|---|---|
| full | analytics_only 1 / 5 / 12 (n 3); balanced 0.5 / 4 / 9 (n 2); contrarian 1.7 / 6 / 12.7 (n 3); gut_feel_homer 0.67 / 7.3 / 10.7 (n 3); trade_happy 0 / 5.5 / 11.5 (n 2); waiver_hawk 0 / 8.7 / 9.3 (n 3); win_now 1 / 6.5 / 10 (n 2); zero_rb 0.67 / 8.3 / 11.3 (n 3) |
| no_agenda_commitments | analytics_only 1 / 4.3 / 12 (n 3); balanced 0.5 / 5 / 8.5 (n 2); contrarian 1.3 / 6.7 / 11.3 (n 3); gut_feel_homer 0.67 / 7.7 / 9 (n 3); trade_happy 0 / 6 / 14.5 (n 2); waiver_hawk 0 / 8 / 8.3 (n 3); win_now 1.5 / 6.5 / 10 (n 2); zero_rb 0.67 / 7 / 12.7 (n 3) |
| no_situation | analytics_only 1 / 5 / 12 (n 3); balanced 0.5 / 4 / 9 (n 2); contrarian 1.7 / 6 / 12.7 (n 3); gut_feel_homer 0.67 / 7.3 / 10.7 (n 3); trade_happy 0 / 5.5 / 11.5 (n 2); waiver_hawk 0 / 8.7 / 9.3 (n 3); win_now 1 / 6.5 / 10 (n 2); zero_rb 0.67 / 7.7 / 11.3 (n 3) |
| no_attachments | analytics_only 1 / 4.7 / 10.3 (n 3); balanced 0.5 / 3.5 / 8 (n 2); contrarian 1.7 / 5.3 / 12.7 (n 3); gut_feel_homer 0.67 / 6 / 9.3 (n 3); trade_happy 0 / 6 / 14.5 (n 2); waiver_hawk 0 / 7 / 7.7 (n 3); win_now 1 / 6 / 9 (n 2); zero_rb 1 / 6.3 / 11.7 (n 3) |
| no_social_acts | analytics_only 1 / 4.7 / 13 (n 3); balanced 0.5 / 4 / 9 (n 2); contrarian 1.3 / 6 / 12 (n 3); gut_feel_homer 0.67 / 7.3 / 10.7 (n 3); trade_happy 0 / 6 / 11 (n 2); waiver_hawk 0 / 8.7 / 10 (n 3); win_now 1 / 6.5 / 11 (n 2); zero_rb 0.67 / 8.3 / 11.7 (n 3) |

## Acceptance layer

The scenario is described in [sim.md](../sim.md#epic-219-acceptance-scenario-and-baseline-srcacceptance-srcevalbaselinets). Its per-manager usage: the balanced and trade-happy managers make 14 model calls (about $0.069 estimated), the cautious one 12 ($0.054), in every configuration but `no_agenda_commitments` (10 to 11 calls: no reconsideration look).

Checks held (of 7) for the balanced, cautious (`analytics_only`), and trade-happy managers; the marginal pitch outcome and offers sent show whether the cautious and eager managers still choose differently.

| Configuration | Balanced | Cautious | Trade-happy | Cautious vs trade-happy | Failed checks |
|---|---|---|---|---|---|
| full | 7/7 (offer_sent, 2 offers) | 7/7 (value_below_floor, 1 offers) | 7/7 (offer_sent, 2 offers) | differ | none |
| no_agenda_commitments | 1/7 (none, 1 offers) | 1/7 (none, 0 offers) | 1/7 (none, 1 offers) | differ | one_objective, commitment_from_pitch, accurate_decisions, linked_once, reconsidered, goal_closed |
| no_situation | 7/7 (offer_sent, 2 offers) | 7/7 (value_below_floor, 1 offers) | 7/7 (offer_sent, 2 offers) | differ | none |
| no_attachments | 7/7 (offer_sent, 2 offers) | 7/7 (value_below_floor, 1 offers) | 7/7 (offer_sent, 2 offers) | differ | none |
| no_social_acts | 7/7 (offer_sent, 2 offers) | 7/7 (value_below_floor, 1 offers) | 7/7 (offer_sent, 2 offers) | differ | none |

## Trade behaviour by archetype (supplementary, eight seeds)

Offers per agent looked flat across archetypes on three seeds, so the `full` configuration was also run on `base-1` to `base-8`:

| Archetype | Agents | Offers sent | Offers per agent | Check-ins that shopped for a trade |
|---|---|---|---|---|
| `contrarian` | 6 | 7 | 1.17 | 27 |
| `win_now` | 7 | 8 | 1.14 | 43 |
| `balanced` | 7 | 6 | 0.86 | 23 |
| `analytics_only` | 7 | 6 | 0.86 | 16 |
| `trade_happy` | 6 | 4 | 0.67 | 87 |
| `gut_feel_homer` | 7 | 4 | 0.57 | 11 |
| `zero_rb` | 8 | 3 | 0.38 | 29 |
| `waiver_hawk` | 8 | 2 | 0.25 | 3 |

Trade-happy managers shop three to eight times as often as the others and send no more offers. The reason is a floor, not chance: a proposal must clear `max(acceptEdge, MIN_PROPOSAL_GAIN)`, and `acceptEdge` is at or below 1 for every archetype with a trade frequency of 0.4 or more, so balanced, contrarian, win-now, and trade-happy all propose at the same bar of 1. Looking more often at an unchanged market finds nothing new. The acceptance scenario shows the other side: the difference appears when someone pitches a marginal swap (cautious bar 2 declines, trade-happy bar 1 offers). This is left unchanged here, deliberately: lowering the proposal floor for one archetype would lower the economic floors #208 and #216 keep, and eight seeds of a three-week fixture are not enough to calibrate it. It is the first candidate once a full-season archive run exists.

## Findings

Fixed in this change, each with a test:

1. **A lopsided decline claimed the value was not there.** A pitch the trade value math calls lopsided was declined as `value_below_floor` even when it favoured the agent (score 33.8 against a bar of 1), and the closing line told the person "the value was not there for me". It is now its own reason, `lopsided` ("it was too one-sided to be fair"), and is not reconsidered.
2. **A withdrawn offer was remembered as open.** `Trade Withdrawn` was not a memory event, so an offer the person took back stayed `proposed` in the agent's memory and was recalled as live. It now closes the trade in memory as `withdrawn` (private to the two teams); the router rule in `infra/template.yaml` lists the event.

Reported, not changed:

- The trade-happy proposal floor (above).
- With no projections for the week, a pitch is declined as `value_below_floor` with a score of 0. Nothing is sent, which is right, but "the value was not there" is weaker than "I could not value it".
- A check-in delayed past league completion still tries to set a lineup and records the refusal. The job never publishes check-ins for complete leagues, so only a delayed one can hit this.
- A chat-driven offer's activity summary starts "Reconsidered: ... pitch won me over" even on a first look whose numbers cleared the bar without the argument.
- A trade memory line carries the offer's value ("you won it") after the offer expired unanswered.

## Caveats

- **Scripted model.** Every task is decided by the fake model and the deterministic code around it. Prose, persona, and whether a live model uses the new prompt context are not measured; that is the opt-in live evaluation's job. Repeated lines are inflated by the fake model's canned text; compare configurations, not the absolute count.
- **Cost is an estimate.** Tokens are the fake model's text-length estimate at the seats' catalog prices, from the runner's usage ledger. A live model writes more and loops through tools.
- **Three seeds, three weeks.** Seeds vary more than most ablation effects (adds range 38 to 55 in `full`). Differences under that spread are directions, not effects. The fixture's three weeks leave situation and outcome-based conviction mostly unexercised.
- **One scripted person.** The stand-in makes the same three probes each season; unanswered questions has `n` = 3 per run.
- **Acceptance scenario.** It is one designed story. It proves the mechanisms link up end to end; it does not show how often they fire in a real league.
