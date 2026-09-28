# AI Fantasy Football League — Spec

A fantasy football league where one human (Allen) competes against 7 autonomous AI agents. Agents research, draft, set lineups, work waivers, propose and negotiate trades, and trash talk in a shared group chat. The whole platform is built from scratch — no ESPN/Yahoo/Sleeper league integration.

> Status: planning. Items marked **(proposed)** are defaults suggested during planning, not final decisions.

---

## 1. Goals & constraints

- **Build everything:** draft, roster management, waivers, trades, scoring, league logic, playoffs, group chat, agent difficulty and customization.
- **Free data only.** No paid sports data feeds.
- **LLM-first APIs.** Every capability is usable by an LLM. Agents and the human UI use the **same API** — no agent-only backdoor, no agent advantages the human lacks.
- **Built on `readysetcloud/rsc-core`.** Use the RSC design system (`@readysetcloud/ui`) and the agent runtime/model config (`@readysetcloud/agent`). Follow existing rsc-core paradigms and conventions (see its AGENTS.md).
- **Inference:** AWS Bedrock (AWS Hero credits, ~$3k, no model restrictions). Cost is not the primary constraint; agent quality is.
- **Fairness:** agents act on an event-gated cadence, not continuous loops, so they can't out-react a human in unrealistic ways.

## 2. Why we own the league engine

Existing platforms are not viable for agent players:
- Sleeper's public API is **read-only** (no trades, waivers, lineups).
- ESPN has no official API; unofficial endpoints are cookie-based and brittle.
- Yahoo has OAuth writes but is clunky, and 7 bot accounts on any platform likely violates ToS.

**Decision:** read player/stat data from outside; own all league state and actions ourselves.

## 3. Data sources (all free)

| Need | Source | Notes |
|---|---|---|
| Player universe, injuries, depth charts | Sleeper `GET /v1/players/nfl` | Large payload — sync 1–2×/day |
| Weekly/live stat lines | Sleeper (undocumented) `GET /v1/stats/nfl/regular/{season}/{week}` | Raw stats incl. snaps, IDP; also precomputed `pts_ppr`/`pts_half_ppr`/`pts_std` for validation |
| Projections | Sleeper (undocumented) `GET /v1/projections/nfl/regular/{season}/{week}` | Agent research input |
| Trending adds/drops | Sleeper `GET /v1/players/nfl/trending/{add\|drop}` | Waiver signal |
| NFL state (season/week) | Sleeper `GET /v1/state/nfl` | Drives week rollover |
| Corrected stats, history, PBP | nflverse (nflreadr/nflreadpy release files) | Nightly updates; stat corrections finalized Mon–Wed → **Thursday data is cleanest** |
| Player ID cross-reference | nflverse ID mapping tables | Needed to join Sleeper ↔ nflverse IDs |
| News for agent research | Free RSS feeds (team sites, major outlets) | Replaces paid search APIs |
| Backup stats feed | MySportsFeeds (free for personal/non-commercial) | Only if Sleeper endpoints change |

**Risks:** Sleeper stats/projections endpoints are undocumented and may change. Stay well under Sleeper's ~1,000 calls/min guidance.

## 4. Scoring

- Scoring engine = league `scoringSettings` (stat key → points) applied to each player's stat line. Custom rules supported; validate against Sleeper's precomputed PPR/half/standard totals.
- **Live:** poll Sleeper stats every 1–2 min during game windows only (EventBridge schedule), recompute matchups, push updates via Momento Topics.
- **Provisional final:** lock after Monday night's last game.
- **Official final:** Thursday job re-pulls the week, reconciles with nflverse, applies stat corrections, and posts a "stat correction" message to the group chat.

## 5. Architecture (rsc-core consumer app)

Follows the same pattern as other rsc-core consumers (newsletter-service, Booked).

