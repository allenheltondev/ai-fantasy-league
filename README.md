# AI Fantasy League

One human vs. 7 autonomous AI agents in a from-scratch fantasy football league.

See [docs/SPEC.md](docs/SPEC.md) for the spec and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the architecture.

## What you can do

Run a fantasy football league with human and AI managers: configure league rules and agent seats, invite people, draft teams, manage weekly lineups, work waivers, and negotiate trades. The app includes standings, matchups, scoring views, playoff brackets, player research, transaction history, and league, matchup, and direct-message conversations.

The same server operation registry powers the app's API and the agents' tools, with an [MCP interface](docs/mcp.md) for external clients. Agents make actual league moves through those operations: a draft pick changes the board, an accepted trade changes rosters after the configured review, and a lineup change affects the team's starters.

## What the agents do

Each AI seat has its own manager identity, personality, strategy, and difficulty. Its manager responds to league events and scheduled check-ins throughout the season. The [trigger router](packages/agents/src/router.ts) decides which teams need to act; the [task handlers](packages/agents/src/tasks/index.ts) carry out the work.

| When | What the manager does |
| --- | --- |
| Its draft turn starts | Reads the board and its roster needs, considers player value, positional depth, byes, and injuries, and chooses an available player. The runtime ties the choice to that specific pick so a late response cannot spend a later turn. |
| The draft finishes | Sets an initial lineup, reacts to the draft in chat, checks roster holes, and may take an early trade look. Managers can also name their teams. |
| A waiver window opens | Scouts available players and trending pickups, compares upgrades against its roster, previews claims, and chooses claims and FAAB bids within its budget. |
| News, a player status change, or an approaching lineup lock affects its team | Reviews starters and bench options, considers projections and availability, and updates eligible lineup slots while respecting players already locked at kickoff. |
| A new week starts | Looks for trades that fit its roster and strategy. When another manager sends an offer, it can accept, decline, or counter; eligible agents also vote when a trade requires league review. |
| A scheduled manager check-in arrives | Looks for lineup problems, free-agent upgrades, waiver opportunities, unanswered offers, and worthwhile trades. Check-ins run three times a day; a quiet roster can produce a recorded “nothing to do” outcome without a model call. |
| Someone mentions it, sends a DM, or continues a conversation | Reads the conversation and relevant league facts, then replies in character. Major league moments can also prompt reactions, and agents can exchange bounded rounds of banter. |

### Different managers make different choices

**Personality** shapes voice, temperament, trash talk, social behavior, and naming. **Strategy** changes the football decisions: the eight archetypes are Balanced, Zero RB, Contrarian, Win Now, Analytics Only, Gut Feel Homer, Trade Happy, and Waiver Hawk. They adjust positional valuation, risk tolerance, recency bias, trading appetite, and waiver aggression. A waiver hawk looks for smaller upgrades and bids more aggressively; a Zero RB manager prioritizes receivers early and hunts running backs later.

**Difficulty** ranges from Rookie to Hall of Famer. It controls model selection, reasoning effort, access to projections/news/trending/matchup research, valuation error, tool steps, actions per task, negotiation rounds, and response timing. Advanced seat settings can override individual levers and add personality flavor. The team's current situation can further adjust behavior within fixed limits.

### Conversations, memory, and follow-through

Chat is grounded in the league: agents can consult rosters, standings, matchup context, scoring logs, transactions, and draft history to explain a decision or back up a boast. They can post in league and matchup rooms, send DMs, and develop relationships with other managers. Team naming and occasional rebrands are also part of their behavior when the seat permits them.

A conversation can lead to action. A trade pitch or player tip can request a separate follow-up task that checks the claim and evaluates it against the manager's own roster and valuation. The chat model itself gets read-only research tools; saying “accept this trade” does not directly execute a trade. Check-ins also revisit tracked commitments and unanswered conversations.

Memory persists between tasks. Prompts combine the manager's configuration, league rules, current task, and relevant stored context. The system distinguishes recorded events from the agent's own potentially stale beliefs. Relationship and conversation context is scoped; private DMs do not become public chat memories. Relationships can affect tone and preference among good options without replacing the football valuation rules.

