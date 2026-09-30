# ADR 005: Situational adaptation from competitive stakes

Status: accepted, first slice of #217. The broader player-behavior roadmap is #219.

## Problem and decision

An archetype plays the same way at 8-0 as at 2-6 or during an injury crisis. Managers should change recognizably with their circumstances while their personality stays fixed. Derive a compact situational state from authoritative league records, and bend three existing levers within hard caps. Outcome-based confidence (whether recent decisions worked) waits for #211's evaluation; this slice uses competitive state and roster designations only.

## State

Core owns the schema and pure functions in `packages/core/src/agents/situation.ts`.

- `computeSituation` reads finalized games (regular season and playoffs), the league's schedule and playoff settings, the team list, and the team's injury designations. It returns an urgency level with a `basis` and reason codes, the planning horizon, the team's standing, and per-position roster pressure.
- `clinched` and `eliminated` are `exact`. They come from sufficient conditions that no remaining result can undo (every other team counted at its best or worst case, ties resolved against the team), or from the final rank once the regular season is over. During the playoffs a seeded team is `playoff_alive` until it loses a bracket game; a tie goes to the better seed.
- `contender`, `bubble`, and `long_shot` are `heuristic`. They use the cushion over the first team out or the deficit to the last playoff seat, and they are labelled as a read of the standings, never as probabilities. `SITUATION_RULES` holds the thresholds.
- Missing evidence keeps `baseline`: before three final games, when every team qualifies, outside the season, or when records cannot be read. Roster pressure counts designations only (`short`: fewer available players than dedicated slots; `thin`: no healthy, undesignated backup). No variance is inferred from a point projection.
- Mid-season starts, custom playoff sizes, and custom season lengths come from settings. Games before `schedule.startWeek` do not count.

## Stability

Only `final` matchups count, so a live score cannot change the state. Games after the league's current week are ignored, so a replay at a simulated time reads only what was final at that time. A redelivered or corrected game counts once, with its latest score, and the result does not depend on input order.

Hysteresis walks the finalized weeks in order. An exact label applies immediately. A heuristic label must hold for two consecutive finalized weeks (`confirmWeeks`) before behavior follows it; until then the state reports it as `pending` with `awaiting_confirmation`. `sinceWeek` and `previous` record when and from what the current label took effect. Because the state is a pure function of the season's final results, it is not stored. No repository, migration, or seat-tenure key is needed, and a replay or retry recomputes the same value. The runner logs each task's urgency, reasons, `sinceWeek`, `previous`, `pending`, and adjustments.

## Composition

`composeBehavior(config, situation)` returns the effective behavior: the archetype's values plus bounded modifiers.

| Level | Trade look | Waiver aggressiveness | Lineup risk tolerance | Depth |
| --- | --- | --- | --- | --- |
| baseline, eliminated | 0 | 0 | 0 | - |
| clinched | -0.05 | -0.05 | -0.05 | protect thin positions |
| contender | 0 | 0 | -0.05 | protect thin positions |
| bubble | +0.10 | +0.10 | +0.05 | - |
| long_shot | +0.15 | +0.10 | +0.10 | - |
| playoff_alive | 0 | +0.10 | +0.05 | - |

A position that is `short` adds +0.05 waiver aggressiveness. `MODIFIER_CAPS` then clamps the summed adjustments (trade look -0.10 to +0.15, waiver aggressiveness -0.10 to +0.15, risk tolerance -0.10 to +0.10), and each effective value is clamped to 0-1. These values are starting policies to evaluate with #211, not claims that trailing teams should gamble.

- **Trade look:** the check-in's chance to scout the market (`checkInTradeChance`). The weekly offer count (`proposalsPerWeek`), accept edge, counters, and every trade legality and value floor, including #208's counter economics, still come from the unchanged config.
- **Waiver aggressiveness:** the FAAB share in `suggestFaabBid` and the claim bar `waiverMinGain`. Bids stay within the budget, the minimum bid, and the 40% share cap. Claim counts stay within the action limits.
- **Lineup risk tolerance:** only the discount for injury-designated players in `lineupProjection`. The optimizer, locks, and legality are unchanged.
- **Depth preservation:** a clinched team or contender does not drop its last healthy cover at a thin or short position for a pickup at another position (a same-position swap is allowed). It also does not offer that player in a trade.

An eliminated team keeps the unchanged baseline: it sets its best legal lineup and makes ordinary improvements. No level sells, dumps players, or favors another team. Tools, research access, models, and task kinds are unchanged, and no model call is added.

## Runtime and dialogue

`packages/agents/src/situation.ts` reads matchups, teams, and the team's players from the repositories before every in-season task prepares (no tool call). It stores the state on `TaskContext.situation`. Deterministic code reads levers only through `effectiveBehavior(ctx)`. A failed read logs a warning and leaves the baseline.

`situationPrompt` turns the same state into league-visible lines (record, rank, cushion, weeks left, a heuristic disclaimer, and injury shortages). The runner adds them to every model prompt, decision and chat alike, so an agent that says it needs points this week is also the one whose levers lean toward this week. The lines never mention bids, bars, or modifier values.

## Shipped versus validated (#248)

Shipped: the states, their hysteresis, and the bounded levers above. Validated on a full scripted season (five matched seeds, [season-calibration.md](../evaluations/season-calibration.md)): every state is reached in practice, no situation reads past the league's week, and switching situation off lowered the agents' points in 5 of 5 seeds (−25.9 ± 17.7 per agent, about 1.8%) without changing wins, volume, or cost. Not validated: how a live model uses the situation lines in its prompt. The constants are unchanged.

## Deferred

Recent-decision confidence (sample size, shrinkage, look-ahead guards) waits for #211. Also deferred: short-lived social responses, player preferences (#216), flex-slot pressure, seeding races when every team qualifies, pending-move awareness, and the churn/quality/cost report against the unchanged baseline, which #211's harness should produce before broad rollout.
