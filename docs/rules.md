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
| Special teams fumble recoveries (a muffed punt or kick, recovered by the kicking team; Sleeper keeps these out of `fum_rec`) | `def_st_fum_rec` | 2 |
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

These values are our best understanding of Yahoo's defaults. Adjust them here and in code together:

- `def_2pt` (a returned two-point conversion or extra point, worth 2). No recorded Sleeper week has one yet.
- The IDP table as a whole. Sleeper's default IDP weights differ (see [Scoring validation](#scoring-validation-validatescoring-the-phase-1-milestone)).

Checked against Sleeper's recorded 2025 weeks 1-3 with no difference: two-point conversions (`pass_2pt`, `rush_2pt`, `rec_2pt`), individual return touchdowns (`st_td`; Sleeper's lines carry no separate `kr_td`/`pr_td`), team special-teams touchdowns (`def_st_td`), safeties, blocked kicks, and kicks of 50+ yards from `fgm_50p` only (the lines also carry `fgm_50_59`/`fgm_60p`; do not weight those as well). No recorded week has an offensive fumble-recovery touchdown (`fum_rec_td`) yet.

### Scoring validation (`validateScoring`, the Phase 1 milestone)

The harness (`packages/core/src/scoring/validate.ts`, fed by `packages/data/src/validation/scoring-harness.ts`) scores recorded stat lines with the engine and requires every player's PPR, half-PPR, and standard total to match the source's own precomputed total within 0.01, or to differ by exactly one of the intended differences below. It runs in CI in the data package tests (`scoring-harness.test.ts`) over every real recording in `packages/data/fixtures/` (`sleeper/scoring/*.json` and the nflverse CSVs), and `npm run validate-scoring -w @fantasy/data -- <files>` runs it on any Sleeper weekly stats JSON or nflverse `stats_player_week` CSV, such as a whole season.

| Source | Totals | Compared with |
|---|---|---|
| Sleeper `/v1/stats/nfl/regular/{season}/{week}` | `pts_ppr`, `pts_half_ppr`, `pts_std` | `sleeperReferenceScoring`: our `full_ppr`, `yahoo_standard`, and `standard` presets, unchanged. `sleeperDefaultDifference` explains the classes below. |
| nflverse `stats_player_week` | `fantasy_points`, `fantasy_points_ppr` (half-PPR is their mean) | `nflverseReferenceScoring`: offense only, -2 per interception |

Sleeper lines go through the same normalization as the live provider first (a shutout gets `pts_allow: 0` back). Sleeper's team-total lines (`TEAM_KC`, a whole team's offense and defense summed) are skipped: no league rosters them.

**Results.** Sleeper, 2025 weeks 1-3 (`fixtures/sleeper/scoring/`, recorded by the *Record fixtures* workflow): 1,307 player lines and 3,917 comparisons, 0 unexplained. nflverse: the full 2025 regular season (18,540 player-weeks, 55,620 comparisons) matches except for 36 player-weeks, all of them the return-fumble difference below; the checked-in sample is all 2,180 regular-season player-weeks of weeks 1-2 (`fixtures/nflverse/scoring_sample_2025.csv`). The curated `fixtures/sleeper/stats_regular_*.json` are hand-authored, so their totals are not Sleeper's and are not validated.

**Intended differences from Sleeper's default scoring** (`SLEEPER_DEFAULT_DIFFERENCES`). Each is Sleeper's points minus ours for the line; a mismatch is explained only when it is exactly their sum.

| Class | Sleeper | Ours (Yahoo) | Lines in weeks 1-3 |
|---|---|---|---|
| `missed-kicks` | -1 per missed FG (`fgmiss`) and XP (`xpmiss`) | 0. A commissioner can add `fgmiss`/`xpmiss` weights. | 37 |
| `idp` | Scores every individual defender: `idp_sack` 1, `idp_int` 2, `idp_fum_rec` 2, `idp_ff` 1, `idp_blk_kick` 2, `idp_def_td` 6, `idp_safe` 2 (tackles, QB hits, passes defended 0) | No IDP scoring by default; `withIdpScoring` adds the Yahoo IDP table | 225 |
| `points-allowed-14-20` | 0 for allowing 14-20 points | 1 | 17 |
| `def-forced-fumbles` | 1 per team forced fumble (`ff`) | 0 | 0 (see below) |
| `def-special-teams-fumble-recoveries` | 1 per `def_st_fum_rec` | 2, like any fumble recovery | 3 |

The other points-allowed bands match (0: 10, 1-6: 7, 7-13: 4, 21-27: 0, 28-34: -1, 35+: -4), and Sleeper's default has no yards-allowed tiers.

