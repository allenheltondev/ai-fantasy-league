# @fantasy/data

External football data behind one interface. Server jobs, agents, and the replay simulator read
players, NFL state, stats, projections, trending, and schedules through `DataProvider`, never from
Sleeper or nflverse directly.

```ts
interface DataProvider {
  getPlayers(asOf: Date): Promise<Player[]>;
  getNflState(asOf: Date): Promise<NflState>;
  getWeekStats(season: number, week: number, asOf: Date): Promise<StatLine[]>;
  getWeekProjections(season: number, week: number, asOf: Date): Promise<ProjectionLine[]>;
  getTrending(type: 'add' | 'drop', asOf: Date, options?: { lookbackHours?: number; limit?: number }): Promise<TrendingEntry[]>;
  getSchedule(season: number, asOf: Date): Promise<ScheduledGame[]>; // UTC kickoffs
  getByeWeeks(season: number, asOf: Date): Promise<ByeWeeks>;
  // Live providers only: the week's games from ESPN's scoreboard (scores, possession, red zone).
  getLiveGames?(season: number, week: number, asOf: Date, games?: ScheduledGame[]): Promise<LiveGame[]>;
}
```

`asOf` is the moment the caller is living in. Time only ever comes from the caller (or an injected
`Clock` from `@fantasy/core`); nothing in this package reads the wall clock.

## Providers

| Provider | Use | `asOf` |
|---|---|---|
| `LiveDataProvider` | Production jobs | Accepted and ignored: a live source only has "now", which never includes the future. |
| `HistoricalDataProvider` | The replay simulator | Hides anything not yet known at `asOf` (rules below). Reads a `SeasonArchive` from an `ArchiveStore`. |
| `FixtureDataProvider` | Tests, local dev | `HistoricalDataProvider` over the recorded fixtures, so fixture tests exercise the same gating. |

### Historical gating rules

- **Schedule:** always visible (it is published in the spring), but a game's scores and `final`
  status appear only once `kickoff + gameDurationMs` (default 4h) has passed.
- **Stats:** a player's line appears only once *his* game is final. The team comes from the stat
  line, else from the latest player snapshot known at `asOf`; with neither, the line waits for the
  week's last game. Later stat versions (`capturedAt` set) are corrections and win once known.
- **Projections:** for each player, the latest snapshot captured at or before `asOf` **and** before
  that player's kickoff. A snapshot captured after kickoff is never served, even when looking back.
  Unknown-team lines must predate the week's first kickoff.
- **Players / trending:** the latest snapshot captured at or before `asOf` (no snapshot →
  `DataNotAvailableError`; trending older than 48h → `[]`).
- **NFL state:** derived from the schedule. Week W is current until its last kickoff + 36h
  (Wednesday morning after Monday night), matching when Sleeper rolls its week.

`buildArchiveFromNflverse` turns nflverse weekly stats + schedule into a `SeasonArchive` for seasons
we did not record from Sleeper.

## Sources (verified 2026-09-27)

| Data | Source | URL |
|---|---|---|
| Players, state, stats, projections, trending | Sleeper | `https://api.sleeper.app/v1/players/nfl`, `/v1/state/nfl`, `/v1/stats/nfl/regular/{season}/{week}`, `/v1/projections/nfl/regular/{season}/{week}`, `/v1/players/nfl/trending/{add\|drop}` |
| Schedule with kickoff times (ET) and scores | nflverse `schedules` release (same file as `nflverse/nfldata` `data/games.csv`) | `https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv` |
| Weekly player stats (+ `fantasy_points`, `fantasy_points_ppr`) | nflverse `stats_player` release | `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{season}.csv` |
| Live games: score, status, possession, down and distance, red zone | ESPN public scoreboard (unauthenticated, undocumented; best effort) | `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates={season}&seasontype=2&week={week}` |
| Sleeper ↔ GSIS id map | dynastyprocess `db_playerids.csv` | `https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv` |

nflverse `gametime` is Eastern time even for international games; `easternToUtc` converts it with
DST. nflverse writes the Rams as `LA` and dynastyprocess uses PFR-style codes (`KCC`, `GBP`, ...);
`toSleeperTeam` maps all of them to Sleeper's codes.

## Sleeper client

- Global token bucket (`sharedSleeperRateLimiter`): 300 requests/min sustained, burst 10, far under
  Sleeper's ~1,000/min guidance. One per process (Lambda container).
