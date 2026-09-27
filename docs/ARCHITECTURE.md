# Architecture

This is the contract every work stream builds against. The product is described in `docs/SPEC.md`, and the resolved decisions are in its §10. If code and this document disagree, fix one of them in the same PR.

## Stack

- **Language:** TypeScript everywhere. Node 22, ESM, `strict` mode, no `any` (use `unknown` and narrow). Validation is done with `zod`.
- **Monorepo:** npm workspaces, one lockfile at the root.
- **Backend:** AWS SAM (`infra/template.yaml`) in us-east-1:
  - Lambda (arm64, Node 22) and API Gateway-free routing: CloudFront `/api/*` → Lambda Function URL, the same pattern as llm-eval-harness. The SPA bucket is private behind CloudFront OAC. The Function URL is `AuthType NONE`, because OAC for Function URLs needs the viewer to send a body hash on POST/PUT, which browsers can't do. The API verifies the Cognito ID token on every route except health and OpenAPI.
  - The SPA learns its Cognito app client at runtime from `/auth-config.json`, which `make deploy-frontend` writes from the stack outputs.
  - DynamoDB for data, EventBridge (the default bus shared with rsc-core), Step Functions for workflows, and the rsc-core deferred-event scheduler for timed events.
- **Frontend:** a Vite + React 19 SPA in `app/`, served from S3 + CloudFront at `fantasy.readysetcloud.io` (Staging uses the CloudFront domain). It uses `@readysetcloud/ui` for components, tokens, the Tailwind preset, and auth (`@readysetcloud/ui/auth`).
- **Identity:** the shared rsc-core Cognito pool (`/readysetcloud/auth/user-pool-id` from SSM). This stack creates its own app client in that pool. The API verifies ID tokens with `aws-jwt-verify`.
- **Realtime:** Momento Topics, using the API key from the rsc-core secrets SSM parameter. The API vends short-lived, scoped tokens to browsers.
- **Agents:** `@readysetcloud/agent` runs Strands on Bedrock. Autonomous turns use `runAgentTask`/`runAgent` in-Lambda. Agents call the league **only** through the operation registry (below) with their own principal.

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
              - event handlers, scheduled jobs, and Step Functions task handlers
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
- **The MCP tool list**
- **The tool set agents receive**

An agent's tool call runs the **same handler with the same authorization, validation, and phase checks** as a human's HTTP call. The only difference is that the principal is `{ type: 'agent', agentId, teamId }` instead of a user. There are no agent-only operations.

### Response envelope

Every success response looks like this:

```json
{ "data": ..., "league": { "phase": "waivers_open", "week": 5, "allowedActions": ["claim_waiver", ...] }, "warnings": [...] }
```

Every error looks like this:

```json
{ "error": { "code": "ROSTER_FULL", "message": "Roster full (15/15).", "fix": "Include drop_player_id with one of: ...", "details": {...} } }
```

- `fix` is required for every 4xx and is written for a model.
- Players always appear as `{ id, name, team, position }`.
- Any operation that takes a player accepts either `playerId` or `player` (a name). Ambiguous names return `AMBIGUOUS_PLAYER` with a list of candidates.
- `detail: true` switches compact responses to full ones.
- Mutations take an `Idempotency-Key` header (for agent tools, the `idempotencyKey` argument). Replays return the stored response.

### Context

Handlers receive `ctx = { principal, clock, repos, events, data, log }`.
- **Never** call `Date.now()` or `new Date()` in domain or server code. Use `ctx.clock.now()`. The simulator swaps in its own clock.
- `ctx.events.publish(detailType, detail)` puts events on the default bus with `source: 'fantasy'`.
- `ctx.events.scheduleAt(...)` emits the rsc-core `Schedule Event`.

## Data

- **One table, `FantasyTable`.** The key design is in `docs/adr/001-table-design.md`, which is owned by issue #20. Repositories are interfaces in `packages/server/src/repos/` with two implementations each: DynamoDB and in-memory (for unit tests).
- **Player universe and stats** are stored in the same table under `PLAYER#` and `STATS#` partitions, and are refreshed by scheduled jobs.
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
| Simulation | vitest | `sim`: replay N weeks of 2025 with scripted agents; asserts invariants (valid rosters, conservation of FAAB, and so on) | CI (short); full season nightly |
| Deploy smoke | node script | `scripts/deploy-smoke.mjs` against the deployed URL, with no AWS credentials | After deploys |
| Template | `sam validate --lint` | `infra/` | CI |

**Local dev** is `npm run dev`: a local API server (the Hono node adapter, dynalite, `FANTASY_FAKE_MODEL=1`, fixture data) plus Vite with the `/api` proxy.

## Models

`packages/core/src/agents/models.ts` is the model catalog. It holds each difficulty tier's model IDs (Bedrock inference profile IDs). CI runs `scripts/verify-models.mjs`, which calls `bedrock list-inference-profiles` with deploy credentials and fails if a catalog ID isn't available in us-east-1.

## Events (source `fantasy`)

| Detail type | Emitted when |
|---|---|
| `League Created` | A league is created |
| `Draft Turn Started` | A team is on the clock |
| `Draft Pick Made` | A pick is made |
| `Draft Completed` | The draft ends |
| `Week Rolled Over` | A new NFL week starts |
| `Lineup Lock Approaching` | A game window is about to lock lineups |
| `Waiver Window Opened` | Waivers open |
| `Waivers Processed` | Waiver claims are resolved |
| `Trade Proposed` / `Trade Countered` / `Trade Accepted` / `Trade Rejected` / `Trade Expired` / `Trade Processed` / `Trade Vetoed` | A trade moves through its state machine |
| `Player News Alert` | News hits a player |
| `Player Status Changed` | A player's status, injury, team, or depth chart changes |
| `Chat Mention` | Someone is mentioned in chat |
| `Chat Moment` | A league event agents can react to in chat |
| `Scores Updated` | Live scores change |
| `Week Provisionally Final` | The last Monday night game ends |
| `Week Official Final` | The Thursday stat-correction job finishes |
| `Stat Correction Applied` | A stat correction changes a score |
| `Agent Action Requested` | An agent is triggered to act |

## Work-stream and PR rules

- **One issue per PR.** Name the branch `ws/<issue-number>-<slug>` and put `Closes #N` in the PR body. Keep PRs reviewable; split anything over about 1,500 changed lines of non-generated code.
- **Before opening a PR,** run `npm run lint`, `npm run typecheck`, and `npm test` locally, plus the package's integration and e2e tests if you touched them.
- **Merge** only after every check passes and an objective review pass on the diff has confirmed correctness, tests at the right layers, no secrets, and conformance with this document. Squash-merge.
- **After each epic closes,** do a whole-epic review, recorded as a comment on the epic, and file follow-up issues.
