# Season replay simulator (`@fantasy/sim`)

The simulator replays a finished NFL season (2025) week by week, so league logic and agents can be tested in minutes instead of waiting for real Sundays (SPEC §9). It has four parts:

1. **Archive builder:** turns free nflverse files into a compact season archive.
2. **Simulated clock:** `SimClock` implements core's `Clock` and steps through a timeline of league events.
3. **As-of guard:** wraps the data provider so nothing can read past the simulated "now".
4. **Engine port and headless runner:** `LeagueEngine`, the in-memory `CoreOnlyEngine`, scripted bots, and `runSeason`, which produces a `SeasonReport` with invariants checked every week.

```sh
npm run sim:archive -w @fantasy/sim -- --season 2025             # → packages/sim/archives/2025/ (gitignored)
npm run sim:run -w @fantasy/sim -- --archive fixtures --weeks 4  # the committed 4-week fixture
npm run sim:run -w @fantasy/sim -- --archive 2025                # the full season, playoffs included
npm run sim:run -w @fantasy/sim -- --archive 2025 --start-week 5 # a mid-season start
```

`sim:run` also takes `--teams N`, `--seed S`, `--anonymize`, and `--report file.json`. It exits 1 when any invariant fails. The nightly workflow (`.github/workflows/nightly-sim.yaml`) builds the 2025 archive and runs the full season and a mid-season start. PR checks run only the committed fixture.

## Archive

`buildSimArchive(sources)` is pure. It reads CSV text and never touches the network, the filesystem, or the clock, so the same sources always give the same archive. `loadArchiveSources` downloads the files and caches them in `archives/.cache/`.

| Source | nflverse release asset | Used for |
|---|---|---|
| Schedule | `schedules/games.csv` | Kickoffs, final scores, bye weeks |
| Player stats | `stats_player/stats_player_week_{season}.csv` | Weekly stat lines (Sleeper keys via `@fantasy/data`) |
| Prior-season player stats | `stats_player/stats_player_week_{season-1}.csv` | Preseason projection baseline |
| Team stats | `stats_team/stats_team_week_{season}.csv` (and `season-1`) | DEF lines |
| Weekly rosters | `weekly_rosters/roster_weekly_{season}.csv` | Team by week, reserve (IR) lists, Sleeper ids |
| Injury reports | `injuries/injuries_{season}.csv` | Out, Doubtful, and Questionable designations by week |
| ID map | dynastyprocess `db_playerids.csv` | Sleeper ↔ GSIS crosswalk |

The first three and the ID map are required. The others are optional; when one is missing the build still succeeds, and the manifest records the gap.

On-disk layout (`writeSimArchive` / `readSimArchive`, validated with zod):

```
manifest.json    version, season, weeks, provenance (sources, projection and DEF methods, notes)
schedule.json    every game of the season, with UTC kickoffs and final scores
byes.json        team → bye week
crosswalk.json   { sleeperId, gsisId, method } for archived players
players.json     id, name, position, teams by week, injury designations by week
weeks/NN.json    { stats, projections: { capturedAt, lines }, trending: { capturedAt, add },
                   playersCapturedAt, injuriesCapturedAt }
```

- **Players** are the fantasy positions (QB, RB, WR, TE, K) with a regular-season line this season, or with a line last season who are on a roster this season, plus the 32 team defenses (id = team code, as on Sleeper). Players without a Sleeper id keep their GSIS id. The full 2025 archive has 767 players and 729 crosswalk entries, and is about 2.3 MB.
- **Team by week:** a player's team for week W is the team he played for that week (known before kickoff). Failing that, it's the team on that week's roster; failing that, his last known team.
- **Statuses:** there's no Sleeper status history, so a player's status comes only from injury-report designations and reserve lists.
- **Fixture:** `--fixture` trims the archive to weeks 1–4 and the best-projected 172 players (QB 20, RB 44, WR 56, TE 20, K 14, DEF 18). It writes the result to `packages/sim/fixtures/` (about 350 KB), formatted with Prettier.

### Synthetic projections

Historical Sleeper projections aren't available, so the archive synthesizes them. For week W, each stat is a weighted mean of three things:

- the player's **actual lines in his last 6 games before week W**, where the game i places back weighs 0.8^i;
- his **prior-season per-game average**, weighted as (4 − W) games in weeks 1–3 (3, 2, then 1) and not used from week 4 on;
- that prior-season average alone, for a player with no game yet this season (for example, one back from injury).

A player with neither history nor a baseline gets no projection, and neither does a player whose team is on bye or who has no team. `gp` isn't projected, and `pts_allow` stays present even at 0 so the points-allowed tier still applies. Values are rounded to 2 decimals.

Only weeks before W are read. The snapshot is also captured before week W's first kickoff (see the moments below), so projections are strictly pre-kickoff. A property test changes later weeks' stats and checks that earlier projections never move.

