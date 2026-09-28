# Architecture

This is the contract every work stream builds against. The product is described in `docs/SPEC.md`, and the resolved decisions are in its §10. If code and this document disagree, fix one of them in the same PR.

## Stack

- **Language:** TypeScript everywhere. Node 22, ESM, `strict` mode, no `any` (use `unknown` and narrow). Validation is done with `zod`.
- **Monorepo:** npm workspaces, one lockfile at the root.
- **Backend:** AWS SAM (`infra/template.yaml`) in us-east-1:
  - Lambda (arm64, Node 22) and API Gateway-free routing: CloudFront `/api/*` → Lambda Function URL, the same pattern as llm-eval-harness. The SPA bucket is private behind CloudFront OAC. The Function URL is `AuthType NONE`, because OAC for Function URLs needs the viewer to send a body hash on POST/PUT, which browsers can't do. Instead CloudFront sends an `X-Origin-Verify` secret header to that origin and the API refuses (403) any request without it, before auth runs; the secret lives in SSM at `/<stack>/origin-verify/{current,previous}` (created by `make deploy-backend`, rotated with `make rotate-origin-secret`, both values accepted during a rotation). The local dev server has no such check. The API verifies the Cognito ID token on every route except health and OpenAPI.
  - The SPA learns its Cognito app client at runtime from `/auth-config.json`, which `make deploy-frontend` writes from the stack outputs.
  - DynamoDB for data, EventBridge (the default bus shared with rsc-core), EventBridge Scheduler for recurring jobs, and the rsc-core deferred-event scheduler for timed events. The weekly cycle is clock-driven jobs plus deferred events rather than Step Functions (`docs/adr/002-weekly-cycle.md`).
  - **Failures (#130):** every asynchronously invoked function (the EventBridge rule handlers and the data jobs) has a Lambda OnFailure destination on the default bus. An invocation that still fails after Lambda's two retries becomes `Lambda Function Invocation Result - Failure`, and `FailureNotifierFunction` (`packages/server/src/failures/`) emails it, with the failed event, to `AlarmEmail` through rsc-core's `Send Email`. League jobs finish every league, then throw if any failed (`settle` in `packages/server/src/jobs/deps.ts`), so partial failures are retried and emailed too; a league that stays broken sends one email per run. CloudWatch alarms, error-log metric filters, and SQS dead-letter queues wait until the deploy role allows them (#129).
- **Frontend:** a Vite + React 19 SPA in `app/`, served from S3 + CloudFront at `fantasy.readysetcloud.io` (Staging uses the CloudFront domain). It uses `@readysetcloud/ui` for components, tokens, the Tailwind preset, and auth (`@readysetcloud/ui/auth`).
- **Identity:** the shared rsc-core Cognito pool (`/readysetcloud/auth/user-pool-id` from SSM). This stack creates its own app client in that pool. The API verifies ID tokens with `aws-jwt-verify`.
- **Realtime:** Momento Topics, using the API key from the rsc-core secrets SSM parameter. The API vends short-lived, scoped tokens to browsers.
  - **Settings:** the key is the `momento` field of the rsc-core secret (`/readysetcloud/secrets` names it), and the cache is rsc-core's default cache (`/readysetcloud/cache-name`). Realtime is on only when both are configured (`packages/server/src/realtime/config.ts`); otherwise the no-op implementation is used, and nothing in local dev, tests, or CI needs Momento credentials.
  - **Topics:** `fantasy.league.<leagueId>` carries a league's chat messages and events, `fantasy.team.<leagueId>.<teamId>` (`teamTopic`) carries what only that team may see (its waiver awards, and trade offers, counters, rejections, and expiries it is part of, which never go to the league topic), and `fantasy.global` carries events with no league (the live-stats job's `Scores Updated`). Items are JSON: `{ type: 'chat', leagueId, message }` or `{ type: 'event', detailType, eventId, time, leagueId, detail }`, with the event detail passed through unchanged.
  - **Tokens:** `get_realtime_token` (people only) returns a disposable token that can only subscribe to the league topic, the caller's own team topic (when they hold a seat), and the global topic, for 30 minutes. When realtime is off it returns `enabled: false`, and the app polls `get_chat` every `pollIntervalSeconds`.
  - **Publisher:** `RealtimePublisherFunction` (`realtime/relay.ts`) relays league events from the bus to the topics. It is the only function besides the API that reads the Momento key.
