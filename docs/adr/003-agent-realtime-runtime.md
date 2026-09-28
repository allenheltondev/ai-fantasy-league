# ADR 003: Agents join chat and negotiation through event-triggered Lambda tasks, not an AgentCore WebSocket runtime

- **Status:** Accepted
- **Issues:** #43 (closed by this ADR), #44, #72
- **Code:** `packages/agents/src/router.ts` (triggers and chat cooldowns), `packages/agents/src/runner.ts` (task runs), `packages/agents/src/tasks/chat.ts` (`chat_reply`, `chat_moment`), `packages/agents/src/memory.ts` (league memory and the chat snapshot), `packages/server/src/realtime/` (Momento Topics).

## Context

Issue #43 proposed running agents in the Bedrock AgentCore WebSocket runtime so they could join the group chat and live trade negotiations as long-lived sessions, with a bridge between Momento Topics chat and those sessions. Its acceptance criteria also require that:

- agents still speak only when mentioned or at a chat moment, not on every message;
- a negotiation in chat can lead to a structured `propose_trade` or `counter_trade` call, but chat never executes anything by itself.

What exists today:

- **Chat and realtime:** messages are stored by `post_message` and relayed to the league topic on Momento (`fantasy.league.<leagueId>`). Browsers subscribe with short-lived tokens.
- **Agent chat:** `Chat Mention` and `Chat Moment` events route to the `chat_reply` and `chat_moment` task kinds. They run in the agent task Lambda with no tools: the runtime posts the message for them. Per-agent and per-league cooldowns and daily message budgets apply.
- **Structured moves:** trades, waivers, lineups, and draft picks run as their own task kinds on their own triggers (`Trade Proposed` / `Trade Countered` for trade responses), with tool binding, action budgets, the kill switch, and the league's weekly spend ceiling.
- **Memory:** each agent keeps a private league memory in the table (#44), including a snapshot of the last chat it took part in, so replies have context across sessions without a live session.
- **`@readysetcloud/agent` 0.2.7** runs Strands in-process (`runAgent`, structured output, bounded tool loops). Its README says it "knows nothing about WebSockets, AgentCore, HTTP". The AgentCore runtime host and AgentCore Memory live in rsc-core's runtime artifact, not in this package.

## Decision

Keep agents on **event-triggered, in-Lambda tasks** for chat and negotiation. Do not build an AgentCore WebSocket runtime or a Momento-to-session bridge now. SPEC §10 already records this ("agents join group chat through event-triggered tasks, not through a long-lived WebSocket").

How the #43 criteria are met without it:

| Criterion | How |
|---|---|
| Agents join chat | `chat_reply` (mentions) and `chat_moment` (league moments) post through `post_message`; Momento relays the message to every open browser. |
| Event gating | The router triggers chat tasks only on `Chat Mention` (people's mentions, never agent-to-agent) and `Chat Moment`, with cooldowns and daily budgets. |
| Negotiation leads to structured moves only | Chat tasks have no tools and no `memoryNote`. Trade offers arrive as structured `Trade Proposed` / `Trade Countered` events and are answered by the `trade_response` task kind (built by the trades work stream), which is where `counter_trade` is called. Chat text never reaches a tool-using task as trusted context. |
| Context across sessions | The chat snapshot in the agent's league memory, shown only to chat tasks. |

## Why not now

- **Cost and budgets.** A live session per agent per league keeps model context warm and invites a reply to every message. The spend guard (#93) is per task and per league week; event-triggered tasks make every model call countable and stoppable (kill switch, ceiling, deterministic fallback).
- **The gating rule removes most of the benefit.** Agents are meant to speak only when mentioned or at a moment. That is a trigger, which EventBridge already delivers. A socket would be idle almost all the time.
- **Safety is simpler without a session.** Each task gets a fresh, fenced prompt with only the messages it needs, no tools for chat, and a separate tool-using path for trades. A long-lived session mixing chat and negotiation state would need that separation rebuilt inside the session.
- **No cheap library path.** `@readysetcloud/agent` has no WebSocket or AgentCore runtime support. Building the host, the bridge, deploy, and IAM here would be a new platform, and the simulator couldn't drive it with its clock.
- **Latency is acceptable.** A mention reaches the agent within seconds (EventBridge → router → task), and the reply appears live for everyone through Momento.

## When to revisit

- Product wants **live, multi-turn negotiation** between a person and an agent in one sitting: several exchanges a minute, where cold-starting a task per message is noticeably slow.
- `@readysetcloud/agent` (or rsc-core) ships an **AgentCore runtime host and Momento bridge** we can adopt with configuration rather than new infrastructure.
- **AgentCore Memory** becomes available through the same package. The memory store already sits behind `AgentMemoryStore` (`packages/agents/src/memory.ts`), so a managed backend only has to implement `load` and `remember`.

If we revisit, keep the invariants: the router's gating and budgets decide when an agent speaks, the spend guard applies per model call, and nothing agreed in chat executes without a structured, validated operation call.
