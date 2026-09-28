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
| `syncPlayers` | `cron(17 9,21 * * ? *)` (twice a day) | Sleeper `/v1/players/nfl` + nflverse ID map and schedule (bye weeks) | `PLAYER#<id>`/`PROFILE` (+ GSI1 name index, + the Sleeper `source` record the next diff compares against) | `Player Status Changed` per player whose status, injury, team, or depth-chart order changed |
| `syncNflState` | `rate(15 minutes)` | Sleeper `/v1/state/nfl` | `NFLSTATE`/`CURRENT` (conditional on the state it read) | `Week Rolled Over` exactly once per rollover |
| `syncSchedule` | `cron(7 10 * * ? *)` (daily) | nflverse `games.csv` | `NFLSCHED#<season>#W05`/`GAME#<kickoff>#<gameId>`, `NFLSCHED#<season>`/`SEASON` (bye weeks) | none |
| `ingestStats` | `rate(2 minutes)`, working only inside a game window (kickoff to +4.5h) | Sleeper `/v1/stats/nfl/regular/{season}/{week}` | `STATS#<season>#W05`/`PLAYER#<id>` for changed lines only (GSI2 `PLAYERSTATS#<id>`) | `Scores Updated` with the changed player ids |
| `ingestProjections` | `rate(1 hour)` | Sleeper `/v1/projections/nfl/regular/{season}/{week}` | `PROJ#<season>#W05#<capturedAt>`/`PLAYER#<id>`, then the pointer `PROJ#<season>#W05`/`ASOF#<capturedAt>`; skipped when the content hash is unchanged | none |
| `ingestTrending` | `rate(1 hour)` | Sleeper `/v1/players/nfl/trending/{add,drop}` for 24h, 72h, and 168h lookbacks (top 50) | `TRENDING#<add\|drop>`/`ASOF#<capturedAt>` (30-day TTL) | none |
| `ingestNews` | `rate(15 minutes)` | The RSS feeds below | `NEWS#<id>`/`ITEM` (GSI2 `NEWS`/`<publishedAt>#<id>`), copies at `PLAYER#<id>` and `TEAMNEWS#<team>` / `NEWS#<publishedAt>#<id>` (90-day TTL) | `Player News Alert` for each new item tagged to a player |

Notes:

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

## Sleeper reachability

`api.sleeper.app` is blocked in the development sandbox. Tests use the recorded fixtures in
`packages/data/fixtures/` through `FixtureDataProvider` and stub providers. To refresh the Sleeper
fixtures, run the **Record fixtures** workflow (GitHub Actions, `workflow_dispatch`); it runs
`node scripts/record-fixtures.mjs --sleeper` on a GitHub runner and uploads the files as an
artifact. Copy them into `packages/data/fixtures/sleeper/`, run `npm test -w @fantasy/data`, and
open a PR.

## Configuration

| Setting | Where | Default |
|---|---|---|
| `SleeperBaseUrl` | Template parameter → `SLEEPER_BASE_URL` | `https://api.sleeper.app` |
| News feed list | SSM `/<stack>/news-feeds` → `NEWS_FEEDS_PARAMETER` | `defaults` |
| `TABLE_NAME`, `EVENT_BUS_NAME`, `LOG_LEVEL` | Function environment | table from the stack, `default`, `info` |

No new secrets are needed: every source is free and unauthenticated.