**Early recordings.** The first scoring sets (2025 weeks 1-3) were recorded with an allow-list of stat keys that dropped `ff`, `st_ff`, and `st_fum_rec`, which Sleeper scores 1 each. In a set with none of those keys (`isEarlySleeperRecording`), a remainder of whole points in Sleeper's favor is explained as `missing-keys`: any number for a team defense, at most 1 for a player. That covers 38 lines: 33 team defenses, whose shortfall equals the team's forced fumbles in nflverse's `def_fumbles_forced` for 32 of them, and 5 special-teams players. The recorder now keeps every key but known noise; re-record weeks 1-3 (Record fixtures, `scoring_weeks: 1,2,3`) to retire this class, and the harness then scores `ff` through `def-forced-fumbles`.

**nflverse differences:**

- **Interceptions.** nflverse charges -2 per interception thrown, and Yahoo and Sleeper charge -1. Only the nflverse reference scoring uses -2.
- **Fumbles lost on kick and punt returns.** nflverse's `fantasy_points` counts only sack, rushing, and receiving fumbles lost. We charge -2 for every lost fumble in `fum_lost` (nflverse `fumbles_lost_total`), including returns, and so does Sleeper (its recorded totals match ours). The harness explains these (`returnFumbleDifference`) instead of failing on them.
- **Kickers, team defense, and IDP.** nflverse does not score them, so those positions are checked only against Sleeper's totals.


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
| Trade deadline | Week 11 (no trades can be proposed or accepted once week 11 kicks off; trades already accepted still complete) |
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
- **Order:** the seats' draft slots, an explicit round-1 order, or a shuffle, chosen by the commissioner at `start_draft`.
- **Scheduled start:** the commissioner can set `draft.scheduledAt` (an instant with a time zone, stored in UTC; after now and at most 60 days ahead; null means start by hand) and `draft.orderMode` (`slots`, the default, or `random`). Both are locked once the draft starts. At that time a `Draft Start Scheduled` event (rsc-core scheduler, one schedule name per league, so a new time moves it and clearing the time cancels it) starts the draft through the same path as `start_draft`, with the chosen order. Ten minutes before, `Draft Reminder Due` posts "The draft starts in 10 minutes" in chat and pushes `Draft Starting Soon` to open draft rooms. If the draft can't start then (a human seat is open, say), the league stays in setup and `Draft Start Blocked` tells the commissioner in chat what to fix. A fire for a time that has since moved or been cleared does nothing. `start_draft` still works any time in setup and cancels the scheduled start.
- **Lobby:** before the draft, the draft room is a lobby with the countdown, the order (unless it will be shuffled), and who's here (`check_in_draft_lobby`: each check-in counts for 45 seconds; agent seats are always here). Every human seat must be taken before the draft starts; agent seats without a configured agent get a random one.
- **Mid-season start:** if the league's start week has kicked off by the time the draft starts, the start week moves to the next open week (it must still be before the trade deadline). When the last pick is made the league moves to the regular season at the later of its start week and the current NFL week.
- **Roster check:** a pick is refused (`ROSTER_WOULD_BE_INVALID`) when the team's remaining picks could no longer fill every empty starting slot (`draftRosterIssue`). A team with nine empty starting slots and nine picks left must fill a starting slot with each pick.
- **Errors:**
  - `NOT_YOUR_TURN` says how many picks until the team is on the clock.
  - `PLAYER_ALREADY_DRAFTED` says who took the player, and in which round and pick.
  - `ROSTER_POSITION_LIMIT` applies only when the draft sets per-team position maximums, counted by each player's primary position.
  - `DRAFT_COMPLETE`.