**Trending adds** are also synthetic. They're the 25 players whose half-PPR projection rose most from the previous week's projection, with `count` set to the rise in hundredths of a point. They're built from the two pre-kickoff projection snapshots only.

### DEF stat lines

nflverse's player file has no team defense rows. DEF lines are derived as follows:

- `pts_allow` is the opponent's final score from the schedule. It's always set.
- The rest come from nflverse `stats_team_week` (the `stats_team` release, free and reachable):

  | Sleeper key | nflverse column(s) |
  |---|---|
  | `sack` | `def_sacks` |
  | `int` | `def_interceptions` |
  | `fum_rec` | `fumble_recovery_opp` |
  | `def_td` | `def_tds` |
  | `def_st_td` | `special_teams_tds` |
  | `safe` | `def_safeties` |
  | `blk_kick` | `def_punt_blocks` + `def_fg_blocks` + `def_pat_blocks` |
  | `def_2pt` | `def_2pt_made` |
  | `yds_allow` | the opponent's `passing_yards` + `sack_yards_lost` + `rushing_yards` |

- Without the team-stats file, DEF lines carry `pts_allow` only, and the manifest notes this.
- Known gap: `pts_allow` counts every point the opponent scored, including points off pick-sixes and return touchdowns. Yahoo doesn't count those against the defense. Scores are otherwise not reconciled against Sleeper's DEF totals.

## Simulated clock and timeline

`weekMoments(schedule)` fixes each week's moments relative to real kickoffs. The archive builder, which stamps capture times, and the timeline, which schedules events, both use it, so the two can't disagree.

