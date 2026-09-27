# ADR 001: FantasyTable single-table design

- **Status:** Accepted
- **Issue:** #20
- **Code:** `packages/server/src/repos/` (interfaces in `types.ts`, DynamoDB in `dynamo/`, in-memory in `memory.ts`). The key schema is `tableDefinition()` in `packages/server/src/repos/dynamo/table.ts`.

## Context

League data lives in its own DynamoDB table (SPEC §10, "Data layout"). Every operation in SPEC §6 has to be served with key lookups or single-partition queries: no scans, no cross-partition fan-out on the hot path. Leagues are small (4 to 12 teams, one season), so a league's state fits comfortably in one partition. Player data is shared by every league and is refreshed by scheduled jobs.

## Decision

One table, `FantasyTable`, on-demand billing.

| Attribute | Type | Purpose |
|---|---|---|
| `pk`, `sk` | S | Table key |
| `GSI1PK`, `GSI1SK` | S | **GSI1**: alternate-key lookups (who is in which league, invite codes, the player name index) |
| `GSI2PK`, `GSI2SK` | S | **GSI2**: time-ordered feeds keyed by something other than the partition (audit by principal, a player's stat and news history) |
| `ttl` | N | TTL (epoch seconds) for idempotency records and other expiring items |

Both GSIs project `ALL`. The table has no LSIs, so no item collection has a 10 GB limit.

Why two GSIs and not more: every access pattern below is either a primary-key read or one of two shapes. GSI1 answers "find by a different identity" (a user's leagues, an invite code, players by position and name). GSI2 answers "list over time for a different owner" (an actor's audit trail, one player's history across weeks). Anything else is served inside a partition with `begins_with` on `sk`. We add a GSI only when a new access pattern fits neither shape.

### Conventions

- Key segments are `TYPE#value` and are joined with `#`.
- Weeks are zero-padded (`W05`) and times are ISO 8601 UTC, so `sk` order is chronological.
- Every item also stores its plain fields (`id`, `leagueId`, and so on). Repositories read those fields and never parse keys.
- Items that must be unique across a league use conditional writes (`attribute_not_exists(pk)`), and updates to shared state use a `version` attribute (optimistic concurrency).

### League partition: `pk = LEAGUE#<leagueId>`

| Entity | `sk` | GSI keys | Notes |
|---|---|---|---|
| League (settings, phase, week, version) | `META` | none | `get_league_state` is one GetItem. The phase drives `allowedActions`. |
| Member (a human seat holder) | `MEMBER#<sub>` | GSI1 `USER#<sub>` / `LEAGUE#<leagueId>` | Membership check is a GetItem. "My leagues" is a GSI1 query. |
| Invite | `INVITE#<code>` | GSI1 `INVITE#<code>` / `INVITE` | Accepting a link looks up the code on GSI1. `ttl` expires unused invites. |
| Team / seat | `TEAM#<teamId>` | none | Name, owner (`sub`, or `agent`), FAAB left, waiver priority. |
| Agent config (the seat card) | `TEAM#<teamId>#AGENT` | none | Personality, difficulty, archetype, model, levers. Stored as data, so tuning needs no redeploy. |
| Agent memory | `TEAM#<teamId>#MEMORY#<ts>` | none | Per-agent league memory injected into prompts (SPEC §10). |
| Draft state | `DRAFT` | none | Order, current pick, clock deadline, version. |
| Draft pick | `DRAFT#PICK#<nnn>` | none | `get_draft_board` is one query on `DRAFT`. `make_draft_pick` writes the pick with `attribute_not_exists` and bumps `DRAFT.version` in one transaction. |
| Roster | `ROSTER#<teamId>` | none | `get_roster` is a GetItem. All rosters are one `begins_with(ROSTER#)` query (at most 12 items). |
| Player ownership lock | `OWN#<playerId>` | none | Holds `teamId`. Adds, claims, picks, and trades write it with a condition in the same transaction as the roster change, so a player can never be on two rosters. Free agent check is a GetItem. |
| Lineup | `LINEUP#W05#<teamId>` | none | `set_lineup` puts one item. A week's lineups are one query. |
| Matchup | `MATCHUP#W05#<matchupId>` | none | `get_matchup` is a query on `MATCHUP#W05#`, then filtered to the team (at most 6 items). |
| Standings snapshot | `STANDINGS#W05` | none | Written when a week goes final. `get_standings` reads the latest with a reverse `begins_with(STANDINGS#)` query, limit 1. |
| Waiver claim | `WAIVER#W05#<claimId>` | none | `claim_waiver`, `cancel_waiver_claim`, and a team's claims come from one query. The waiver job resolves a week's claims in a single query. |
| Trade | `TRADE#<tradeId>` | none | The state machine lives on the item (`status`, `version`, `expiresAt`). Offers per team come from `begins_with(TRADE#)` filtered by team; a season has a few dozen. Expiry uses the rsc-core scheduler, not a scan. |
| Trade vote | `TRADE#<tradeId>#VOTE#<teamId>` | none | One vote per team, enforced by `attribute_not_exists`. |
| Transaction | `TXN#<ts>#<txnId>` | none | `get_transactions` is a reverse query with a limit and a cursor. |

`get_matchup_outlook`, `preview_trade`, and `preview_waiver_claim` are computed from the items above plus projections, so they need no items of their own.

### Chat partition: `pk = CHAT#<leagueId>`

| Entity | `sk` | Notes |
|---|---|---|
| Message | `MSG#<ts>#<messageId>` | `get_chat` is a reverse query with a limit and a cursor. `post_message` is one put. Chat has its own partition so a busy chat never slows league-state queries. Mentions go out as `Chat Mention` events rather than being indexed. |

### Player universe: `pk = PLAYER#<playerId>`

| Entity | `sk` | GSI keys | Notes |
|---|---|---|---|
| Player profile | `PROFILE` | GSI1 `PLAYERIDX#<position>` / `<normalized name>#<playerId>` | `get_player` by id is a GetItem. The player sync job writes profiles in batches of 25. |
| News item | `NEWS#<ts>#<newsId>` | GSI2 `NEWS` / `<ts>#<playerId>` | A player's news is a query in his own partition. The league-wide feed (`get_news`) is a reverse GSI2 query. |

#### Player name search

Players are resolved by name everywhere (`search_players`, `get_player`, and every operation that takes `player`). DynamoDB has no text search, and the fantasy-relevant universe is small (roughly 2,000 to 3,000 players), so:

1. GSI1 holds a **name index sharded by position**: `GSI1PK = PLAYERIDX#QB` (RB, WR, TE, K, DEF), `GSI1SK = <normalized name>#<id>`. There are six shards, so no one partition is hot.
2. The server loads the index (six paginated queries, a few hundred KB) into memory in each Lambda container and caches it for 10 minutes on `ctx.clock` (`PlayerDirectory`). A position filter reads a single shard.
3. Matching runs in-process (`players/match.ts`): exact name or alias ("CMC"), last name, prefix, per-token prefix, then small typos (edit distance). A team or position word in the query ("mccaffrey sf") becomes a filter. Ties are broken by rank.
4. Resolution returns one player, `AMBIGUOUS_PLAYER` with the top-tier candidates, or `PLAYER_NOT_FOUND` with a fix.

Because `GSI1SK` starts with the normalized name, a later last-name prefix query (`begins_with`) is possible without a schema change if the universe ever outgrows the in-memory approach.

### Stats and projections

| Entity | `pk` | `sk` | GSI keys | Notes |
|---|---|---|---|---|
| Stat line | `STATS#<season>#W05` | `PLAYER#<playerId>` | GSI2 `PLAYERSTATS#<playerId>` / `<season>#W05` | Scoring a week reads one partition (all players). A player's game log is a GSI2 query. Corrections overwrite the item and keep `correctedAt`. |
| Projection snapshot pointer | `PROJ#<season>#W05` | `ASOF#<ts>` | none | One item per ingest. "The latest projections as of t" is a reverse query with `sk <= ASOF#t`, limit 1. The simulator relies on this for its `asOf` reads. |
| Projection | `PROJ#<season>#W05#<ts>` | `PLAYER#<playerId>` | none | Snapshots are immutable, so a replay sees exactly what an agent would have seen at the time. |
| Trending snapshot | `TRENDING#<add\|drop>` | `ASOF#<ts>` | none | `get_trending_players` reads the latest snapshot, or the one as of a given time. |
| NFL state | `NFLSTATE` | `CURRENT` | none | Season and week. Drives week rollover. |
| NFL schedule | `NFLSCHED#<season>#W05` | `GAME#<kickoff>#<gameId>` | none | Per-player lineup locks at kickoff, and the game windows for live scoring. |

### Operational records

| Entity | `pk` | `sk` | GSI keys | Notes |
|---|---|---|---|---|
| Idempotency record | `IDEMP#<principalKey>` | `KEY#<key>` | none | Keys are scoped per principal. The record stores the request hash, the state (`in_progress` or `complete`), a lock deadline, and the response (status plus JSON). `begin` is a conditional put that also succeeds when the record's TTL has passed or its lock is stale. `ttl` is 24 hours. |
| Audit entry | `AUDIT#LEAGUE#<leagueId>`, or `AUDIT#DAY#<yyyy-mm-dd>` when no league is involved | `<ts>#<auditId>` | GSI2 `AUDIT#PRINCIPAL#<principalKey>` / `<ts>#<auditId>` | Every mutation attempt that passes authentication and validation is recorded: principal, team (for agents), operation, league, idempotency key, and outcome. A league's log and an actor's log are each one reverse query. |

## Access patterns

| Pattern (SPEC §6 tool or job) | How |
|---|---|
| `get_league_state` | GetItem `LEAGUE#id` / `META` |
| My leagues | GSI1 query `USER#<sub>` |
| Accept an invite | GSI1 query `INVITE#<code>` |
| `get_roster` | GetItem `ROSTER#<teamId>` |
| `get_standings` | Query `STANDINGS#`, reverse, limit 1 |
| `get_matchup`, `get_matchup_outlook` | Query `MATCHUP#W05#`, plus lineups and projections |
| `search_players`, `get_player` (by name) | In-memory index from GSI1 `PLAYERIDX#<pos>` |
| `get_player` (by id) | GetItem `PLAYER#id` / `PROFILE` |
| `get_projections` | Latest `PROJ#…` pointer as of now, then the snapshot partition (or GetItem for one player) |
| `get_trending_players` | Query `TRENDING#add`, reverse, limit 1 |
| `get_news` | Per player: query `PLAYER#id`, `begins_with(NEWS#)`. League-wide: GSI2 `NEWS` |
| `get_transactions` | Query `TXN#`, reverse, paginated |
| `get_chat`, `post_message` | Query or put in `CHAT#<leagueId>` |
| `get_draft_board`, `make_draft_pick` | Query `DRAFT`; transact the pick, `OWN#`, `ROSTER#`, and `DRAFT` |
| `set_lineup` | Put `LINEUP#W05#<teamId>` |
| `drop_player`, `claim_waiver`, `cancel_waiver_claim` | Transact `ROSTER#`, `OWN#`, and `WAIVER#`/`TXN#` |
| `preview_waiver_claim`, `preview_trade` | Reads only (roster, lineup, projections) |
| `propose_trade`, `counter_trade`, `respond_to_trade`, `withdraw_trade` | Conditional update on `TRADE#<id>` (`version`) |
| Process trade | Transact both rosters, the `OWN#` locks, `TRADE#`, and `TXN#` |
| Waiver processing job | Query `WAIVER#W05#` in one league |
| Scoring job | Query `STATS#<season>#W05`, then the week's lineups and matchups |
| Idempotent replay | GetItem or conditional put on `IDEMP#…` |
| Audit by league or actor | Query `AUDIT#LEAGUE#id`, or GSI2 `AUDIT#PRINCIPAL#…` |

## Consequences

- One table keeps IAM, backups, and transactions (which need a single table in practice) simple, and a whole league can be moved or deleted by partition.
- A league partition holds the whole season's history. With at most 12 teams that is a few thousand items, far below any partition limit. Write throughput per league is tiny, and DynamoDB adaptive capacity covers the bursts (draft night, waiver processing).
- The player name index costs one warm-up read per container every 10 minutes. It is eventually consistent with the sync job, which is fine for data that refreshes once or twice a day. `PlayerDirectory.invalidate()` exists for a sync that must be seen immediately.
- The in-process DynamoDB used by tests and local dev (dynalite) supports this whole design, except `TransactWriteItems`, which the transactional repositories will need an in-memory fallback or a DynamoDB Local job to test.
- Infra must create the table exactly as `tableDefinition()` describes (key names, `GSI1` and `GSI2` with `ALL` projection) and enable TTL on `ttl`.
