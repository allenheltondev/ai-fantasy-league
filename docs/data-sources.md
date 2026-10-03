# Data sources and data jobs

Every piece of external football data reaches the app through a scheduled job in
`packages/server/src/jobs/`. Jobs read through `@fantasy/data` (Sleeper, nflverse) or plain RSS,
write to `FantasyTable`, and emit events. API handlers only read what the jobs stored; they never
call an external source during a request.

## Jobs and schedules

One Lambda (`DataJobsFunction`, handler `jobs.handler`, the same zip as the API) runs every job.
Each EventBridge Scheduler schedule invokes it with `{ "job": "<name>" }`. Run one by hand with
`aws lambda invoke --function-name <DataJobsFunctionName> --payload '{"job":"syncPlayers"}' out.json`.

| Job | Schedule (UTC) | Source | Writes | Emits |
|---|---|---|---|---|
| `syncPlayers` | `cron(17 9,21 * * ? *)` (twice a day) | Sleeper `/v1/players/nfl` + nflverse ID map and schedule (bye weeks) | `PLAYER#<id>`/`PROFILE` (+ GSI1 name index, + the Sleeper `source` record the next diff compares against) | `Player Status Changed` per player whose status, injury, team, or depth-chart order changed (`source: sleeper`) |
| `syncGameDayInjuries` (#200) | `rate(15 minutes)`, working only from 3 hours before a game day's first kickoff until its last kickoff (core `openGameDay`), plus the 15:00 run on other days (Thursday and Monday designations); otherwise `skipped('outside_window')` after two reads | ESPN `site.api.espn.com/apis/site/v2/sports/football/nfl/injuries` (final designations and the game-day inactives), matched by Sleeper's `espn_id`, else by name, team, and position | The changed players' `PLAYER#<id>`/`PROFILE` (`injuryStatus`, `statusSource: espn_gameday`, `statusAsOf`, `statusHeldUntil`: the week's end, and ESPN's `injuryNote`: its comment and date) and their `source`; a changed note alone is written too, without an event. Only rostered players (the roster index) whose team plays that day. A held ESPN designation whose player is gone from a full report (20+ entries) is cleared to active; Sleeper-set statuses are never cleared by absence. The next `syncPlayers` keeps a held game-day status until `statusHeldUntil`, and the note while the designation it explains stands | `Player Status Changed` per changed player, with `source: espn_gameday` |
| `syncNflState` | `rate(15 minutes)` | Sleeper `/v1/state/nfl` | `NFLSTATE`/`CURRENT` (conditional on the state it read) | `Week Rolled Over` exactly once per rollover |
| `syncSchedule` | `cron(7 10 * * ? *)` (daily) | nflverse `games.csv` | `NFLSCHED#<season>#W05`/`GAME#<kickoff>#<gameId>`, `NFLSCHED#<season>`/`SEASON` (bye weeks) | none |
| `ingestStats` | `rate(2 minutes)`, working only inside a game window (kickoff to +4.5h) | Sleeper `/v1/stats/nfl/regular/{season}/{week}` | `STATS#<season>#W05`/`PLAYER#<id>` for changed lines only (GSI2 `PLAYERSTATS#<id>`), and a scoring log event per change (`SCORELOG#<season>#W05`/`PLAYER#<id>#<at>`, #162) | `Scores Updated` with the changed player ids |
| `ingestProjections` | `rate(1 hour)` | Sleeper `/v1/projections/nfl/regular/{season}/{week}`, or its app endpoint when v1 has no projected stats (see [Sleeper projections](#sleeper-projections-two-endpoints)), for the NFL state's week and the next one (a league drafted mid-week already plays the next week, #181; week 1 in the preseason) | `PROJ#<season>#W05#<capturedAt>`/`PLAYER#<id>`, then the pointer `PROJ#<season>#W05`/`ASOF#<capturedAt>` (with the `source` that served it); skipped when the content hash is unchanged | none |
| `ingestTrending` | `rate(1 hour)` | Sleeper `/v1/players/nfl/trending/{add,drop}` for 24h, 72h, and 168h lookbacks (top 50) | `TRENDING#<add\|drop>`/`ASOF#<capturedAt>` (30-day TTL) | none |
| `ingestNews` | `rate(15 minutes)` | The RSS feeds below | `NEWS#<id>`/`ITEM` (GSI2 `NEWS`/`<publishedAt>#<id>`), copies at `PLAYER#<id>` and `TEAMNEWS#<team>` / `NEWS#<publishedAt>#<id>` (90-day TTL) | `Player News Alert` for each new item tagged to a player |
| `scoreLiveWeek` | `rate(2 minutes)`, working only inside a game window of an in-season league's week | Stored stats (`STATS#<season>#W05`) and lineups | Matchup scores (`MATCHUP#W05#<id>`, status `in_progress`) | `Scores Updated` with `leagueId`, the week's score lines, and the changed matchups' recent scoring log entries (`scoringLog`) |
| `scoreLiveWeek` (NFL games, #132) | Same runs, once per season and week; outside windows only until every started game is final (3h grace) | ESPN `site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=<season>&seasontype=2&week=<w>` (public, best effort: a failure logs a warning and never fails scoring) | `NFLGAMES#<season>`/`W05` (the week's games, 14-day `ttl`) | `NFL Games Updated` when a score, status, possession, or red zone changed |
| `scoreLiveWeek` (scoring plays, #164) | Same runs, right after the scoreboard read and before the leagues are scored, for each game whose score changed since the stored scoreboard (or whose stored plays do not reach the score yet, when ESPN's summary trails its scoreboard) | ESPN `site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=<espn id>` (`scoringPlays`; public, best effort per game: a failed read logs a warning and is retried next poll) | `NFLPLAYS#<season>#W05`/`GAME#<espn id>` (the game's scoring plays, each with the time it was first seen; 14-day `ttl`) | none; the scoring log reads them |
| `advanceSeason` | `rate(15 minutes)` | Stored schedule, stats, lineups, matchups | Final matchups, `STANDINGS#W05`, carried-forward `LINEUP#W06#<teamId>`, playoff matchups, the league's week and phase | `Week Provisionally Final`, `Week Rolled Over` (with `leagueId`), and `Schedule Event`s for `Lineup Lock Approaching` |
| `officialFinal` | `cron(0 15 ? * THU,FRI *)` (Thursday, Friday as a retry) | Every league whose last finished week is 48h past its last game and not official; the week re-pulled through `getOfficialWeekStats` (Sleeper reconciled with nflverse's `stats_player_week` file, GSIS ids mapped with the stored crosswalk) | Changed `STATS#` lines (each a `correction` scoring log event; the line also takes nflverse's usage stats as `nfv_…` keys: target and air yards share, WOPR, air yards, YAC, EPA, CPOE, which the player card sums up and which are never a scoring change), rescored matchups, `STANDINGS#`, `PLAYOFFS`, `HISTORY#<season>`, `OFFICIAL#W05`, `ACHIEVEMENT#…` | `Stat Correction Applied` (per changed matchup), `Week Official Final`, `Achievement Earned`, and `Track Activity` when `BADGE_CHEST_ENABLED=true` |
| `syncSeasonResearch` | `rate(1 hour)`, pulling only a missing set or one not checked for 20 hours (#181) | Sleeper `/v1/stats/nfl/regular/{lastSeason}/{1-18}` once per season (again, daily, only while the stored pull is missing weeks), and `/v1/projections/nfl/regular/{season}/{1-18}` (each week falling back to the app endpoint like `ingestProjections`) daily in the preseason and offseason (in-season only while none are stored or weeks are missing). Sleeper has no reliable season-total endpoint, so both are 18 weekly calls folded per player | `SEASON#<stats\|projections>#<season>`/`PLAYER#<id>` (weekly lines compacted to the scoring stat keys) and `/META` (weeks, content hash, `checkedAt`); a changed set replaces the partition, removing players who left it | none |
| `processWaivers` | `cron(0 8 * * ? *)` (daily, 3 AM US Central in daylight time; `WAIVER_RUN_HOUR_UTC`) | The league table only: every league in `regular_season` or `playoffs` (GSI2 `LEAGUEPHASE#<phase>`) | Claims (`WAIVER#<claimId>`), team rosters and FAAB, `TXN#…`, `OWN#<playerId>`, and `WAIVERRUN#<YYYY-MM-DD>` (one run per league per day, so a retry is a no-op) | `Waivers Processed` and `Waiver Window Opened` per league |

Every run also records its outcome as `JOBRUN#<job>`/`LATEST` (and `JOBRUN#<job>`/`OK` for the
last run that did its work): the job, when it finished, `ok`/`skipped`/`failed`, the skip reason or
error, and a short JSON summary of the result, with a 30-day `ttl` (#181). The commissioner's
`get_data_status` operation (Settings, Data status) shows them beside what the jobs stored, so a job
that keeps skipping can be told apart from one that never ran.

Notes:

- **Scoring play descriptions (#164).** A scoring log entry for a touchdown or a made field goal
  shows ESPN's description of the play ("Travis Kelce 18 Yd pass from Patrick Mahomes (Harrison
  Butker Kick)") when exactly one stored play fits it (core `matchScoringPlay`): the play is the
  right kind for a stat that went up, the player has that role in it (the receiver before "pass
  from", the passer after it, a rusher in a play without a pass, the kicker of a field goal, a
  team defense on a defensive or return touchdown), the play's team is his team, his Sleeper name
  (full, or first initial and last name; suffixes like "Jr." ignored) is in the description before
  the extra point, and the play was first seen within 10 minutes of the entry. None or several
  fitting plays means no description: it is never shown unless certain. `get_scoring_log` reads
  the week's plays in one query, and only when an entry could use one.
- **ESPN summary fixture.** `site.api.espn.com` is not reachable from the dev sandbox, so
  `packages/data/fixtures/espn/summary_401772901.json` is hand-written from ESPN's documented
  `scoringPlays` shape (`id`, `type.text`/`abbreviation`, `text`, `period.number`,
  `clock.displayValue`, `team.id`/`abbreviation`, `scoringType.name`, `awayScore`/`homeScore`).
  The schema only requires `id` and `text`. Record a live payload once games are reachable: run the
  **Record fixtures** workflow with `espn_event` set to a game's ESPN id (or
  `node scripts/record-fixtures.mjs --espn-summary <id>`), replace the hand-written file with it,
  and update `packages/data/src/espn/summary.test.ts` to match.
- **Game-window gating.** `ingestStats` reads the stored NFL state and that week's stored schedule
  (one GetItem and one Query) and returns `skipped: outside_game_window` without calling Sleeper
  outside a window. `syncSchedule` must have run once for a season before live stats start.
- **Player universe.** Only fantasy positions (QB, RB, WR, TE, K, DEF) are stored. A player stays
  in scope while he is on a team or active, and once stored he is followed even after he is
  released, so his status change is still announced. Stats and projections are filtered to the
  stored universe once it exists.
- **As-of reads.** Projection snapshots are immutable. `latestSnapshot(season, week, asOf)` is a
  reverse query on `ASOF#` bounded by `asOf`, so the simulator and replays see exactly what was
  known at that moment.
- **Rollover exactly once.** The state write is conditional on the season, season type, and week
  the job read. A concurrent or repeated run finds no change (or loses the condition) and emits
  nothing.
- **Sleeper budget.** The jobs make about 12 Sleeper calls an hour outside game windows and about
  42 an hour during games (live stats every 2 minutes), far under Sleeper's ~1,000/min guidance,
  and all go through the shared token bucket in `@fantasy/data`.

## News feeds

`ingestNews` reads the feed list from the SSM parameter `/<stack>/news-feeds`
(`NewsFeedsParameterName` output) on every run, so feeds can change without a deploy:

```sh
# the built-in list (packages/server/src/jobs/news/default-feeds.json)
aws ssm put-parameter --overwrite --name /ai-fantasy-league/news-feeds --value defaults
# or your own; `team` tags every item from a team's own feed to that team
aws ssm put-parameter --overwrite --name /ai-fantasy-league/news-feeds --value \
  '[{"url":"https://www.espn.com/espn/rss/nfl/news","source":"ESPN"},{"url":"https://www.buffalorumblings.com/rss/current.xml","source":"Buffalo Rumblings","team":"BUF"}]'
```

A plain list of URLs (one per line or comma-separated) also works; the host becomes the source.
An unreadable or invalid value falls back to the defaults and logs an error. Locally, set
`NEWS_FEEDS` instead.

### Default feeds

All are free, public RSS feeds from major outlets.

| Source | URL | Sandbox check (2026-09-27) |
|---|---|---|
| ESPN | `https://www.espn.com/espn/rss/nfl/news` | Blocked by the sandbox egress policy (HTTP 403 at the proxy) |
| CBS Sports | `https://www.cbssports.com/rss/headlines/nfl/` | Blocked (403) |
| Yahoo Sports | `https://sports.yahoo.com/nfl/rss/` | Blocked (403) |
| ProFootballTalk (NBC Sports) | `https://profootballtalk.nbcsports.com/feed/` | Blocked (403) |
| Pro Football Rumors | `https://www.profootballrumors.com/feed` | Blocked (403) |
| The New York Times, Pro Football | `https://rss.nytimes.com/services/xml/rss/nyt/ProFootball.xml` | Blocked (403) |
| The Guardian, NFL | `https://www.theguardian.com/sport/nfl/rss` | Blocked (403) |

**None of these could be verified from the development sandbox.** Its network policy denies every
news host (the proxy answers 403 to the CONNECT, the same as for `api.sleeper.app`), and so do
the other outlets tried: USA Today, RotoWire, FantasyPros, NFL.com, SB Nation, SI, Fox Sports, the
BBC, PFF, The Sporting News, Bleacher Report, and RotoBaller. The feeds are verified where they are
reachable instead:

- The **Record fixtures** workflow (`.github/workflows/record-fixtures.yaml`, run manually) runs
  `node scripts/check-news-feeds.mjs` in CI and uploads `news-feeds-report.json` (HTTP status,
  content type, and item count per feed). Update the table above from it and drop any feed that
  fails.
- In production, each run logs a per-feed outcome (`ok`, `entries`, `added`, `error`) and a
  `some news feeds failed` warning. One failing feed never fails the run.

### How items are processed

1. **Parse** RSS 2.0 `<item>`s and Atom `<entry>`s (title, link, publish time, description) with a
   small built-in parser; HTML and entities in descriptions are flattened to text (max 500 chars).
2. **Dedupe** by a hash of the normalized article URL (lowercase host, https, no fragment, no
   `utm_*`/`fbclid`-style tracking parameters, sorted query). The canonical `NEWS#<hash>` item is a
   conditional put, so a story syndicated across feeds, or seen again on the next poll, is stored
   and alerted once. Items older than 3 days are ignored; publish times in the future are clamped
   to now.
3. **Tag** with the same name normalization as player resolution (`players/match.ts`) over the
   cached `PlayerDirectory` index: full player names (never a last name alone), team nicknames,
   aliases ("Niners"), or city plus nickname. A name shared by several players is tagged only when
   the text (or a team feed) names exactly one of their teams.
4. **Store and alert.** No LLM is called; summaries come later.

## Sleeper projections: two endpoints

Sleeper serves weekly projections from two hosts. **Neither is documented at docs.sleeper.com**
(its public docs cover `/v1` players, state, and trending, not projections), so both are read
defensively and either may change without notice.

| Source | Endpoint | Shape |
|---|---|---|
| `v1` | `https://api.sleeper.app/v1/projections/nfl/regular/{season}/{week}` | Map of player id → stat map, like `/v1/stats`; `null` for a week with nothing yet |
| `app` | `https://api.sleeper.com/projections/nfl/{season}/{week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF` (the endpoint Sleeper's own app reads) | Array of rows: `{ player_id, week, season, season_type, team, opponent, game_id, date, company, category: "proj", stats: {...}, player: {...} }`; a bye week or a player without a team has `stats: { adp_dd_ppr: 1000 }` and a null `game_id` |

`SleeperClient.weekProjections` reads `v1` first. When the request fails, or the week has entries
but none projects anything (every entry empty, or only ADP and rank keys, as in
`{"6462":{}, ...}`), it reads `app` and normalizes the rows into the same player id → stat map
(`parseSleeperAppProjections`), so every consumer is unchanged. The fallback's parser takes stats
nested under `stats` or flat on the row, skips malformed rows and rows for another week, and raises
`SchemaDriftError` only when nothing parses. A failure of the fallback fails the job run.

Which endpoint served each week is recorded: `ingestProjections`'s result (and its `JOBRUN#` record)
gives each week's `source`, each snapshot stores it (`get_data_status` → `weeks[].projections.source`,
shown under Settings → Data status), and `syncSeasonResearch`'s result lists the weeks each source
served (`sources: { v1: [...], app: [...] }`).

The job Lambdas have no VPC configuration, so they have open outbound access to both hosts; the
template needs no change for the fallback. The shared Sleeper rate limiter covers both.

References:

- [BSFFL-enhanced PR #8](https://github.com/mb20389/BSFFL-enhanced/pull/8) (2026-09-26) reports
  that v1 returns empty entries and switches to the `app` endpoint with `position[]` parameters.
- [joeyagreco/sleeper discussion #11](https://github.com/joeyagreco/sleeper/discussions/11) lists
  the `api.sleeper.com/projections/nfl/{season}/{week}` endpoint and its `position[]` filter.
- [cameron-eth/sleeper-sdk PR #59](https://github.com/cameron-eth/sleeper-sdk/pull/59) reads the
  `app` endpoint and captured rows for 2026 week 1, including bye-week rows with only
  `adp_dd_ppr`. `fixtures/sleeper/projection-sources/hand-authored/app_2026_1.json` is written in
  that shape with our fixture players and illustrative numbers.
- [Dave356w/-nfl-top25-rankings](https://github.com/Dave356w/-nfl-top25-rankings/blob/main/pipeline/sleeper.py)
  accepts both the v1 map and a `[{ player_id, stats }]` list from the projections endpoint.

Our Record fixtures run of 2026-09-28 got real `v1` data for 2026 weeks 1-3, so `v1` may be empty
only for upcoming weeks. To capture both real shapes, run the **Record fixtures** workflow with
`app_projections` set to a season and week (for example `2026 5`). It runs
`node scripts/record-fixtures.mjs --sleeper-app-projections <season> <week>`, which writes
`fixtures/sleeper/projection-sources/{v1,app}_<season>_<week>.json` (trimmed to the fixture
players) and `summary_<season>_<week>.json` (each endpoint's HTTP status, shape, row counts, rows
with projected stats, and keys) and adds the summary to the run's page.

## Sleeper reachability

`api.sleeper.app` and `api.sleeper.com` are blocked in the development sandbox. Tests use the recorded fixtures in
`packages/data/fixtures/` through `FixtureDataProvider` and stub providers. To refresh the Sleeper
fixtures, run the **Record fixtures** workflow (GitHub Actions, `workflow_dispatch`); it runs
`node scripts/record-fixtures.mjs --scoring --sleeper` (the scoring validation sets in
`fixtures/sleeper/scoring/`) on a GitHub runner, plus `--sleeper` for the curated unit-test
fixtures (players, state, stats, projections, trending) only when its `curated` input is on,
because a live recording moves the NFL state and the numbers those tests pin. It uploads the
files as an artifact and, unless `push_branch` is off, commits them to a `fixtures/run-<run id>`
branch. Open a PR from that branch; CI runs the data tests, including the
scoring harness, against the new fixtures. Nothing is pushed to `main`.

## Configuration

| Setting | Where | Default |
|---|---|---|
| `SleeperBaseUrl` | Template parameter → `SLEEPER_BASE_URL` | `https://api.sleeper.app` |
| News feed list | SSM `/<stack>/news-feeds` → `NEWS_FEEDS_PARAMETER` | `defaults` |
| `TABLE_NAME`, `EVENT_BUS_NAME`, `LOG_LEVEL` | Function environment | table from the stack, `default`, `info` |

No new secrets are needed: every source is free and unauthenticated.