- **Agents:** `@readysetcloud/agent` runs Strands on Bedrock. Agents call the league **only** through the operation registry (below) with their own principal.
  - **Flow:** league events → the trigger router Lambda (`packages/agents/src/router.ts`) → `Agent Action Requested` → the agent task Lambda (`packages/agents/src/runner.ts`).
  - **Runs:** autonomous turns use `runAgent` in-Lambda: structured output, bounded tool loops, and trusted `invocationState`.
  - **Idempotency:** each task is idempotent through a claim on its task id in the league table.
  - **Task kinds:** each feature (draft, lineups, waivers, trades, chat) adds a task kind (`packages/agents/src/tasks/kinds.ts`) with a deterministic fallback.
  - **Customization:** a seat's personality, difficulty, and archetype are data in `packages/core/src/agents/`. Archetypes shape deterministic behavior (`behavior.ts`: draft position weights, the waiver minimum gain and FAAB aggressiveness, lineup risk, and the trade appetite the trade kinds read); difficulty levers set the model, the research tools bound, tool-loop steps, token budget, actions per trigger, cooldowns, and negotiation rounds. The commissioner can change a seat until the season is complete; it applies on the next trigger.
  - **Memory:** each agent has a private league memory in the table (`AGENTMEM#<agentId>`): notes, rivalries, trades, its own decisions, and a snapshot of its last chat. The router function writes results and trade steps; the runner writes decisions. It is summarized into the prompt within a token budget. The chat snapshot reaches chat tasks only, and chat decisions carry no notes, so chat text never becomes trusted context for tool-using tasks. Storage sits behind `AgentMemoryStore` (AgentCore Memory is a possible later backend; see `docs/adr/003-agent-realtime-runtime.md` for why agents run as event-triggered tasks rather than live sessions).
  - **Spend guard:** `LEAGUE_QUOTA` per creator, a weekly per-league ceiling from the difficulty mix, and the kill switch (SSM). The API reads the kill switch only to show it to commissioners (`get_agent_activity`); `get_model_leaderboard` ranks models by standings and cost.
  - **Tests and local dev:** `FANTASY_FAKE_MODEL=1` swaps in a scripted model that makes no Bedrock calls.

## Repository layout

```
packages/
  core/     Pure domain logic. No AWS or network imports. It holds:
              - rules and settings (Yahoo defaults), scoring, rosters and lineups
              - schedule, standings, playoffs
              - draft, waivers, trades
              - valuations, the lineup optimizer, trade value math
              - agent catalogs (personalities, difficulties, archetypes, models)
            Target: 100% of the league rules are testable here.
  data/     External data. The Sleeper client, nflverse loaders, the ID crosswalk,
            and the RSS news fetcher. All of it sits behind a `DataProvider`
            interface that takes an `asOf` time. Recorded fixtures live in
            `packages/data/fixtures/`.
  server/   The Lambda code:
              - the operation registry and the REST adapter (Hono)
              - the OpenAPI generator and the MCP server
              - auth, repositories (DynamoDB and in-memory)
              - event handlers and scheduled jobs (data, live scoring, the weekly cycle)
  agents/   The agent runtime:
              - prompt assembly from catalogs, config, and memory
              - tool binding from the registry, trigger routing, per-agent memory
              - a fake scripted model for tests
  sim/      The season replay simulator: a simulated clock, historical providers,
            and the runner and reports.
app/        Vite React SPA.
infra/      SAM template + samconfig.toml.
scripts/    Packaging, smoke tests, fixture recording.
docs/       SPEC, ARCHITECTURE, BOARD, ADRs (docs/adr/NNN-*.md).
```

Dependency direction:
- `core` depends on nothing internal.
- `data`, `server`, `agents`, and `sim` depend on `core`.
- `sim` also depends on `server` and `agents`: its league replay runs the real operations, jobs, and agents in process.
- `agents` depends on `server`'s registry types only.
- `app` depends on generated API types only.

Workspace packages are named `@fantasy/core`, `@fantasy/data`, and so on.

## The operation registry (one API for humans and agents)

Every capability is one `Operation`, defined once in `packages/server/src/operations/`:

```ts
defineOperation({
  name: 'claim_waiver',           // snake_case; this is also the MCP and agent tool name
  method: 'POST', path: '/leagues/{leagueId}/waivers/claims',
  summary: 'Claim a player off waivers or free agency',
  description: '<written for a model: when to use it, preconditions, common errors and how to fix them>',
  input: z.object({...}),         // path, query, and body merged
  output: z.object({...}),
  mutation: true,                 // requires an Idempotency-Key and is recorded in the audit log
  handler: async (ctx, input) => {...},
});
```