- Retries 408/429/5xx and network errors with exponential backoff + jitter (honors `Retry-After`
  seconds on 429), per-request timeouts (15s; 60s for the ~5 MB players payload).
- Every response is validated with zod. A shape change raises `SchemaDriftError` with the failing
  paths: alert on it.
- `fetch`, `sleep`, `random`, and the `Clock` are all injectable.

## nflverse and the crosswalk

`buildCrosswalk(players, idMap)` maps Sleeper ids to GSIS ids in three passes (dynastyprocess
`sleeper_id` → Sleeper's own `gsis_id` → a unique name + position match, team breaking ties) and
returns a report: how many in-scope players mapped by each method, which could not be mapped (and
whether the name was ambiguous), and conflicts (sources disagree, or two Sleeper ids claim one GSIS
id). `crosswalk.unmappedGsis(ids)` lists nflverse players with no Sleeper id.

`parseNflverseWeeklyStats` maps nflverse columns to Sleeper stat keys (`NFLVERSE_TO_SLEEPER`), so
either source can feed the scoring engine. nflverse's own `fantasy_points` / `fantasy_points_ppr`
are kept on each line for validation; the fixture test reproduces them from the mapped keys.
Team defense (DEF) stats are not in nflverse's player file and are not derived yet.

## Player sync and NFL state

- `diffPlayers(previous, next)` → `{ upserts, removed, changes }`. `changes` are the
  `status` / `injuryStatus` / `team` / `depthChartOrder` changes that become `Player Status Changed`
  events. Pure and deterministic (property-tested).
- `detectWeekRollover(prev, next)` → the `Week Rolled Over` payload, or null for the first
  observation, no change, or a backwards glitch.
- `isInGameWindow(now, schedule)`, `liveGames`, `nextKickoff`, and `lockTimeFor(team, week, schedule)`
  drive live-score polling and lineup locks.

## Fixtures

`fixtures/` stays small (about 170 KB):

- `nflverse/`: **real** trimmed files fetched from the URLs above: the id map rows for the fixture
  players (plus namesakes and two unmapped rookies), their 2025 week 1–2 stat rows, and the full
  2025 schedule.
- `espn/`: **hand-authored** from ESPN's documented scoreboard shape (the sandbox cannot reach
  ESPN): one week with a red-zone drive, a drive outside it, a live game between plays (no
  possession), a pregame, and a final. `normalizeScoreboard` maps ESPN's codes (`WSH`) to ours
  and tolerates missing situations and unknown fields; verify against the live feed after deploy.
  `espn/hand-authored/injuries.json` (#200) is ESPN's league-wide injury report
  (`.../nfl/injuries`) in the shape community clients document: team groups of entries with a
  status word, the athlete's name, position, team, and his ESPN id in `athlete.id` or only in his
  player-card link. `normalizeInjuries` reads either, skips unknown status words, and
  `matchInjuryReports` maps entries to our players by Sleeper's `espn_id` before name, team, and
  position. Record the real report with `--espn-injuries` (below) on a game day.
- `sleeper/`: **hand-authored** in Sleeper's real response shapes, because `api.sleeper.app` was not
  reachable from the sandbox that built this package. The weekly stats mirror the real nflverse
  numbers; projections, trending, and DEF lines are illustrative. `manifest.json` records each
  file's endpoint and capture time. Ids `900xx` are synthetic (name-fallback and unmapped cases).

Refresh them where Sleeper is reachable (CI, AWS, a laptop):

```sh
node scripts/record-fixtures.mjs             # Sleeper + nflverse
node scripts/record-fixtures.mjs --nflverse  # nflverse only (works from the sandbox)
node scripts/record-fixtures.mjs --espn-injuries  # ESPN's injury report (#200) to espn/injuries.json
```

The script trims responses to the fixture player set and keeps the synthetic `900xx` players.
Re-run `npm test -w packages/data` afterwards; a few assertions pin hand-authored values. The
Record fixtures workflow re-records these curated files only when its `curated` input is on; by
default it records just the scoring validation sets (`sleeper/scoring/`, every player's weekly
line with Sleeper's `pts_*`, checked by the scoring harness; see docs/rules.md).

## Tests

`npm run test:coverage -w packages/data`. Tests that hit the real network are wrapped in
`describe.skipIf(!process.env.LIVE_DATA_TESTS)` and do not run in default CI:

```sh
LIVE_DATA_TESTS=1 npx vitest run -w packages/data
```
