# League rules and default settings

Every league starts from the Yahoo public-league defaults below (`yahooDefaultSettings(teamCount)` in `@fantasy/core`). **The commissioner can edit every value before the draft.** After the draft starts, only the settings marked *mid-season* in [Editability](#editability) can change. The code is the source of truth. If this table and `packages/core/src` disagree, fix one of them in the same PR.

## Scoring

Scoring settings are a map of **Sleeper stat keys** to points (`scoring.perStat`), plus **tier rules** (`scoring.tiers`) for stats that score by bucket instead of per unit. Points are `stat value × weight`, summed across all stats, and rounded to 2 decimals only once, at the end. A tier rule applies only when the stat line contains that stat, so an offensive player never picks up points-allowed points.

Three presets differ only in reception points:

| Preset | `rec` |
|---|---|
| `yahoo_standard` (default) | 0.5 (half-PPR) |
| `full_ppr` | 1 |
| `standard` | 0 (no PPR) |

### Offense

| Stat | Sleeper key | Points |
|---|---|---|
| Passing yards | `pass_yd` | 0.04 per yard (1 per 25 yards) |
| Passing touchdowns | `pass_td` | 4 |
| Interceptions thrown | `pass_int` | -1 |
| Passing 2-point conversions | `pass_2pt` | 2 |
| Rushing yards | `rush_yd` | 0.1 per yard (1 per 10 yards) |
| Rushing touchdowns | `rush_td` | 6 |
| Rushing 2-point conversions | `rush_2pt` | 2 |
| Receptions | `rec` | 0.5 (see presets) |
| Receiving yards | `rec_yd` | 0.1 per yard (1 per 10 yards) |
| Receiving touchdowns | `rec_td` | 6 |
| Receiving 2-point conversions | `rec_2pt` | 2 |
| Fumbles lost | `fum_lost` | -2 |
| Offensive fumble recovery touchdowns | `fum_rec_td` | 6 |
| Kick and punt return touchdowns | `st_td` | 6 |

### Kickers

| Stat | Sleeper key | Points |
|---|---|---|
| FG made, 0-19 yards | `fgm_0_19` | 3 |
| FG made, 20-29 yards | `fgm_20_29` | 3 |
| FG made, 30-39 yards | `fgm_30_39` | 3 |
| FG made, 40-49 yards | `fgm_40_49` | 4 |
| FG made, 50+ yards | `fgm_50p` | 5 |
| Extra points made | `xpm` | 1 |

Missed field goals and extra points (`fgmiss_*`, `xpmiss`) score 0 by default. A commissioner can add negative weights for them.

### Team defense and special teams (DEF)

| Stat | Sleeper key | Points |
|---|---|---|
| Sacks | `sack` | 1 |
| Interceptions | `int` | 2 |
| Fumble recoveries | `fum_rec` | 2 |
| Defensive touchdowns | `def_td` | 6 |
| Special teams (return) touchdowns | `def_st_td` | 6 |
| Two-point conversion returns | `def_2pt` | 2 |
| Safeties | `safe` | 2 |
| Blocked kicks | `blk_kick` | 2 |

**Points allowed** (`pts_allow`, a tier rule, inclusive bounds):

| Points allowed | Points |
|---|---|
| 0 | 10 |
| 1-6 | 7 |
| 7-13 | 4 |
| 14-20 | 1 |
| 21-27 | 0 |
| 28-34 | -1 |
| 35+ | -4 |

Yards-allowed tiers are not part of the Yahoo default. A commissioner can add a `yds_allow` tier rule.

### Individual defensive players (IDP, optional)

These are not in the default settings. `withIdpScoring(scoring)` adds them, and validation warns when the roster has IDP slots but no IDP stat scores.

| Stat | Sleeper key | Points |
|---|---|---|
| Solo tackles | `idp_tkl_solo` | 1 |
| Assisted tackles | `idp_tkl_ast` | 0.5 |
| Sacks | `idp_sack` | 2 |
| Interceptions | `idp_int` | 3 |
| Forced fumbles | `idp_ff` | 2 |
| Fumble recoveries | `idp_fum_rec` | 2 |
| Touchdowns | `idp_def_td` | 6 |
| Passes defended | `idp_pass_def` | 1 |
| Safeties | `idp_safe` | 2 |
| Blocked kicks | `idp_blk_kick` | 2 |

### Values we are least sure match Yahoo exactly

These values are our best understanding of Yahoo's defaults. Check them against Sleeper's precomputed `pts_half_ppr` totals during the first replay, and adjust them here and in code together:

- `def_2pt` (a returned two-point conversion or extra point, worth 2).
- The IDP table as a whole.
- Return touchdowns are scored from `st_td` only. If Sleeper's individual stat lines also carry `kr_td`/`pr_td` for the same play, do not weight those as well, or the play counts twice.
- Kicks of 50+ yards score from `fgm_50p` only. Do not also weight `fgm_50_59`/`fgm_60p`.

## Roster

| Setting | Default |
|---|---|
| Team count | 8 (an even number from 4 to 12, so every team has an opponent each week) |
| Slots | QB, WR×3, RB×2, TE, W/R/T, K, DEF, BN×6, IR×1 (16 active + 1 IR) |
| Optional slots | Q/W/R/T (superflex), W/T, W/R, DL, LB, DB, IDP (any defensive player) |
| IR-eligible statuses | IR, Out, PUP, NFI, COVID-19 (`roster.irEligibleStatuses`) |

The following positions are eligible for each slot. A player with more than one position is eligible for a slot if any of his positions is.

| Slot | Accepts |
|---|---|
| QB / WR / RB / TE / K / DEF / DL / LB / DB | That position only |
| W/R/T | WR, RB, TE |
| Q/W/R/T | QB, WR, RB, TE |
| W/T | WR, TE |
| W/R | WR, RB |
| IDP | DL, LB, DB |
| BN | Anyone |
| IR | Anyone whose status is IR-eligible |

Validation also enforces these limits:
- At least one starting slot.
- An active roster (every slot except IR) of at most 25.
- At most 4 IR slots.
- QB, K, and DEF slots × team count ≤ 32, since only 32 NFL teams exist.
- A warning, not an error, when no starting slot accepts a QB.

### Lineup rules (`validateLineup`)

- **Errors** block the lineup:
  - A player who isn't on the roster.
  - A duplicate player.
  - A slot the league doesn't use, or a slot that is overfilled.
  - A player whose position is ineligible for the slot.
  - An IR slot holding a player whose status isn't IR-eligible.
  - More active players than the active roster allows.
  - Moving a **locked** player.
- **Warnings** allow the lineup:
  - A starter who is on bye or has no NFL team.
  - A starter whose status is Out, IR, PUP, NFI, Suspended, or COVID.
  - An empty starting slot.
- **Lineup lock:** each player locks at his own game's kickoff. Callers pass kickoff times and "now" in from their clock, and core never reads the wall clock. A locked player must stay in the slot he held in the previous lineup, so he can be neither benched nor started. Players with no game that week never lock.
- A player who is on the roster but left out of a submitted lineup goes to BN.

## Waivers

| Setting | Default |
|---|---|
| Type | FAAB (`rolling` = Yahoo continual rolling priority, as an option) |
| FAAB budget | $100 |
| $0 bids | Allowed |
| Waiver period for dropped players | 2 days |
| FAAB tiebreak | Waiver priority (the winner moves to the back) |
| Priority order | Reverse draft order, continual rolling |
| Players after the draft | Go through waivers first |
| Max acquisitions per week | No limit |

## Trades

| Setting | Default |
|---|---|
| Review | `league_vote` (options: `commissioner`, `none`) |
| Review period | 2 days |
| Veto votes needed | `null`, which uses the Yahoo rule: ⌈teamCount / 3⌉, capped at the teams not in the trade (8 teams → 3, 10 or 12 teams → 4) |
| Trade deadline | Week 11 (no trades process once week 11 kicks off) |
| Offer expiry | 48 hours, or at the next lineup lock if that comes first |

We are **not certain** of the veto threshold. Our understanding is that Yahoo vetoes a trade when about a third of the league votes against it. The commissioner can set an exact number with `trades.vetoVotes`.

## Schedule and playoffs

| Setting | Default |
|---|---|
| League start week | 1 (a mid-season start can use any week before the trade deadline) |
| Regular season ends | Week 14 (week 15 for leagues of 6 or fewer teams) |
| Playoff teams | 6 (4 for leagues of 6 or fewer teams) |
| Playoff weeks | 15-17 (16-17 for a 4-team bracket) |
| First-round byes | Top 2 seeds (none in a 4-team bracket) |
| Seeding tiebreaker | Points for |

Validation rules:
- The playoffs start the week after the regular season ends.
- Playoff teams can't exceed the team count.
- Byes must equal what a single-elimination bracket needs (2^⌈log₂ teams⌉ − teams).
- Playoff weeks must equal the number of rounds, and the last playoff week can't be later than week 18.
- The trade deadline must be on or before the last regular-season week.
- The league must start before the trade deadline.
- A warning when the regular season has fewer weeks than a full round robin needs.

### Regular-season schedule (`generateSchedule`)

- The schedule is a round robin built with the circle method, from `schedule.startWeek` through `schedule.regularSeasonEndWeek`. Every team plays every week.
- The team count must be even. `SCHEDULE_ODD_TEAMS` suggests adding or removing a team.
- A season longer than one round robin (team count − 1 weeks) repeats the rotation, with home and away flipped on each repeat. A shorter season (for example, a mid-season start) cuts the rotation off. Either way, the number of times any two teams meet differs by at most one across all pairs.
- No pairing repeats in back-to-back weeks, except in a 2-team league.
- The team order is shuffled with a seed, so the same teams, weeks, and seed always produce the same schedule.

### Mid-season start (`leagueWeeks`)

A league plays from `schedule.startWeek` through `schedule.regularSeasonEndWeek`, then the playoff weeks. `leagueWeeks(settings)` returns those weeks. It fails with `START_AFTER_TRADE_DEADLINE` when the start week isn't before the trade deadline, and with `SEASON_HAS_NO_WEEKS` when no regular-season week is left. The latest legal start is the week before the trade deadline (week 10 by default).

### Standings (`computeStandings`)

- A matchup is a win, loss, or tie. Scores are compared to the cent, and equal scores are a tie (there are no fantasy overtimes).
- Only regular-season weeks count. Playoff games never change the standings.
- There are no divisions. Teams are ranked by win percentage, where a tie counts as half a win.
- Teams with the same win percentage are separated by these tiebreakers, in order:
  1. **Points for** (the default, from `playoffs.tiebreaker: 'points_for'`).
  2. **Head-to-head** win percentage in games among only the tied teams. A team that hasn't played the others counts as .500.
  3. **A coin flip**, which is deterministic: a hash of the league's seed and the team id.

  With `playoffs.tiebreaker: 'head_to_head'`, head-to-head comes first and points for second.
- When a tiebreaker splits a group of three or more teams, each smaller group that is still tied starts the list again. That way, head-to-head is recomputed among only the teams still tied.
- Each row reports its record, points for and against, current streak, and `tiebreakerOverNext` (which tiebreaker placed the team above the team ranked just below it).

### Playoff bracket (`seedPlayoffs`, `buildBracket`, `advanceBracket`)

- Seeds are the top `playoffs.teams` teams in the final standings, so the standings tiebreakers also decide seeding.
- The bracket is single elimination with one round per week, from `playoffs.startWeek` to `playoffs.endWeek`. It uses the standard order (1 v 8, 4 v 5, 2 v 7, 3 v 6), and the top seeds get the byes. For example, in the default 6-team bracket, 4 v 5 and 3 v 6 play in week 15, and seeds 1 and 2 enter in week 16.
- **By default there is no reseeding.** The bracket is fixed when it's built, as on Yahoo. With `playoffs.reseed: true`, once a round ends the teams left (winners plus first-round byes) are re-paired, the best seed against the worst.
- The better seed is listed as home.
- **A tie in a playoff game advances the better (lower-numbered) seed**, as on Yahoo. The game is marked `decidedBySeed`.
- An **optional consolation bracket** (`playoffs.consolation: true`, off by default; it needs at least 2 teams outside the playoffs, `CONSOLATION_TOO_FEW_TEAMS` otherwise) is a single-elimination bracket for the teams that missed the playoffs. It ends in the same final week, and its top seeds get byes when the field isn't a power of two. If there are more teams than the playoff weeks can fit, the lowest seeds sit out.
- `buildBracket` rejects a seed count that doesn't match `playoffs.teams`, a bye count other than the bracket needs, a number of weeks that doesn't match the number of rounds, duplicate teams or seeds, and a consolation bracket with fewer than 2 teams.

## Draft

- **Format:** a snake draft. The round-1 order reverses every other round.
- **Rounds:** one per active roster spot (`draftRoundsFor`, 16 by default). IR isn't drafted.
- **Pick clock:** `draft.pickSeconds` in the league settings, 90 seconds by default (a Yahoo-style live draft; 15 seconds to 24 hours). `deadlineFor(draft, startedAt)` is `pickSeconds` after the previous pick, or after the draft start for the first pick. The server schedules a `Draft Pick Deadline` event at that time with the rsc-core scheduler; if the pick is still open then, autopick picks. A deadline for a pick already made does nothing. The commissioner can pause the clock (`pause_draft`) and resume it with the time that was left (at least 30 seconds).
- **Order:** the seats' draft slots, an explicit round-1 order, or a shuffle, chosen by the commissioner at `start_draft`. Every human seat must be taken before the draft starts; agent seats without a configured agent get a random one.
- **Mid-season start:** if the league's start week has kicked off by the time the draft starts, the start week moves to the next open week (it must still be before the trade deadline). When the last pick is made the league moves to the regular season at the later of its start week and the current NFL week.
- **Roster check:** a pick is refused (`ROSTER_WOULD_BE_INVALID`) when the team's remaining picks could no longer fill every empty starting slot (`draftRosterIssue`). A team with nine empty starting slots and nine picks left must fill a starting slot with each pick.
- **Errors:**
  - `NOT_YOUR_TURN` says how many picks until the team is on the clock.
  - `PLAYER_ALREADY_DRAFTED` says who took the player, and in which round and pick.
  - `ROSTER_POSITION_LIMIT` applies only when the draft sets per-team position maximums, counted by each player's primary position.
  - `DRAFT_COMPLETE`.
- **Autopick:** the best-ranked available player who fills an empty starting slot. A team never takes a bench player, such as a second K or DEF, while a starting slot is open. Once every starting slot is full, autopick takes the best-ranked player available. Players drafted earlier fill the most specific open slot first (a WR goes to WR before W/R/T). Unranked players come after ranked ones, and equal ranks are broken by player id.
- **Concurrency:** the draft and all its picks are one item written with a version check, so of two picks racing for the same slot exactly one lands; the other gets `CONFLICT` (or `NOT_YOUR_TURN` on a retry). Passing `pick` (the overall pick number) to `make_draft_pick` stops a late request from landing on a later pick.
- **Traded picks:** a draft carries `tradedPicks` (round, original team, owner), and the order honours them. Trading picks isn't offered yet.

## Editability

`SETTINGS_EDITABILITY` in `packages/core/src/rules/validate-settings.ts` is authoritative. For any path it has no entry for, the setting is locked once the draft starts.

| Setting | Locked when the draft starts | Editable mid-season |
|---|---|---|
| `teamCount` | ✔ | |
| `schedule.*` | ✔ | |
| `roster.slots` | ✔ | |
| `roster.irEligibleStatuses` | | ✔ |
| `scoring.*` | ✔ | |
| `waivers.type`, `faabBudget`, `priorityOrder`, `postDraftPlayers` | ✔ | |
| `waivers.allowZeroBids`, `waiverPeriodDays`, `faabTiebreak`, `maxAcquisitionsPerWeek` | | ✔ |
| `trades.*` | | ✔ |
| `playoffs.*` | ✔ | |

Mid-season changes to the trade deadline have two more limits. The deadline can't move once it has passed, and a new deadline must fall after the current week.

Every validation issue has a stable `code`, a `path`, a `message`, and a `fix`. The `fix` is written so that either a person or an agent can act on it.

## Waiver processing

`resolveWaivers(settings, claims, state)` in `packages/core/src/waivers/` resolves one batch of claims. A claim names a team, the player to add, an optional player to drop, a bid, the team's own ranking of the claim (`priority`, 1 first), and when it was made.

Processing runs in rounds, the Yahoo way:

1. Each team's **front claim** is its best-ranked claim that is still pending. A front claim that can no longer succeed fails, and the team's next claim moves up. A claim fails when:
   - the player was already awarded in this run (`PLAYER_CLAIMED`) or is not available (`PLAYER_UNAVAILABLE`),
   - the drop player is gone, for example because an earlier claim dropped him (`DROP_PLAYER_NOT_ON_ROSTER`),
   - the bid is more than the FAAB left (`BID_EXCEEDS_BUDGET`), is not a whole non-negative dollar amount (`INVALID_BID`), or is $0 when the league disallows it (`ZERO_BID_NOT_ALLOWED`),
   - the roster would be over the active limit with no drop (`ROSTER_FULL`; dropping an IR player does not free an active spot),
   - the team has used `maxAcquisitionsPerWeek` (`ACQUISITION_LIMIT_REACHED`), or the team is unknown (`UNKNOWN_TEAM`).
2. One front claim wins the round:
   - **FAAB:** the highest bid. Equal bids go to `waivers.faabTiebreak`: `waiver_priority` (higher on the list), `reverse_standings` (worse record, from `state.reverseStandings`; the list is used if standings are missing), or `earliest_claim` (added by this stream). Anything still tied goes to the earliest claim, then the claim ID.
   - **Rolling:** the team highest on the priority list. Bids and budgets are ignored.
3. The winner pays its bid (FAAB), the player joins its bench, and its drop player is released. Under rolling waivers and the `waiver_priority` tiebreak, the winner moves to the back of the list (continual rolling). Under the other tiebreaks the list does not change.

The result lists awarded and failed claims (each failure has a code, a message, and a fix), the new budgets, the new priority list, the new rosters, and one transaction per award. Property tests check four things: FAAB spent equals the sum of winning bids, no player is awarded twice, no budget goes negative, and no roster goes over the limit.

**Waiver period** (`waiverClearsAt`). A dropped player clears waivers `waiverPeriodDays` days after the drop. If his game had already kicked off when he was dropped, the period starts when locks lift (`locksReleaseAt`, the weekly rollover) instead. `isOnWaivers(player, now)` is true until that time.

**In the league** (`packages/server/src/operations/waivers/`, `packages/server/src/waivers/`):

- `claim_waiver` adds a **free agent** (not rostered, not on waivers) at once and at no cost. A player **on waivers** gets a pending claim instead, with a FAAB bid and the team's own `priority`.
- `drop_player`, a claim's drop, and the drop of a waiver award put the player on waivers until `waiverClearsAt`, rounded up to the next waiver run, so he never turns free agent before the claims on him are processed. With `waiverPeriodDays: 0` there is no waiver period.
- **Locked players can't be dropped.** Once a player's game this week has kicked off, `drop_player` and a claim's drop return `PLAYER_LOCKED` (the Yahoo rule) until the week rolls over. A pending claim whose drop player will be locked when it runs is refused up front, and a waiver award whose drop player is locked fails with `PLAYER_LOCKED`; the rest of the run goes on. (So core's `locksReleaseAt` rule for locked drops never applies in the league.)
- **Other waivers.** An unrostered player is also on waivers right after the draft when `postDraftPlayers` is `waivers` (until the first waiver run after the draft, `deadlines.postDraftWaiversUntil`), and once his game this week has kicked off (Yahoo's game-time waivers, until the first waiver run after the week is over).
- **Roster limit.** The limit counts the week's lineup: players in IR slots take no active spot.
- **Priority.** After the draft the priority list is the reverse of the draft's round-1 order (after any `start_draft` reorder). Under `priorityOrder: reverse_standings_weekly` it resets at every rollover to the latest standings, worst record first. `faabTiebreak: reverse_standings` uses the latest standings (`reverseStandingsOrder`).
- **Sealed bids.** `list_waiver_claims` shows a team all of its own claims, but another team's claims only once they are resolved (`awarded` or `failed`). Not even the commissioner sees another team's pending bids.
- Claims are processed once a day at `WAIVER_RUN_HOUR_UTC` (08:00 UTC, 3 AM US Central in daylight time). A claim is due at the first run after its player clears waivers, and all due claims go through `resolveWaivers` together. Each run is one window: it records the awards and failures, charges FAAB, updates the priority list, emits `Waivers Processed`, and opens the next window (`Waiver Window Opened`). A claim cancelled or reordered while a run is going is re-read: a cancelled one is skipped, and the run carries on.
- Claims and adds are accepted while `waiversOpen` (the regular season and playoffs).

**Frozen starters.** A starter freezes at his kickoff: the week is scored from the stored lineup for him even if he later leaves the roster (core `frozenLineup`), and a player who took his slot sits on the bench for the week. `preLock` stays true while any of the week's kickoffs is still ahead, and `nextLineupLockAt` is the next one.

## Trade lifecycle

A trade (`packages/core/src/trades/`) is a structured object between two teams. `sides[0]` is the proposer and `sides[1]` the responder. Each side lists the players it sends and the players it drops to stay under the roster limit. The status moves through these states:

```
proposed ─┬─ countered   (the counter is a new proposed trade; counterOf/counterChain link it back)
          ├─ rejected | withdrawn | expired
          └─ accepted ─┬─ processed                       (review: none)
                       └─ in_review ─┬─ processed | vetoed
                                     └─ (accepted/in_review can also be voided → vetoed)
```

- Every transition is a pure function. An illegal one returns `ILLEGAL_TRADE_TRANSITION` with the allowed next states as the fix.
- Only the responder can counter, accept, or reject. Only the proposer can withdraw.
- **Validation** runs at proposal, at acceptance, and again at processing. It checks four things:
  - The players are still on the listed rosters.
  - The trade deadline: no trade processes after the deadline week, or in that week once its first game kicks off.
  - Locked players: a player whose game has kicked off this week can't be traded or dropped.
  - The active roster limit after the swap. At proposal, the responder's overflow is only a warning (`RESPONDER_MUST_DROP`), because the responder picks its drops when it accepts.
- **Expiry:** `expiresAt` is the earlier of `offerExpiryHours` and the next lineup lock (when `expireAtNextLineupLock` is on).
- **Review** begins with `startReview`, and the period is `reviewPeriodDays` long:
  - **`league_vote`:** teams outside the trade vote to veto, one vote each. The trade is vetoed at `vetoVotesRequired(settings)`, and otherwise processes once the period ends.
  - **`commissioner`:** the commissioner approves (the trade can process right away) or vetoes.
  - **`none`:** accepted trades process directly.
- If a trade fails validation at processing (for example, a player was dropped in the meantime), `voidTrade` moves it to `vetoed` and records the reason.
- `applyTrade` swaps the players onto the receiving benches and releases the drops. A property test checks that no player is ever created or lost.

## Valuation and the lineup optimizer

These live in `packages/core/src/valuation/` and are the deterministic half of agent decisions.

- **Projections:** `projectPoints` scores a projected stat line with `scorePlayer`. Projections are stored as player → week → points. A missing week, such as a bye, counts as 0.
- **Player value** (`playerValue`, `valuePlayers`) is built up in steps:
  - Start with rest-of-season points: the sum of weekly projections, each times the schedule-factor hook (default 1).
  - Discount that for injury risk, using a per-status risk scaled by `riskTolerance` (default 0.5).
  - Subtract the replacement level for the player's position.
  - Multiply by the position weight.
- **Recency:** `recencyBias` weights nearer weeks more. The weights are normalized to average 1, so the result stays on the points scale.
- **Replacement level** (VORP) fills every team's starting slots from the pool by points. Single-position slots are filled first, then flex slots from most to least restrictive. The replacement level is the best player left at the position. A player counts at his first listed position.
- **Archetypes** change value through `{ positionWeights, riskTolerance, recencyBias }`.
- **`optimizeLineup`** solves slot assignment exactly (the Hungarian algorithm), so flex choices are optimal rather than greedy. It follows these rules:
  - Locked players keep their slot.
  - Players on IR stay on IR.
  - Players on bye or with a will-not-play status are benched.
  - When totals tie, the lineup that fills more slots wins.
  - A slot is left empty only when no eligible player is left, or when every eligible player projects below 0.
  - The result is checked with `validateLineup`, and the validation is returned alongside it.
- **`tradeValue`** reports two numbers for each side:
  - The change in best-lineup points, summed over the valuation weeks. Each week is solved separately, and statuses apply only to the first week.
  - The change in total player value, where a negative value counts as 0 because the team can drop him.
  
  A trade is `lopsided` when the gap between the two sides' lineup gains is at least `threshold.lineupPoints`, or the gap between their value gains is at least `threshold.value`. Both default to 30. `favors` names the side with the larger combined gain. The agent-to-agent lopsided-trade guard uses this flag.
