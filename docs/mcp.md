# The league MCP server

The API serves an [MCP](https://modelcontextprotocol.io) server at `/api/v1/mcp`. With it, your own AI assistant (Claude Desktop, a claude.ai custom connector, or any MCP client) can read your leagues and manage **your own team**: set lineups, claim waivers, post in chat, and so on.

## What it is, and what it is not

SPEC §10 rules out bring-your-own-agent: the AI managers in a league are ours, configured from the agent catalogs. This server doesn't change that. It never takes a seat and it never acts as an agent. It is a remote control for a person, like the web app:

- Every call runs as **the signed-in person**, with the Cognito ID token the web app uses. It has exactly that person's powers, and no more.
- It works through the same operation registry as REST. `tools/list` is generated from the registry, and each tool call goes through `executeOperation` with the same authorization, validation, phase checks, idempotency, and audit log. Nothing can drift, and no operation exists only here.
- A league's AI seats keep running on their own triggers. An assistant can't drive an agent seat, because `requireTeamOwner` lets a person change only their own team.

## Transport

- **Streamable HTTP**, stateless, JSON responses, via the official `@modelcontextprotocol/sdk` (`WebStandardStreamableHTTPServerTransport` inside the Hono app, `packages/server/src/mcp/server.ts`).
- Only `POST` is accepted. There are no sessions and no server-sent event stream: `GET` and `DELETE` return 405.
- Every request needs `Authorization: Bearer <Cognito ID token>`. A missing or invalid token gets 401 with `WWW-Authenticate: Bearer`.

## Tools

Every registry operation is a tool with the same snake_case name, and its description is written for a model. Two are left out: `get_realtime_token` (the browser's live-update subscription) and `get_health`, along with public operations that don't need sign-in.

- **Results.** A tool result is the REST envelope: `{ data, league, warnings }`, or `{ error: { code, message, fix } }` with `isError: true`. It is sent both as `structuredContent` and as JSON text. `league.allowedActions` says what you can do right now.
- **Mutations.** A tool that changes anything requires an `idempotencyKey` argument, a new UUID for each action. Retrying with the same key returns the original result instead of acting twice. The keys share their scope with REST's `Idempotency-Key` for the same person.
- **Reads.** Reads are compact. Pass `detail: true` for full records. Players always appear as `{ id, name, team, position }`, and anything that takes a player accepts `playerId` or a `player` name.
- **Where to start.** Begin with `list_my_leagues` and `get_league_state`. `get_matchup_outlook` answers "how does my week look?".

## Connecting

The server URL is `https://fantasy.readysetcloud.io/api/v1/mcp` (Staging uses its CloudFront domain, and local dev uses `http://127.0.0.1:3001/api/v1/mcp`).

**Getting a token.** Sign in to the web app. The app keeps its Cognito session in browser storage; copy the ID token from there (browser dev tools → Application → Storage). ID tokens expire after an hour, so refresh the page and copy it again when calls start returning 401. In local dev (`npm run dev`, which sets `FANTASY_LOCAL_AUTH=1`), use `dev` or `dev:<handle>` as the token.

**Claude Desktop.** Claude Desktop connects to remote servers through the `mcp-remote` bridge, which can send a header. In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "fantasy-league": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://fantasy.readysetcloud.io/api/v1/mcp",
        "--header",
        "Authorization:Bearer ${FANTASY_ID_TOKEN}"
      ],
      "env": { "FANTASY_ID_TOKEN": "<your ID token>" }
    }
  }
}
```

**claude.ai custom connector.** Add a custom connector (Settings → Connectors) with the server URL. claude.ai connectors authenticate with OAuth, and this server accepts only a bearer token today. So a claude.ai connector works once the OAuth flow (authorization-server metadata that points at the Cognito hosted UI) is added. That is a follow-up. Until then, use Claude Desktop or another client that can send a header.

**Any MCP client.** Point a Streamable HTTP client at the URL and send the `Authorization` header on every request. `packages/server/test/integration/mcp-server.test.ts` shows it with the SDK's `StreamableHTTPClientTransport`.

**The rsc-core MCP host allowlist.** None of the clients above needs it, and neither do our own agents (below). rsc-core's `MCP_ALLOWED_HOSTS` (its `McpAllowedHosts` stack parameter) is an SSRF guard for rsc-core's own chat and task runtime: `create-session` rejects a session whose `mcpServers` point at a host not on the list, and an empty list rejects them all. So it matters only if an rsc-core agent session is meant to use this server as a tool. In that case, add the league host (`fantasy.readysetcloud.io`, or Staging's CloudFront domain) to `McpAllowedHosts` when deploying rsc-core, and have the session forward the person's Cognito ID token (the spec's `authHeader`, or `forwardConnectionToken`), since this server accepts only that person's bearer token. Nothing in this repository creates such a session today.

## Our own agents

Our agents use the same tool definitions (`toMcpTool` in `packages/server/src/mcp/tools.ts`), bound in process by `packages/agents/src/tools.ts` with their own agent principal. They don't go over HTTP, because agent principals are never accepted from a request.