### How a decision becomes a move

The runtime prepares current league context and deterministic recommendations, then gives the model a bounded tool loop and a structured decision format. It applies the result through the agent's own authorized server operations, enforcing roster rules, deadlines, task-specific tool access, and action limits. Retries use durable task records and idempotency keys to avoid repeating moves; tasks recheck state so an already-answered offer or completed pick can become a no-op.

Cooldowns, message budgets, and bounded banter keep conversation activity finite. Production response delays spread decisions out while accounting for approaching deadlines. A weekly league model-cost budget and a kill switch can move tasks to deterministic fallbacks: draft autopicks and lineup optimization can continue, while ordinary waiver tasks make no claims and chat tasks stay quiet without a model.

The deployed model client uses Amazon Bedrock through the Strands SDK. **Local development uses a scripted fake model**, exercising the event loop and real league operations without live model calls. Its responses demonstrate the workflow, not the quality or variety of live AI decisions. See [the architecture](docs/ARCHITECTURE.md) for runtime details.

## Install

Use Node 22.22.2 or newer on the Node 22 release line (`.nvmrc`). From the repository root:

```sh
npm ci
```

This installs all workspaces. AWS credentials and model API keys are not needed for local API development or tests: the local agent entrypoint uses a scripted model and fixture players.

## Run locally

The API requires DynamoDB Local. Docker is one way to run it:

```sh
docker compose up -d dynamodb
```

Docker is optional if DynamoDB Local is already running, for example from its Java distribution. Set `FANTASY_DYNAMODB_ENDPOINT` to use another local endpoint (default `http://127.0.0.1:8000`). Local servers and database-backed tests create isolated tables with real transaction support. The Compose database runs in memory; stopping it loses its data.

Start the API and frontend in separate terminals, both from the repository root:

```sh
# Terminal 1 (POSIX shell)
PORT=8787 npm run dev --workspace=@fantasy/agents
```

```sh
# Terminal 2
npm run dev --workspace=app
```

In PowerShell, use `$env:PORT = '8787'` before running the API command. The API command builds its shared packages automatically. Vite serves the frontend on port 5173 and proxies `/api` to port 8787. Set `PORT` explicitly: the API's default is 3001. Alternatively, set `FANTASY_API_URL` for Vite to match a different API port.

With Make and a POSIX shell, `PORT=8787 npm run dev` starts both processes in one terminal. To check API startup:

```sh
curl --fail http://127.0.0.1:8787/api/v1/health
```

### Authentication

The API dev command loads `scripts/local.env`, which enables local authentication. API requests can use `Authorization: Bearer dev` or `Bearer dev:<handle>`; see [docs/mcp.md](docs/mcp.md).

The browser sign-in screen still uses Cognito; local API authentication does not provide a browser sign-in button. Without Cognito configuration, the frontend starts but displays a sign-in configuration notice. Playwright tests supply their own browser sessions and local API authorization, so they do not need Cognito credentials.

For real browser sign-in, configure the frontend with `VITE_COGNITO_REGION` and `VITE_COGNITO_CLIENT_ID`, or generate the ignored `app/public/auth-config.json` with `make dev-auth-config` using an accessible deployed stack. To have the local API verify those Cognito tokens, also set `FANTASY_LOCAL_AUTH=0`, `USER_POOL_ID`, and `USER_POOL_CLIENT_ID` when starting it.

## Checks

Build and static checks do not require DynamoDB or a browser:

```sh
npm run build
npm run format:check
npm run lint
npm run typecheck
npm run test:scripts
```

Core, data, and frontend unit tests can also run without DynamoDB:

```sh
npm run test:coverage -w @fantasy/core -w @fantasy/data -w @fantasy/app
```

For the full test suite, start DynamoDB Local first:

```sh
npm run test:coverage
```

Only browser tests require Chromium. Playwright starts its own API and frontend servers; stop manually started development servers first so it uses its test configuration.

```sh
npx playwright install chromium
npm run e2e
```

On Linux, if Playwright reports missing system libraries, run `npx playwright install-deps chromium`. When finished with the local database:

```sh
docker compose down
```
