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
| League (settings, phase, week, commissioner, deadlines, schedule seed, version) | `META` | GSI1 `CREATOR#<sub>` / `LEAGUE#<createdAt>#<leagueId>`; GSI2 `LEAGUEPHASE#<phase>` / `<createdAt>#<leagueId>` | `get_league_state` is this GetItem plus the team query. The phase and sub-phase flags drive `allowedActions` (`league/phase.ts`). The creator index counts a user's active leagues for the league quota. The phase index lets scheduled jobs (waiver processing) find the in-season leagues without a scan. |
| Member (a human seat holder) | `MEMBER#<sub>` | GSI1 `USER#<sub>` / `LEAGUE#<leagueId>` | "My leagues" is a GSI1 query. The conditional put (`attribute_not_exists`) enforces one seat per person per league. Authorization reads the owner on the team items. |
| Invite | `INVITE#<inviteId>` | GSI1 `INVITE#<sha256(token)>` / `INVITE` | Only the SHA-256 of the token is stored; the token is shown once. Accepting a link hashes the token and queries GSI1. Uses are counted with a `version` check. `ttl` is the expiry plus 30 days, so expired invites stay listable for a while. |
| Team / seat | `TEAM#<teamId>` | none | Name, seat type (`human` or `agent`), owner `sub` (null for open and agent seats), agent config id, draft slot, FAAB left, waiver priority, roster (player ids, empty until the draft), `version`. Items carry `entity = team`, because `TEAM#<teamId>#AGENT` and `TEAM#<teamId>#MEMORY#...` share the prefix: the team list is one `begins_with(TEAM#)` query filtered on `entity`. |
| Agent config (the seat card) | `TEAM#<teamId>#AGENT` | none | Personality, difficulty, archetype, model, levers. Stored as data, so tuning needs no redeploy. |
| Agent memory | `TEAM#<teamId>#MEMORY#<ts>` | none | Per-agent league memory injected into prompts (SPEC §10). |
| Draft | `DRAFT` | none | The order, rounds, clock, every pick, the current deadline, status (`in_progress`, `paused`, `complete`), and `version`. `get_draft_board` is one GetItem. `make_draft_pick` rewrites the item with a `version` condition, so two racing picks cannot both land (a 16-round, 12-team draft is well under 100 KB). Team rosters are then set to the team's picks. |
| Draft queue | `DRAFTQUEUE#<teamId>` | none | One team's draft queue: up to 50 player ids, most wanted first (`set_draft_queue` replaces it whole). The pick clock reads the team on the clock's queue before it autopicks. |
| Draft lobby check-in | `DRAFTLOBBY#<teamId or commissioner>` | `ttl` (a day) | When a member last had the draft room open before the draft (`check_in_draft_lobby`). The lobby is one Query on the prefix; a check-in counts for 45 seconds. |
| Roster | `ROSTER#<teamId>` | none | `get_roster` is a GetItem. All rosters are one `begins_with(ROSTER#)` query (at most 12 items). |
| Player ownership lock | `OWN#<playerId>` | none | Holds `teamId` (null once released; locks are never deleted). A roster add first takes the lock with a condition (free, already this team's, or held by a team whose roster no longer has the player), then writes the team with its `version`, and a drop frees it, so two adds of one player never both land. |
| Lineup | `LINEUP#W05#<teamId>` | none | Every rostered player with his slot, plus who saved it. `set_lineup` puts one item. A week's lineups are one query. A week with no lineup uses the team's latest earlier one (a reverse range query filtered on the team), and the weekly rollover writes the carried-forward copies. |
| Matchup | `MATCHUP#W05#<matchupId>` | none | `get_matchup` is a query on `MATCHUP#W05#`, then filtered to the team (at most 6 items). Matchup ids are `W05-<n>`. `startSeasonSchedule` writes the regular season with one batch write when the draft starts; scores and `status` are filled in as weeks are played. |
| Standings snapshot | `STANDINGS#W05` | none | Written when a week goes final. `get_standings` reads the latest with a reverse `begins_with(STANDINGS#)` query, limit 1. |
| Playoff bracket | `PLAYOFFS` | none | The bracket rebuilt from the final standings and final playoff matchups (`season/playoffs.ts`), with the champion. `get_playoff_bracket` reads it. Playoff matchups are `MATCHUP#W16#W16-P-<bracket game id>`. |
| Official final | `OFFICIAL#W05` | none | The Thursday official final's claim for a week: the provisional scores, then the correction counts. A conditional put makes the job idempotent per week. |
| Season archive | `HISTORY#<season>` | none | Written when the league completes: champion, standings, playoff results, records, head-to-head. |
| Achievement | `ACHIEVEMENT#<achievementId>#<season>#<W05\|season>#<teamId>` | none | One per award; a conditional put makes each award (and its announcement) happen once. |
| Waiver claim | `WAIVER#<claimId>` | none | `claim_waiver`, `cancel_waiver_claim`, and the claim list come from one `begins_with(WAIVER#)` query (a season has at most a few hundred). The claim carries its status, bid, own priority, and `processesAt`; updates are version-checked. |
| Waiver wire entry | `WAIVERWIRE#<playerId>` | none | Written when a player is dropped: who dropped him and `clearsAt`. A player is on waivers while `clearsAt` is in the future. |
| Waiver run | `WAIVERRUN#<YYYY-MM-DD>` | none | One per league per processing window, created conditionally, so the daily job is idempotent; a run left `running` for 15 minutes can be taken over. |
| Trade | `TRADE#<tradeId>` | none | The state machine lives on the item (`status`, `version`, `expiresAt`), including the veto votes (one per team, enforced by core and the version check). Offers per team come from `begins_with(TRADE#)` filtered by team; a season has a few dozen. Expiry uses the rsc-core scheduler, not a scan. `processingAt` marks a trade whose processing has started, so a retry finishes it without validating again. |
| Transaction | `TXN#<ts>#<txnId>` | none | `get_transactions` is a reverse query with a limit and a cursor. |

`get_matchup_outlook`, `preview_trade`, and `preview_waiver_claim` are computed from the items above plus projections, so they need no items of their own.

### Chat partition: `pk = CHAT#<leagueId>`

| Entity | `sk` | Notes |
|---|---|---|
| Message in `trash-talk` | `MSG#<ts>#<messageId>` | The key every message had before rooms existed (#144), so the old group chat is trash talk's history with no migration. |
| Message in any other room | `ROOM#<roomId>#MSG#<ts>#<messageId>` | `get_chat` for a room is a reverse `begins_with` query on its prefix with a limit and a cursor. `post_message` is one conditional put. |
| Activity index | `ACT#<ts>#<messageId>` | Every message in any room, without its text (`roomId`, `kind`, `teamId`). Two-day `ttl`. Rate limits and agent budgets read it. |
| DM list | `DM#<teamId>#<roomId>` | One item per team in each DM, written with every DM message: `list_chat_rooms` finds a team's DMs with one `begins_with` query. |
| Read marker | `READ#<principalKey>#<roomId>` | `lastReadAt` per reader and room. |

Details (#69, #70, #144; code in `packages/server/src/chat/` and `repos/dynamo/chat.ts`):

- **Rooms.** A room id is `league`, `trash-talk`, `draft`, `trades`, `waivers-news`, a matchup room `m-<season>-W<nn>-<matchupId>`, or a DM `dm-<teamA>-<teamB>` (team ids sorted). Room ids use only `[A-Za-z0-9._-]`, so they never contain the `#` separator. Matchup rooms are derived from the schedule and DMs start with their first message; no room item is stored.
- **Why one partition with room-prefixed keys, not a partition per room.** The access patterns are "one room newest first with a cursor", "unread count per room", "a team's DMs", and "an author's messages across all rooms in the last minute or day" (rate limits, agent budgets). A room prefix serves the first two as well as a partition would; one league partition keeps the cross-room reads (activity, DM list, read markers) and `delete_league` to single-partition queries. A league's chat stays far below one partition's throughput.
- **Item.** Every message stores its plain fields: `id`, `leagueId`, `roomId`, `kind` (`user`, `agent`, or `system`), `author` (`teamId`, `teamName`, `name`), `text`, `mentionedTeamIds`, `event` (for system messages, the `detailType` and `eventId` announced), and `createdAt`. The put is conditional (`attribute_not_exists(pk)`), so a message is written at most once; the activity and DM items follow it (a failure there costs a rate-limit count, never a message). Items stored before rooms have no `roomId` and read as `trash-talk`.
- **Paging.** `get_chat` queries the room's prefix in reverse with `Limit = limit + 1`. The extra item says whether an older page exists. The cursor (`nextCursor`, passed back as `after`) is the base64url sort key of the last message returned, and it resumes with `ExclusiveStartKey`. A cursor that does not decode to a key of the requested room is rejected.
- **Unread counts.** `list_chat_rooms` reads the caller's read markers (one query), then per room one reverse query `sk BETWEEN <prefix><lastReadAt>#~ AND <prefix>~` projecting `createdAt` with `Limit = 100`: the items are the unread messages (capped at 100) and the first is the newest. A room with nothing unread takes a second `Limit = 1` query for `lastMessageAt`. `mark_room_read` and posting move the marker forward only (conditional on `lastReadAt < :at`).
- **Rate limit.** `post_message` reads the activity index for the last 60 seconds and refuses a sixth message from the same author in any room within 60 seconds (`RATE_LIMITED`). No counter item is needed.
- **System messages.** The id is `sys-<EventBridge event id>` and the time is the event's own `time`, so a redelivered event hits the same key and the conditional put stores nothing (idempotent per event id). The room comes from `SYSTEM_MESSAGE_ROUTES` in core. A week going final also posts `sys-<event id>-<matchupId>` to each matchup room.
- **DM privacy.** Only the two teams' principals may read or post in a DM (the ops check it); `Chat Message Posted` for a DM carries the two `teamIds`, and the realtime relay sends it only to their team topics. A DM belongs to the people who wrote it, not the seat: each team item records `occupiedSince` (set when a person claims the seat, when it goes back to an agent, and when its seat type changes), and `get_chat` and `list_chat_rooms` show a team's current occupant only the DM messages created at or after it (the unread query's lower bound becomes `<prefix><occupiedSince>`). Teams stored before the field fall back to `createdAt`.
- **Agent chat budgets.** `post_message` counts the league's `kind = agent` activity items over the last 24 hours, in every room (per agent and per league), and refuses past the daily budgets; `list_chat_rooms` reports what is left (`postingBudget`) so the chat tasks skip before calling a model. The router's chat cooldowns use the agent trigger-state items (`AGENTSTATE#<agentId>#chat` and `AGENTSTATE#league#chat_moment`).

### Player universe: `pk = PLAYER#<playerId>`

| Entity | `sk` | GSI keys | Notes |
|---|---|---|---|
| Player profile | `PROFILE` | GSI1 `PLAYERIDX#<position>` / `<normalized name>#<playerId>` | `get_player` by id is a GetItem. The player sync job writes profiles in batches of 25, each with a `source` attribute (the normalized Sleeper record) that the next sync diffs against. |
| News item (player copy) | `NEWS#<ts>#<newsId>` | none | A player's news is a query in his own partition. |

#### Player name search

Players are resolved by name everywhere (`search_players`, `get_player`, and every operation that takes `player`). DynamoDB has no text search, and the fantasy-relevant universe is small (roughly 2,000 to 3,000 players), so:

1. GSI1 holds a **name index sharded by position**: `GSI1PK = PLAYERIDX#QB` (RB, WR, TE, K, DEF), `GSI1SK = <normalized name>#<id>`. There are six shards, so no one partition is hot.
2. The server loads the index (six paginated queries, a few hundred KB) into memory in each Lambda container and caches it for 10 minutes on `ctx.clock` (`PlayerDirectory`). A position filter reads a single shard.
3. Matching runs in-process (`players/match.ts`): exact name or alias ("CMC"), last name, prefix, per-token prefix, then small typos (edit distance). A team or position word in the query ("mccaffrey sf") becomes a filter. Ties are broken by rank.
4. Resolution returns one player, `AMBIGUOUS_PLAYER` with the top-tier candidates, or `PLAYER_NOT_FOUND` with a fix.

Because `GSI1SK` starts with the normalized name, a later last-name prefix query (`begins_with`) is possible without a schema change if the universe ever outgrows the in-memory approach.

### News: `pk = NEWS#<newsId>` and `pk = TEAMNEWS#<team>`

`newsId` is a hash of the normalized article URL (docs/data-sources.md).

| Entity | `pk` | `sk` | GSI keys | Notes |
|---|---|---|---|---|
| News item (canonical) | `NEWS#<newsId>` | `ITEM` | GSI2 `NEWS` / `<publishedAt>#<newsId>` | Written with `attribute_not_exists(pk)`: the dedupe gate. The league-wide feed (`get_news` with no filter) is a reverse GSI2 query bounded by the time window. |
| News item (team copy) | `TEAMNEWS#<team>` | `NEWS#<publishedAt>#<newsId>` | none | `get_news` by team is one query. |

Copies (player and team) are written only after the canonical put succeeds, and every news item
has a 90-day `ttl`.

### Stats and projections

| Entity | `pk` | `sk` | GSI keys | Notes |
|---|---|---|---|---|
| Stat line | `STATS#<season>#W05` | `PLAYER#<playerId>` | GSI2 `PLAYERSTATS#<playerId>` / `<season>#W05` | Scoring a week reads one partition (all players). A player's game log is a GSI2 query. Corrections overwrite the item and keep `correctedAt`. |
| Projection snapshot pointer | `PROJ#<season>#W05` | `ASOF#<ts>` | none | One item per ingest. "The latest projections as of t" is a reverse query with `sk <= ASOF#t`, limit 1. The simulator relies on this for its `asOf` reads. |
| Projection | `PROJ#<season>#W05#<ts>` | `PLAYER#<playerId>` | none | Snapshots are immutable, so a replay sees exactly what an agent would have seen at the time. |
| Season research (#136) | `SEASON#<stats\|projections>#<season>` | `PLAYER#<playerId>`, `META` | none | One item per player with every week's line (last season's stats, or this season's projections); the draft board reads the partition and scores it with the league's settings at read time. `META` holds the weeks and content hash. |
| Trending snapshot | `TRENDING#<add\|drop>` | `ASOF#<ts>` | none | `get_trending_players` reads the latest snapshot, or the one as of a given time. One item holds every cached lookback window (24h, 72h, 168h). 30-day `ttl`. |
| NFL state | `NFLSTATE` | `CURRENT` | none | Season and week. Drives week rollover. Written conditionally on its `revision` (`<season>:<seasonType>:<week>`), so a rollover is announced once. |
| NFL schedule | `NFLSCHED#<season>#W05` | `GAME#<kickoff>#<gameId>` | none | Per-player lineup locks at kickoff, and the game windows for live scoring. A flexed game leaves a stale copy under its old kickoff; reads keep the most recently synced copy of each game id. |
| Season schedule | `NFLSCHED#<season>` | `SEASON` | none | Bye weeks, game count, and when the schedule was synced. |
| Live NFL games | `NFLGAMES#<season>` | `W05` | none | The latest read of ESPN's scoreboard for the week (scores, status, possession, red zone), replaced on every live-scoring run. Possession and the red zone are only served while the read is under 10 minutes old. 14-day `ttl`. |

### Operational records

| Entity | `pk` | `sk` | GSI keys | Notes |
|---|---|---|---|---|
| Idempotency record | `IDEMP#<principalKey>` | `KEY#<key>` | none | Keys are scoped per principal. The record stores the request hash, the state (`in_progress` or `complete`), a lock deadline, and the response (status plus JSON). `begin` is a conditional put that also succeeds when the record's TTL has passed or its lock is stale. `ttl` is 24 hours. |
| Audit entry | `AUDIT#LEAGUE#<leagueId>`, or `AUDIT#DAY#<yyyy-mm-dd>` when no league is involved | `<ts>#<auditId>` | GSI2 `AUDIT#PRINCIPAL#<principalKey>` / `<ts>#<auditId>` | Every mutation attempt that passes authentication and validation is recorded: principal, team (for agents), operation, league, idempotency key, and outcome. A league's log and an actor's log are each one reverse query. |

## Access patterns

| Pattern (SPEC §6 tool or job) | How |
|---|---|
| `get_league_state` | GetItem `LEAGUE#id` / `META` |
| My leagues | GSI1 query `USER#<sub>`, then GetItem each `META` |
| League quota (active leagues a user created) | GSI1 query `CREATOR#<sub>` |
| Accept or preview an invite | GSI1 query `INVITE#<sha256(token)>` |
| League membership check | GetItem `META` plus a `begins_with(TEAM#)` query (at most 12 teams) |
| Delete a league (setup only) | Query the partition's keys, then batch delete, `META` last so an interrupted delete can be retried |
| `get_roster` | GetItem `ROSTER#<teamId>` |
| `get_standings` | Query `STANDINGS#`, reverse, limit 1 |
| `get_matchup`, `get_matchup_outlook` | Query `MATCHUP#W05#`, plus lineups and projections |
| `get_nfl_games` | Query `NFLSCHED#<season>#W05`, plus GetItem `NFLGAMES#<season>` / `W05` |
| `search_players`, `get_player` (by name) | In-memory index from GSI1 `PLAYERIDX#<pos>` |
| `get_player` (by id) | GetItem `PLAYER#id` / `PROFILE` |
| `get_projections` | Latest `PROJ#…` pointer as of now, then the snapshot partition (or GetItem for one player) |
| `get_trending_players` | Query `TRENDING#add`, reverse, limit 1 |
| `get_news` | Per player: query `PLAYER#id`, `sk BETWEEN NEWS#<since> AND NEWS#<until>`. Per team: the same on `TEAMNEWS#<team>`. League-wide: GSI2 `NEWS` |
| Live scoring gate (`ingestStats`) | GetItem `NFLSTATE`, then query `NFLSCHED#<season>#W05` |
| Player sync diff | The six GSI1 `PLAYERIDX#` shards (the `source` attribute) |
| `get_transactions` | Query `TXN#`, reverse, paginated |
| `get_chat`, `post_message` | Query or put in `CHAT#<leagueId>` (reverse, `Limit` + 1, `ExclusiveStartKey` cursor) |
| System chat message | Conditional put `CHAT#<leagueId>` / `MSG#<event time>#sys-<event id>` |
| `get_draft_board`, `make_draft_pick` | GetItem `DRAFT`; a version-checked put of `DRAFT`, then the team's roster |
| `set_lineup` | Put `LINEUP#W05#<teamId>` |
| `drop_player`, `claim_waiver`, `cancel_waiver_claim` | Conditional `OWN#` put, version-checked `TEAM#` write, then `WAIVERWIRE#`/`WAIVER#`/`TXN#` puts (ordered writes, no transactions) |
| `preview_waiver_claim`, `preview_trade` | Reads only (roster, lineup, projections) |
| `propose_trade`, `counter_trade`, `respond_to_trade`, `withdraw_trade` | Conditional update on `TRADE#<id>` (`version`) |
| Process trade | Version-checked `TRADE#` stamp, then ordered idempotent writes: `OWN#` locks, both `TEAM#` rosters, `WAIVERWIRE#` drops, `TXN#`, the week's `LINEUP#`, and finally `TRADE#` (no transactions) |
| Waiver processing job | GSI2 `LEAGUEPHASE#regular_season` and `#playoffs`, then per league: put `WAIVERRUN#<day>`, query `WAIVER#` and `WAIVERWIRE#`, write teams, claims, and `TXN#` |
| Scoring job | Query `STATS#<season>#W05`, then the week's lineups and matchups |
| Season jobs (live scoring, weekly cycle) | GSI2 queries `LEAGUEPHASE#regular_season` and `LEAGUEPHASE#playoffs` |
| Idempotent replay | GetItem or conditional put on `IDEMP#…` |
| Audit by league or actor | Query `AUDIT#LEAGUE#id`, or GSI2 `AUDIT#PRINCIPAL#…` |

## Consequences

- One table keeps IAM, backups, and transactions (which need a single table in practice) simple, and a whole league can be moved or deleted by partition.
- A league partition holds the whole season's history. With at most 12 teams that is a few thousand items, far below any partition limit. Write throughput per league is tiny, and DynamoDB adaptive capacity covers the bursts (draft night, waiver processing).
- The player name index costs one warm-up read per container every 10 minutes. It is eventually consistent with the sync job, which is fine for data that refreshes once or twice a day. `PlayerDirectory.invalidate()` exists for a sync that must be seen immediately.
- The in-process DynamoDB used by tests and local dev (dynalite) supports this whole design, except `TransactWriteItems`, which the transactional repositories will need an in-memory fallback or a DynamoDB Local job to test.
- The league lifecycle therefore uses ordered conditional writes instead of transactions. Creating a league writes the teams and the creator's membership before `META`, so nothing is visible until the league item exists. Joining claims the seat (version check), then adds the membership (`attribute_not_exists`), then counts the invite use (version check), and undoes the earlier writes if a later one loses a race.
- Infra must create the table exactly as `tableDefinition()` describes (key names, `GSI1` and `GSI2` with `ALL` projection) and enable TTL on `ttl`.