- **Infra:** AWS SAM stack, config via SSM (rsc-core pattern), shared Cognito pool for identity, shared EventBridge bus.
- **League state:** DynamoDB (league-owned table **(proposed)** — see open questions).
- **Workflows:** the weekly cycle (waivers → trade window → lineup lock → scoring → finalization) is clock-driven, idempotent jobs on EventBridge Scheduler plus rsc-core deferred events, not Step Functions (`docs/adr/002-weekly-cycle.md`).
- **Scheduling:** EventBridge Scheduler for the recurring jobs (waiver processing, live scoring, the weekly rollover, the Thursday correction job); the rsc-core deferred-event scheduler for one-off timed events (draft pick clock, trade offer expiry, lineup lock warnings).
- **Realtime:** Momento Topics for group chat, live scores, and trade/transaction notifications.
- **Frontend:** Vite React SPA on S3 + CloudFront + `@readysetcloud/ui` (draft board, rosters, matchups, trades, chat surface).
- **Agents:** `@readysetcloud/agent` (Strands-TS on Bedrock AgentCore Runtime).
  - Each agent = a **session config stored as data** (persona, model, tools, difficulty, strategy) — tune without redeploying.
  - Autonomous decisions (waivers, trade evaluation, lineup setting) run as **in-Lambda agent tasks** using the existing idempotent, completion-event pattern.
  - Chat and live negotiation go through the AgentCore WebSocket runtime.
  - **Memory:** conversation snapshots for chat context; AgentCore Memory for long-term league history per agent (rivalries, past trades, who fleeced whom).
- **Security:** agents are allowlisted system principals; identity from verified JWT only; league MCP server registered under the rsc-core MCP host allowlist.
- **Gamification:** league achievements via the rsc-core badge chest (e.g., trade won, championship).

## 6. LLM-friendly API design

One API for UI + agents. Exposed as REST with a thorough OpenAPI spec **and** an MCP server wrapping the same operations (so external agents could "bring their own agent" to a league later).

Principles:
1. **Task-shaped operations**, not raw CRUD: `propose_trade`, `respond_to_trade`, `claim_waiver`, `set_lineup`, `get_matchup_outlook`, `make_draft_pick`, `post_message`.
2. **Errors explain the fix:** e.g. "Waivers locked until Wed 3:00 AM CT — claim queued" or "Roster full: include `drop_player_id`."
3. **Name resolution:** accept player names or IDs; always return both.
4. **Preview / dry-run:** `preview_trade`, `preview_waiver_claim` return roster and lineup impact before committing.
5. **Compact, curated responses** with an optional `detail` flag.
6. **Idempotency keys** on every mutation.
7. **Phase awareness:** every response includes league phase (draft, pre-lock, waivers open, trade deadline passed, playoffs) and what actions are currently allowed.
8. OpenAPI/MCP descriptions written for models, not just humans.

### Draft tool surface (initial)
- Read: `get_league_state`, `get_roster`, `get_standings`, `get_matchup`, `get_matchup_outlook`, `search_players`, `get_player`, `get_projections`, `get_trending_players`, `get_news`, `get_transactions`, `get_chat`
- Draft: `get_draft_board`, `make_draft_pick`
- Roster: `set_lineup`, `drop_player`, `claim_waiver`, `cancel_waiver_claim`, `preview_waiver_claim`
- Trades: `preview_trade`, `propose_trade`, `counter_trade`, `respond_to_trade`, `withdraw_trade`
- Chat: `post_message`

## 7. Trades

- Trades are **structured objects** with a state machine: `proposed → countered* → accepted | rejected | expired | withdrawn → processed | vetoed`.
- Chat is for negotiation/banter only; nothing agreed in chat executes without a structured proposal.
- Multi-round negotiation supported (counters).
- Server-side validation: roster limits, trade deadline, player lock status.
- **(proposed)** Offers expire after a set window via the deferred scheduler.

## 8. Agents

### Event-gated cadence
Agents act only on triggers: draft turn, waiver window open, trade offer received, injury/news alert on a rostered player, pre-lock lineup check, weekly recap/chat moments.

### Customization & difficulty
- **Strategy archetypes (proposed):** zero-RB, contrarian, win-now, analytics-only, gut-feel homer, trade-happy, waiver hawk.
- **Difficulty levers:** information access (projections, news, trending), reasoning depth, action frequency, negotiation rounds.
- **Personality:** voice for chat and trash talk, persisted league memory.
- **Model choice per agent:** mix Bedrock model families so agents value players differently (and "which model wins the league?" becomes content).

### Hybrid decisioning
- Deterministic code: player valuations, lineup optimization from projections, trade value math.
- LLM: judgment calls, negotiation, strategy, and chat.
- Stronger models for negotiation/trade evaluation/strategy; cheaper models for chat and news summarization.
- Guardrails: server validation prevents illegal or obviously broken moves (e.g., starting a player on bye/OUT is flagged).

## 9. Phases

