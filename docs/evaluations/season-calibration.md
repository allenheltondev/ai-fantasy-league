# Season calibration: situational adaptation and attachments (#248)

The epic #219 baseline ran three fixture weeks, which barely reach the rules in ADR 005 and give attachments (ADR 006) almost no time to form, revise, or depart. This run replays the whole 2025 season (12 regular weeks and the playoffs, 17 league weeks) on five matched seeds for the full runtime and for each ablation. It asks two questions: whether the mechanisms engage over real exposure, and whether switching them off changes decisions and outcomes. It uses the scripted model only. It sets no thresholds on the models' prose or judgment.

Reproduce (about 70 minutes on a laptop, no model spend; build the archive first):

```sh
npm run sim:archive -w @fantasy/sim -- --season 2025
npm run sim:calibrate -w @fantasy/sim -- --seeds cal-1,cal-2,cal-3,cal-4,cal-5 --weeks 17 \
  --report calibration.json --markdown calibration.md
```

The numbers are in [season-calibration/calibration.md](season-calibration/calibration.md) and the raw per-run report is in [season-calibration/calibration.json](season-calibration/calibration.json). The harness is `packages/sim/src/eval/calibration.ts`.

## How it is matched and measured

- **Matched.** A seed fixes the draft order, each seat's personality, difficulty, and archetype, the clock, and the ids. `full`, `no_situation`, and `no_attachments` run on the same five seeds, and every change below is taken seed by seed (the mean change ± its spread, and how many seeds moved each way).
- **Exposure.** It comes from what agent tasks actually read, not from recomputation. The replay now takes an `observe` hook that receives every structured log line with the replay clock. The runner's `agent situation` line gained the week, the finalized week it read, and the positions short or thin. A new `agent attachment adjustment` line records each trade decision an attachment premium touched (no player names).
- **Hindsight.** A situation that reads a finalized week past the league's current week (`throughWeek > week`) is counted as a violation.
- **Integrity.** Every run counts invariant violations, event-loop failures, refused agent actions, and held attachments whose player is off the roster.

## Results

| | `full` | `no_situation` (Δ matched) | `no_attachments` (Δ matched) |
|---|---|---|---|
| Agent points for, per agent | 1444.6 ± 30.7 | −25.9 ± 17.7 (down in 5 of 5) | +14.8 ± 27.5 (up in 4 of 5) |
| Agent wins, per agent | 7.03 | +0.03 ± 0.25 | +0.09 ± 0.07 |
| Adds (churn) | 462 | +23 ± 47.5 | −12.6 ± 23.8 |
| Offers sent | 54 | −0.8 ± 6.5 | −5.2 ± 8.6 |
| Trades processed | 18.6 | −2.8 ± 4.0 | −2.4 ± 3.9 |
| Invalid action attempts | 0 | 0 | 0 |
| Agent messages | 597 | −0.6 ± 26.6 | −7.2 ± 11.3 |
| Model calls | 2658 | +15.2 ± 24.8 | −10 ± 32.1 |

**Situational states are all exercised.** Over the five `full` seasons, agent tasks read about 21,000 situations. Every label occurs across 36 to 169 agent-weeks each: baseline (early season), contender, bubble, long shot, clinched, eliminated, and playoff-alive. There were 139 label changes, and 11,157 reads rested on a heuristic label and 4,980 on an exact one. There were no hindsight reads. Roster pressure is common: 4,235 reads saw a position short and almost every read saw some position thin, so the depth rules are exercised too.

**Situation helps a little, consistently.** Switching it off lowered the agents' points in all five seeds, by 25.9 per agent on average (about 1.8%), with a spread of 17.7. Wins did not move (+0.03 ± 0.25), because points against dominate a 12-game record. Messages and model calls stayed within noise, and so did cost (−$0.21 ± 0.27 of an estimated $5.70). This supports keeping ADR 005's rules and constants as they are. It is a scripted-policy result: the levers change deterministic code, so this is where they should show, but it says nothing about how a live model uses the situation lines in its prompt.