- **Draft queue:** each team keeps an ordered list of up to 50 players it wants next (`set_draft_queue` replaces it, `get_draft_queue` reads it; only the team's owner or its agent, before and during the draft). It is stored on the server (`DRAFTQUEUE#<teamId>`).
- **Autopick:** first the team's draft queue: the first queued player who is still available, under any position maximum, and keeps the roster completable (`queuedPick`). Otherwise the best-ranked available player who fills an empty starting slot. A team never takes a bench player, such as a second K or DEF, while a starting slot is open. Once every starting slot is full, autopick takes the best-ranked player available. Players drafted earlier fill the most specific open slot first (a WR goes to WR before W/R/T). Unranked players come after ranked ones, and equal ranks are broken by player id.
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
  - The trade deadline (at proposal and acceptance only): no trade can be proposed or accepted after the deadline week, or in that week once its first game kicks off. As on Yahoo, a trade accepted before the deadline still processes when its review ends, even after the deadline.
  - Locked players: a player whose game has kicked off this week can't be traded or dropped.
  - The active roster limit after the swap. At proposal, the responder's overflow is only a warning (`RESPONDER_MUST_DROP`), because the responder picks its drops when it accepts.
- **Expiry:** `expiresAt` is the earlier of `offerExpiryHours` and the next lineup lock (when `expireAtNextLineupLock` is on).
- **Review** begins with `startReview`, and the period is `reviewPeriodDays` long:
  - **`league_vote`:** teams outside the trade vote to veto, one vote each. The trade is vetoed at `vetoVotesRequired(settings)`, and otherwise processes once the period ends.
  - **`commissioner`:** the commissioner approves (the trade can process right away) or vetoes. A trade the commissioner's own team is part of goes to a league vote instead (`reviewSettingsFor`), so nobody reviews their own trade.
  - **`none`:** accepted trades process directly.
- If a trade fails validation at processing (for example, a player was dropped in the meantime), `voidTrade` moves it to `vetoed` and records the reason.
- An open offer that can no longer work because one of its players changed rosters is closed with `voidOffer`: it becomes `expired` and records the reason.
- `applyTrade` swaps the players onto the receiving benches and releases the drops. A property test checks that no player is ever created or lost.

### Trades in a league (server, #63–#65, #79)

- **Offers are private.** Only the two teams see a pending offer. Once accepted, the whole league sees the trade so it can review it, but the notes stay between the two teams: the offering team's `message` and the answering team's `reply` (sent with an accept or reject, and kept apart from the offer's note).
- **Offer limit.** A team may have at most 2 unanswered offers out to the same team at once (`TOO_MANY_OPEN_OFFERS`, with the offers to wait on or withdraw), so an agent can't flood a team with offers.
- **Withdrawals** go out as `Trade Withdrawn` to the two teams.
- **Expiry.** An offer expires `offerExpiryHours` after it is made, or at the next lineup lock (the next kickoff) when `expireAtNextLineupLock` is on, whichever comes first, and never later than the trade deadline. The rsc-core scheduler fires `Trade Offer Deadline` at that time; an offer already answered ignores it.
- **Review.** An accepted trade goes into review for `reviewPeriodDays` (`league_vote` or `commissioner`) and `Trade Review Ended` processes it at the end, unless it was vetoed. With review `none` it processes as soon as it is accepted; `Trade Review Ended` is scheduled for that moment first, so a run that fails partway is finished by the timer. Review (voting and commissioner approval) continues into the playoffs for trades accepted before the deadline.
- **Locked players wait (Yahoo).** A player whose game has kicked off this week can't be offered or accepted in a trade. If a player in an accepted trade locks before the trade processes (for example, the commissioner approves on Sunday afternoon), the trade waits: processing is rescheduled for when the week's locks release (the end of the week's last game, retried every 30 minutes until the league rolls over). Lineups therefore never change under a locked player. When the trade processes, the players join their new teams' benches, and the current week's saved lineups are reconciled with the new rosters.
- **Deadline.** Once the deadline week's first game kicks off, `propose_trade`, `counter_trade`, and `respond_to_trade` fail with `TRADE_DEADLINE_PASSED`, and `Trade Deadline Passed` (scheduled when the season starts) expires every open offer. Only offers still pending at the deadline expire: a trade accepted before it completes when its review ends, as on Yahoo. Changing `trades.deadlineWeek` in season moves `deadlines.tradeDeadlineAt` to the new week's first kickoff and reschedules the event under the same name; a deadline event that arrives before the deadline has passed does nothing.
- **Invalidated trades.** A trade whose player left a roster in the meantime (a drop, a waiver move, or another trade) is re-checked when it is accepted and when it processes: acceptance fails with a fix, and processing cancels it. Open offers don't wait for that: when a player moves (a processed trade, a drop, or a waiver award), every open offer that includes him is voided at once (`expired` with `voidReason` `PLAYER_MOVED`, announced to the two teams as `Trade Expired`).
- **Processing** moves each player's ownership lock (`OWN#`) to his new team, rewrites both rosters, puts the drops on waivers, and records one `trade` transaction per player received (and a `drop` for each drop). It is idempotent: a crashed run finishes on the next delivery without charging or moving anyone twice. If a third team already rosters one of the players, the locks already moved go back and the trade is voided (`PLAYER_NOT_AVAILABLE`), so no player ever lands on two rosters. While a trade is processing, `drop_player` and waiver claims refuse its players (`PLAYER_IN_TRADE`).
- **Lopsided agent trades.** An offer between two AI teams that `tradeValue` calls lopsided is refused (`TRADE_LOPSIDED`).

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