These are all generated from the registry, so they can't drift apart:
- **REST routes:** `/api/v1/...`
- **OpenAPI document:** `GET /api/v1/openapi.json` and `packages/server/openapi.json`, which is committed and checked in CI
- **The frontend's typed client**
- **The MCP tool list**, served by the league MCP server at `/api/v1/mcp` for a person's own assistant (`docs/mcp.md`)
- **The tool set agents receive**

An agent's tool call runs the **same handler with the same authorization, validation, and phase checks** as a human's HTTP call. The only difference is that the principal is `{ type: 'agent', agentId, teamId, leagueId }` instead of a user (`{ type: 'user', sub, email, name }`, built only from a verified Cognito ID token sent as `Authorization: Bearer <token>`). Agent principals are created in-process by the agent runtime (`invokeTool`) and are never accepted over HTTP. There are no agent-only operations.

### Response envelope

Every success response looks like this:

```json
{ "data": ..., "league": { "id": "...", "phase": "regular_season", "week": 5, "flags": { "waiversOpen": true, "preLock": true, "tradeDeadlinePassed": false }, "allowedActions": ["claim_waiver", ...] }, "warnings": [...] }
```

- **Phases** run `setup → drafting → regular_season → playoffs → complete`. The flags are sub-phase conditions derived from the league and the clock. `allowedActions` is computed per caller by `allowedActions`/`leagueAllowedActions` in `packages/server/src/league/phase.ts`: a rule table (phase, role, flag) for league mutations, and an operation's own `phases` for operations without a rule. Outsiders get an empty list.
- **League authorization** uses the guards in `packages/server/src/league/access.ts`: `requireMember` (people with a seat, the commissioner, and the league's own agents), `requireCommissioner`, and `requireTeamOwner` (a person changes only their own team, an agent only the team it plays). Every league-scoped operation calls one before it reads or writes.

Every error looks like this:

```json
{ "error": { "code": "ROSTER_FULL", "message": "Roster full (15/15).", "fix": "Include drop_player_id with one of: ...", "details": {...} } }
```

- `fix` is required for every 4xx and is written for a model.
- Players always appear as `{ id, name, team, position }`.
- Any operation that takes a player accepts either `playerId` or `player` (a name). Ambiguous names return `AMBIGUOUS_PLAYER` with a list of candidates.
- `detail: true` switches compact responses to full ones.
- Mutations take an `Idempotency-Key` header (for agent tools, the `idempotencyKey` argument). Replays return the stored response. A 5xx or a `CONFLICT` (a write race) is not stored, so a retry with the same key runs again.

### Context

Handlers receive `ctx = { principal, clock, repos, events, data, log, limits }`. `limits` holds per-deployment limits such as the league quota (`LEAGUE_QUOTA`, default 3 active leagues per creator, and `LEAGUE_QUOTA_ADMINS`, a comma-separated allowlist of subs or emails).
- **Never** call `Date.now()` or `new Date()` in domain or server code. Use `ctx.clock.now()`. The simulator swaps in its own clock.
- `ctx.events.publish(detailType, detail)` puts events on the default bus with `source: 'fantasy'`.
- `ctx.events.scheduleAt(...)` emits the rsc-core `Schedule Event`. Its `name` becomes an EventBridge Scheduler schedule name (at most 64 characters of `[0-9a-zA-Z-_.]`; rsc-core cuts longer names at 64), so build every name with `scheduleName(...parts)` (`events/schedule-name.ts`), which hashes a long name to a stable short one. The in-memory publisher refuses any other name.

## Data

- **One table, `FantasyTable`.** The key design is in `docs/adr/001-table-design.md`, which is owned by issue #20. Repositories are interfaces in `packages/server/src/repos/` with two implementations each: DynamoDB and in-memory (for unit tests).
- **The weekly cycle** (`packages/server/src/season/`, ADR 002): `scoreLiveWeek` recomputes in-season matchups every 2 minutes during game windows and emits `Scores Updated`; `advanceSeason` (every 15 minutes) marks a week provisionally final after the last Monday night game, snapshots the standings, and rolls the league to the next week, carrying lineups forward and scheduling `Lineup Lock Approaching` before each game window. Every player locks at his own kickoff, checked by `set_lineup`. A league drafted mid-season starts scoring at its next unlocked week (`startLeagueSeason`). The playoffs are a bracket rebuilt from the final standings and results (`season/playoffs.ts`), and `officialFinal` (Thursday) applies stat corrections, makes the week official, and awards achievements (`season/official.ts`).
- **Player universe and stats** are stored in the same table under `PLAYER#` and `STATS#` partitions, and are refreshed by scheduled jobs. One data jobs Lambda (`packages/server/src/jobs/`, the same zip as the API) runs the player sync, NFL state, schedule, live stats, projections, trending, and news jobs on EventBridge Scheduler cadences; `docs/data-sources.md` lists them with their keys, events, and the news feeds. Handlers read only stored data (`ctx.data.reference`).
- **Sleeper:** `api.sleeper.app` is reachable from CI and AWS, but not from every dev sandbox. Tests use the recorded fixtures in `packages/data/fixtures/sleeper/`, and `scripts/record-fixtures.mjs` refreshes them.

## Testing layers (all required)

| Layer | Tool | Where | Gate |
|---|---|---|---|
| Unit | vitest | every package, `*.test.ts` beside the source | Coverage ratchet: `core` ≥ 90% lines/branches; others at their achieved level, never lowered |
| Property | vitest + fast-check | `core`: scoring, the snake draft, waiver resolution, the trade state machine, the schedule | In the unit run |
| Integration | vitest + dynalite (in-process DynamoDB) | `server/test/integration`: repositories and full operation flows through the REST adapter | CI |
| Contract | vitest | Every operation's responses validate against its generated OpenAPI schema, and the committed `openapi.json` matches what the code generates | CI |
| Agent | vitest with a fake scripted model | `agents`: prompts, tool binding, trigger gating, fallbacks | CI |
| E2E | Playwright | `app/e2e`: SPA + local API server (dynalite, fake model, fixture data) | CI |
| Simulation | vitest | `sim`: replay N weeks of 2025 with scripted bots, and a league replay through the real server jobs, handlers, and agents on the fake model; asserts invariants (valid rosters, conservation of FAAB, and so on) | CI (short); full season and a week-4 start nightly |
| Deploy smoke | node script | `scripts/deploy-smoke.mjs` against the deployed URL, with no AWS credentials | After deploys |
| Template | `sam validate --lint` | `infra/` | CI |

**Local dev** is `npm run dev`: a local API server (the Hono node adapter, dynalite, `FANTASY_FAKE_MODEL=1`, fixture data) plus Vite with the `/api` proxy. The API half starts from `packages/agents/src/dev.ts`, which runs the in-process `EventLoop` (`packages/server/src/events/loop.ts`): agents pick on their draft turn and act on their other triggers with the fake model, the pick clock autopicks, system chat messages post, and the season jobs run on their cadences. E2E starts the plain server (`packages/server/src/local.ts`), where events are only recorded.

## Models

`packages/core/src/agents/models.ts` is the model catalog. It holds each model's Bedrock ID (a cross-region inference profile ID where one exists) and an estimated price, and maps five model tiers (`micro` → `frontier`) to catalog models, best first. Difficulty tiers pick a decision tier and a cheaper chat tier.

- **Verification:** every catalog entry starts `verified: false`. Both deploy workflows run `scripts/verify-models.mjs` after assuming the deploy role. It calls `bedrock list-inference-profiles` and `list-foundation-models` and fails the deploy, listing every catalog ID that isn't available in us-east-1.
- **Fallbacks:** if a tier's primary model is unavailable, the runtime uses the next model listed for that tier. If every model in the tier fails, the agent falls back to deterministic behavior (autopick, the lineup optimizer, no waiver claims, rejecting trades).
- **Prices** are estimates for budgets and dashboards, not billing data.

## Events (source `fantasy`)

Event details are a typed contract: `EVENT_DETAIL_SCHEMAS` (`packages/server/src/events/details.ts`) holds a zod schema per detail type, and `ctx.events.publish` is typed from it, so an emitter that drifts fails typecheck. The contract suite (`packages/agents/test/contract/events.test.ts`) runs the real emitters and feeds their details to every consumer: chat system messages, the realtime relay, and the agent router. A new event type with a consumer gets a schema and a case in that suite.

| Detail type | Emitted when |
|---|---|
| `League Created` | A league is created |
| `Draft Turn Started` | A team is on the clock |
| `Draft Pick Made` | A pick is made (`adp`, the pick's `reason`, and `notable`: a steal or reach by ADP, or an agent's first-round pick, which the chat calls out; core `notablePick`) |
| `Draft Completed` | The draft ends (`recap`: steals, reaches, and each agent's first pick with its reasoning, and `recapText` for the chat; core `draftRecap`) |
| `Draft Paused` / `Draft Resumed` | The commissioner freezes or restarts the pick clock; relayed so open boards stop or restart their countdown |
| `Draft Pick Deadline` | A pick's clock runs out (scheduled with `scheduleAt`; the API function autopicks if the pick is still open) |
| `Week Rolled Over` | A new NFL week starts (`syncNflState`), or a league moves to its next week (the weekly cycle; carries `leagueId`) |
| `Lineup Lock Approaching` | A game window is about to lock lineups |
| `Waiver Window Opened` | Waivers open (after every daily run; agents are triggered only for the first window of each league week) |
| `Waivers Processed` | Waiver claims are resolved (`awarded`: player refs, `bid`, and `cost` per award; a run with no awards posts nothing in chat) |
| `Trade Proposed` / `Trade Countered` / `Trade Accepted` / `Trade Rejected` / `Trade Expired` / `Trade Withdrawn` / `Trade Processed` / `Trade Vetoed` | A trade moves through its state machine. Every detail carries `leagueId`, `tradeId`, `fromTeamId` (made the offer), `toTeamId` (answers it), `teamIds`, and the players each side sends (`tradeEventDetail` in `server/src/trades/lifecycle.ts`). Offers, counters, rejections, expiries, and withdrawals are relayed only to the two teams' topics (`teamTopic`), never the league topic. An open offer voided because one of its players changed rosters is a `Trade Expired` with `voided: true` and `reasonCode: PLAYER_MOVED`. |
| `Trade Offer Deadline` / `Trade Review Ended` / `Trade Deadline Passed` | Scheduled with `scheduleAt`: an offer's expiry, the end of a trade's review period, and the league's trade deadline. The API function expires, processes, or expires every open offer; a stale event is a no-op. |
| `Player News Alert` | News hits a player |
| `Player Status Changed` | A player's status, injury, team, or depth chart changes |
| `Chat Mention` | Someone is mentioned in chat (`messageId`, `mentionedTeamIds`, `authorTeamId`, `authorType`). Mentions written by agents do not trigger agent replies. |
| `Chat Moment` | A league event agents can react to in chat (emitted with the system chat message for big moments) |
| `Chat Message Posted` | A chat message was stored (`detail.message`); the realtime publisher pushes it to the league topic |
| `Scores Updated` | Live stats change (`ingestStats`, player ids), or a league's matchup scores change (`scoreLiveWeek`, `leagueId`) |
| `Week Provisionally Final` | The last Monday night game ends (carries the recap: `topTeamId`, `topScore`, `blowout`) |
| `Week Official Final` | The Thursday stat-correction job finishes |
| `Stat Correction Applied` | A stat correction changes a matchup's score (`resultFlipped` when the winner changed) |
| `Season Completed` | The last playoff week is final and the league is `complete` (`championTeamId`, `runnerUpTeamId`) |
| `Achievement Earned` | A team earns a league achievement (`packages/core/src/history/achievements.ts`); the chat announces it |
| `Model Power Rankings` | A league with at least one agent seat rolls over to its next week: the "which model wins the league?" standings by model (record, trade value, waiver hit rate, cost), with one chat line per model (`season/model-stats.ts`). The chat posts it. |
| `Track Activity` | rsc-core badge chest activity for a human's achievement (`userId`, `action` such as `fantasy.championship.won`, `service: fantasy`). Only with `BADGE_CHEST_ENABLED=true` on the data jobs function (the template sets it; tests and local dev leave it off) |
| `Agent Action Requested` | An agent is triggered to act |
| `Member Joined` | A person takes a seat with an invite (`name`) |
| `Member Left` | A person leaves or is removed before the draft (`reason`: `left` or `removed`) |
| `Settings Changed` | The commissioner changes league settings (`changedPaths`). The chat system message for it is queued by the chat stream. |
| `Agent Seat Changed` | The commissioner changes an agent seat after the draft (`teamId`, `changedBy`, `changes: [{ field, from, to }]` by display name). The chat posts it, so a playing commissioner can't quietly weaken the AI teams they face. |

## Work-stream and PR rules

- **One issue per PR.** Name the branch `ws/<issue-number>-<slug>` and put `Closes #N` in the PR body. Keep PRs reviewable; split anything over about 1,500 changed lines of non-generated code.
- **Before opening a PR,** run `npm run lint`, `npm run typecheck`, and `npm test` locally, plus the package's integration and e2e tests if you touched them.
- **Merge** only after every check passes and an objective review pass on the diff has confirmed correctness, tests at the right layers, no secrets, and conformance with this document. Squash-merge.
- **After each epic closes,** do a whole-epic review, recorded as a comment on the epic, and file follow-up issues.
