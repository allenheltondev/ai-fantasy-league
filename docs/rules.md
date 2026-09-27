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
| Team count | 8 (4-12 allowed) |
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