| Moment | When |
|---|---|
| Projections, trending, player snapshot for week W | 24h after week W−1's last kickoff (week 1: 3 days before its first kickoff) |
| Draft (the league's first week only) | 2h after that week's projections |
| `waiver_run` for week W | 30h after week W−1's last kickoff (week 1: 1 day before its first kickoff) |
| Injury designations for week W | 2h before week W's first kickoff |
| `lineup_lock` | Each distinct kickoff (one per game window) |
| `games_final` | Each window's kickoff + 4h |
| `monday_night_final` | The last kickoff + 4h (the week is provisionally final) |
| `stat_correction` | The last kickoff + 60h (Thursday morning ET; the week is official) |

`buildTimeline(schedule, { weeks })` returns these as a sorted, deterministic event list. It fails if a week has no games, or if a week could start before the previous one is final. `SimClock` behaves as follows:

- `now()` returns a copy of the simulated time.
- `advanceTo(instant)` moves time forward. It never moves backwards (`ClockRewindError`), and it skips events strictly before the new time.
- `peekEvent()` shows the next event, and `nextEvent()` moves time to it.

The runner gives each team a last look one minute before every lock.

## As-of guard

`AsOfGuardedProvider(inner, clock, options)` wraps a `DataProvider`, normally `HistoricalDataProvider` over `toSeasonArchive(archive)`:

- Every call is served with `clock.now()` as `asOf`, whatever the caller passes.
- A caller-supplied `asOf` later than now throws `FutureDataAccessError`. The error names the method, the requested time, and now, and the attempt is counted in `blockedAttempts`.
- An earlier or equal `asOf` is accepted, but served as of now. The inner provider only ever sees now.
- `onRead` reports every read: the method, `asOf`, the players served for stats and projections, and the games served as final. The runner uses it to audit every read against the archive.

The tests (`src/guard/guard.test.ts`) are exhaustive over the fixture archive. At **every timeline event**, for **every `DataProvider` method** (stats and projections for every week, and trending with and without a limit), they check five things:

- The guard returns exactly what the inner provider returns at now.
- An earlier `asOf` returns the same.
- Three future offsets (1 ms, 4 h, 7 days) each throw.
- No served stat line belongs to a game that wasn't final.
- No projection was captured after its kickoff. No schedule score appears before the game ends. Player teams and injuries come from the right snapshot.

fast-check properties add three more guarantees, at random moments across the season:

- Any future `asOf` throws for any method.
- Any past `asOf` is served as of now, and the inner provider sees only now.
- Knowledge only grows: whatever is known at t1 is still known, and unchanged, at every t2 > t1.

### The model knowledge-cutoff caveat

The data guard can stop *code* from reading the future. It can't stop a *model* from remembering it. The 2025 season finished before recent models' training cutoffs, so an agent may "know" that a player broke out in week 9 or got hurt in week 12, or even who won the title. Its replay decisions can then beat anything the pre-kickoff data justified. Treat agent results on 2025 replays as an upper bound, not as evidence of skill.

**Mitigation (optional):** `anonymizePlayers` is a flag (`runSeason({ anonymizePlayers: true })`, `--anonymize`, or `new AsOfGuardedProvider(inner, clock, { anonymizePlayers: true })`). With it on, the guard replaces real player names in `getPlayers` with stable pseudonyms such as "Harper Stonebridge" and drops the GSIS id.

- The same seed and player universe always produce the same pseudonyms, whatever order players are asked for in, and no two players share one.
- Player ids, positions, and teams are unchanged, and team defenses keep their names.
- Decisions go by id, so an anonymized run of scripted bots produces an identical report. A test checks this.

**What anonymization does not hide:** a distinctive stat profile, such as a rushing QB on BUF or a WR with 1,700 yards, can still identify a player. So can the team, and the (real) schedule and scores. It raises the bar; it doesn't remove the leak. A stronger mitigation, not built yet, would also permute team codes and shift the calendar.

## Engine port and headless runner

`LeagueEngine` (in `src/engine/types.ts`) is the set of operations a replay needs. The server-backed engine will implement the same interface by calling the operation registry, so the runner and policies won't change.

| Operation | Purpose |
|---|---|
| `createLeague({ leagueId, settings, teams, draftOrder, seed })` | Schedule (core `generateSchedule`), budgets, and reverse-draft waiver order |
| `draft()`, `makeDraftPick(teamId, playerId)` | Core snake draft rules. The runner's draft loop asks each team's policy in turn. |
| `lineup(teamId, week)`, `setLineup(teamId, week, lineup)` | Core `validateLineup` with games and the engine clock, so locks are enforced |
| `submitWaiverClaim(claim)`, `processWaivers(week)` | Claims are queued, then resolved in one batch by core `resolveWaivers` (FAAB, priority tiebreak) |
| `scoreWeek(week)` | Live scores from the stats known now |
| `finalizeWeek(week, 'provisional' \| 'official')` | Monday night, then Thursday. The official finalize of the last regular week seeds the bracket, and each playoff week's official finalize advances it. |
| `standings()`, `bracket()`, `champion()` | Core standings, bracket, and champion |
| `transactions()`, `lineupHistory()` | Used for the report and the invariant checks |

`CoreOnlyEngine` implements all of it in memory on `@fantasy/core`, with no server. It reads data only through the provider it's given, and time only from its clock. Every operation returns `EngineResult`: either the value plus warnings, or the blocking issues, each with a fix.

**Policies** (`TeamPolicy`) make three decisions: `draftPick`, `lineup`, and `waiverClaims`. `scriptedPolicy()` is deterministic:

- **Draft:** core `autopick` over the mean projection of every week published before the draft, with a small seeded per-team jitter so teams differ.
- **Lineups:** the core optimizer (`optimizeLineup`) on this week's projections. It respects locks, byes, and injuries.
- **Waivers:** it bids on free agents who are trending or project 10 or more points, when they beat the weakest rostered player at the same position by at least 1.5 blended points (half this week's projection, half the season-to-date mean). The bid is $2 per point of gain, plus $3 when the player is trending, within budget. It makes at most 2 claims a week.

`runSeason({ archive, teams: [{ id, policy }], seed, engine?, startWeek?, weeks?, settings?, anonymizePlayers? })`:

- **Settings:** the Yahoo defaults for a full season. A shorter replay compresses the calendar: the last two weeks become a 4-team playoff, and the trade deadline is the last regular week. `startWeek` gives a mid-season start (core `leagueWeeks`); the draft then happens just before that week.
- **Events:** at `draft` the runner runs the draft. At `waiver_run` it collects claims, processes waivers, and sets lineups. Just before each `lineup_lock` it gives every team a last lineup change. At `games_final` it scores live. At `monday_night_final` it finalizes provisionally and checks invariants. At `stat_correction` it finalizes officially.
- **Invariants,** checked every week:
  - `rosters_valid`: every roster passes `validateLineup` and fits the active roster limit.
  - `no_shared_players`: no player is on two teams.
  - `faab_conserved`: for each team, the budget minus its winning bids equals what's left, and no budget goes negative.
  - `lineup_locks_respected`: across every pair of saved lineups, no player whose game had kicked off changed slot.
  - `pre_kickoff_projections`: every projection served was captured before its player's kickoff.
  - `no_future_data`: no stats, scores, or projections were served before they existed.
- **`SeasonReport`** holds:
  - the settings summary, teams, and draft order;
  - the champion, final standings, and bracket;
  - per-week matchups and team points, with that week's invariant results;
  - every transaction and the final FAAB;
  - `rejected`: actions the engine refused, with their rule codes. A refusal is the rules working, not an invariant break;
  - `violations`;
  - data-access counts, including blocked future reads.

  The same seed gives an identical report; a test checks this.

### Simplifications and deferred work

- **Adds:** every add goes through a waiver run. There are no instant free-agent pickups between runs, and dropped players go straight back to the pool, with no waiver period.
- **Trades:** there are none yet. The core trade machine exists; wiring it into the engine and the policies is follow-up work (#62).
- **IR:** bots don't use IR slots.
- **Stat corrections:** nflverse publishes one final version per week, so the official scores equal the provisional ones. The correction step is still exercised.
- **Server engine and real agents:** they will plug in behind `LeagueEngine` and `TeamPolicy` (#60, #62).