**Attachments engage but do not help outcomes.** Premiums touched 672 trade decisions (599 while scouting, 73 answering offers) and raised the bar 617 times (+1.48 on average). A pressing need waived the premium 55 times. Attachments do not look like hoarding: by season's end 239 had departed (the player was traded or dropped) and 61 were still held, with no held attachment for a player off the roster. Switching attachments off did not cost points; it gained them in 4 of 5 seeds (+14.8 ± 27.5, inside the spread) and slightly reduced churn and trades. So over a full season the premium neither protects value nor causes measurable harm. That matches ADR 006's intent: a bounded preference, not a performance feature.

**Convictions only go down.** Results revised convictions 430 times downward and 19 times upward. The likely cause is the archive's synthesized projections (docs/sim.md): a player who falls short of projection is revised down, and projections that run high would make that the usual case. This should be checked against real projections before any constant changes. It is one more reason to keep outcome-based decision confidence disabled, as #219 already defers it.

**Trade-happy managers do differentiate over a season.** The three-week supplement found trade-happy managers shopping far more but sending no more offers. Over a full season they shop on 73% of check-ins (1,298 of 1,785) and send 85 offers across 5 agents, against 7 to 49 for the other archetypes. Their conversion is still low (0.07 offers per shopping check-in), because every candidate faces the same proposal floor. More looks at an unchanged market find little, but over 17 weeks the market does change. No change to the floor is recommended: the difference emerges without weakening #208's economics.

## Findings fixed in this change

Two kinds of invalid attempt appeared only over a long season (1 to 4 refused actions per run, in every configuration). Both were refused by the league, so no roster was ever wrong, but they were avoidable:

1. **Duplicate waiver claims.** A waiver task would claim a player the agent had claimed since it looked (another task landed a claim between this task's look and its claim), and the league refused it as `DUPLICATE_WAIVER_CLAIM`. `submitClaims` now reads the team's pending claims before claiming and reports such a player as "Already claimed" instead.
2. **A trade sending a player just dropped.** A check-in could pick someone up by dropping a player, then propose a trade idea (built before the pickup) that sent that same player. The league refused it as `PLAYER_NOT_ON_ROSTER`. The check-in now remembers the players its pickups released and drops any trade idea that sends one of them, saying so in its activity line.

With both fixed, every run of every configuration has zero refused actions, and every other number is unchanged.

## Recommendations

- **Constants:** no change. ADR 005's situation rules engage and help consistently. ADR 006's premium is bounded, does not hoard, and neither helps nor measurably harms. The trade-happy floor needs no change.
- **Outcome-based confidence:** stays disabled. Revisions are almost all downward on synthesized projections, so there is no sound expectation-at-decision-time record to calibrate on.
- **Proposed regression bounds** for future matched runs, to be adopted when this runs in a scheduled job:
  - invalid actions, hindsight reads, stale attachments, and invariant violations stay at 0;
  - `no_situation` should not beat `full` on points in a majority of seeds;
  - message volume and model calls stay within ±5% of `full`.

## Limitations

- **Scripted model.** The deterministic levers are exercised, and so are the attachment premium and the need override. How a live model uses the situation and attachment lines in its prompts is not; a 17-week live run costs roughly $8 or more per seed on Nova Lite at today's prompt sizes (#247 measured $1.69 for three weeks), so it was not run.
- **One archive, one league shape.** 2025, 8 teams, 7 agents, the scenario's settings. Custom settings (bye-heavy rosters, different playoff sizes) and missing-evidence cases are covered by the core unit tests, not by this run.
- **Five seeds.** Spreads are reported next to every change. Changes inside their spread (everything except `no_situation`'s points) are directions, not effects.
- **Knowledge cutoff.** This does not apply here (no model reads the season), but it would for a live run (docs/sim.md).
- **Not exercised:**
  - Seat replacement mid-season. The tenure rules are unit-tested.
  - Stat corrections that change a score. nflverse keeps one final line per week, so none occur.