1. **League core** — data model, Sleeper player sync, league settings, scoring engine. Validate by scoring past weeks against Sleeper totals.
2. **Draft** — snake draft; agents pick via tools, human picks in UI. Milestone: full mock draft vs 7 agents.
3. **Season loop** — lineups, matchups, live scoring, standings, FAAB waivers. Milestone: replay the 2025 season end to end.
4. **Trades & chat** — trade state machine, negotiation, group chat on Momento Topics.
5. **Agent customization** — archetypes, difficulty, personalities, per-agent models.
6. **Playoffs & polish** — bracket, trade deadline, league history, stat-correction reconciliation.

### Season replay simulator (build early)
Replay a completed season (2025) week by week from nflverse/Sleeper historical data to test agents and league logic in hours instead of waiting on real Sundays. Also a strong demo.

## 10. Decisions (resolved 2026-09-27)

These replace the open questions. `docs/ARCHITECTURE.md` turns them into concrete technical choices.

- **Rules follow Yahoo defaults, and the commissioner can change them.** Every league setting (scoring, roster slots, waivers, trades, playoffs) starts at the Yahoo public-league standard, and the commissioner can edit it before the draft. After the draft, only the settings that are safe to change mid-season can be edited. Defaults:
  - **Team count:** 8 by default, 4 to 12 allowed.
  - **Scoring:** Yahoo standard half-PPR.
  - **Roster:** QB, 3 WR, 2 RB, TE, W/R/T flex, K, DEF, 6 bench, 1 IR.
  - **Waivers:** FAAB with a $100 budget. Yahoo-style rolling priority is a commissioner option. Waiver periods are 2 days, and the first $0 bid wins a tie on priority.
  - **Trades:**
    - **Review:** a 2-day review period, and the league votes. Agents vote through a tool, and a trade is vetoed if enough teams vote against it (Yahoo threshold). The commissioner can switch review to none or commissioner-only.
    - **Lopsided-trade guard:** a guard built on the trade value math blocks obviously lopsided agent-to-agent trades.
    - **Deadline:** the Yahoo default is the week 11 kickoff.
    - **Offer expiry:** 48 hours or at the next lineup lock, whichever comes first.
  - **Playoffs:** 6 teams (4 in leagues with 6 or fewer teams) in weeks 15–17, with byes for the top 2 seeds. Ties are broken by points for.
  - **Lineup lock:** each player locks at his game's kickoff.
- **Humans:** a league can have any number of human seats, from 1 up to the team count. The commissioner (the league creator) invites others by link or email, and people sign in with their Ready, Set, Cloud account (the shared Cognito pool). Every seat not filled by a human is played by an agent.
- **Agents are ours only.** There is no bring-your-own-agent support. The MCP server (§6, `docs/mcp.md`) only lets a person's own assistant act as that person on their own team; it never takes a seat.
- **Easy agent setup:** each agent seat is a card with a personality preset, a difficulty level, and a strategy archetype, plus "Randomize". An Advanced drawer exposes the model and the individual difficulty levers. The catalogs live in `packages/core/src/agents/` and are data, so tuning never needs a redeploy.
  - **Difficulty tiers:** Rookie, Amateur, Pro, All-Pro, Hall of Famer. Each tier sets the model (Amazon Nova, Moonshot Kimi, or Anthropic Claude on Bedrock), research access, reasoning effort, how often the agent acts, and how many negotiation rounds it gets.
  - **Personality presets:** 16 or more, each with its own voice and trash-talk style.
- **Mid-season start:** a league can start in any week before the trade deadline. It drafts immediately, plays the remaining regular-season weeks, and the schedule is generated for those weeks.
- **Data layout:** league data lives in its own DynamoDB table. The rsc-core core table is used only for what rsc-core already owns: badges, and agent sessions and tasks through `@readysetcloud/agent`.
- **Hosting:** the app is at `fantasy.readysetcloud.io`: a Vite React SPA on S3 + CloudFront, with the API on the same origin (`/api/v1/*`). It follows the `allenheltondev/llm-eval-harness` pattern: PRs deploy to Staging, merges to `main` deploy to Production, and both use GitHub OIDC with the `AWS_DEPLOY_ROLE_ARN` environment secret. The API is a TypeScript Lambda.
- **Agent chat:** agents join group chat through event-triggered tasks (mentions, chat moments), not through a long-lived WebSocket. League memory is stored per agent in the league table and injected into prompts.
