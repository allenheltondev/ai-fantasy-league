# ADR 010: Realtime on AWS AppSync Events instead of Momento Topics

Status: accepted (#151). The migration is its own issue (#281); until it ships, Momento stays in place unchanged.

- **Code today:** `packages/server/src/realtime/` (`realtime.ts` holds the `Realtime` interface and the topic names, `momento.ts` the implementation, `relay.ts` the publisher, `config.ts` the switch), `packages/server/src/operations/chat/get-realtime-token.ts`, `app/src/chat/realtime.ts`, `app/src/realtime/leagueEvents.ts`, and `infra/template.yaml` (`MomentoCacheParameterName`, `RealtimePublisherFunction`).

## Context

Realtime (#68) pushes league updates to open browsers over Momento Topics: chat, the draft board, live scoring, NFL game state, notifications, and private team results. The API vends a disposable, subscribe-only Momento token for 30 minutes, scoped to the league topic, the caller's team topic, and the global topic. The relay Lambda publishes bus events to those topics.

Momento is the one runtime dependency outside AWS and rsc-core's Cognito pool. It brings its own API key (in the rsc-core secret), its own SDK in the browser bundle, and its own authorization model, and that model has gaps the app now has to work around:

- **No revocation.** A disposable token cannot be revoked. Someone who leaves a seat keeps receiving that team's private topic until the token expires, up to 30 minutes (#151, "Realtime token after leaving a seat"). The workarounds are shorter tokens (more re-fetching) or rotating topic names on every seat change (every publisher and subscriber has to agree on the epoch).
- **No publish scope we want to hand out.** Live lobby presence (#134) polls every 15 seconds because pushing presence would need a token that can publish.
- **Two identity systems.** Who may hear a topic is decided once, when the token is vended, from a Cognito identity, and then lives on in a credential we don't control.

We do not want Momento in this app.

## Decision

Replace Momento Topics with **AWS AppSync Events** (managed WebSocket pub/sub), defined in `infra/template.yaml` next to the rest of the stack.

- **Channels mirror today's topics.** One channel namespace for the app. Channels are `/league/<leagueId>`, `/team/<leagueId>/<teamId>`, and `/global`, with the same JSON items (`{ type: 'chat', ... }` and `{ type: 'event', ... }`), so `relay.ts`'s routing rules (what goes to the league and what only to a team) stay as they are.
- **Browsers subscribe with their Cognito ID token.** No vended credential. A subscribe is authorized on every connection by an `onSubscribe` handler (or a Lambda authorizer) that checks the caller's current membership: a league member for `/league/...`, the team's current owner for `/team/...`. When the seat changes, the next subscribe is refused. An open subscription is closed when its connection drops, or by the subscribe check running again on reconnect. Together with a short connection lifetime, this closes the seat-change gap without rotating channel names.
- **Only the server publishes.** The relay Lambda publishes with IAM (`appsync:EventPublish`), so there is no API key to store. Browser publish stays off. Presence (#134) can later use a channel whose publish handler checks the caller's seat, still without handing out a credential.
- **The `Realtime` interface stays.** `AppSyncEventsRealtime` replaces `MomentoRealtime`. `InMemoryRealtime` and the polling fallback (`enabled: false`) stay, so local dev, tests, CI, and e2e still need no realtime service. `get_realtime_token` becomes `get_realtime_config` (endpoint and channel names, no token), or keeps its name with `token: null`, whichever keeps the app change smaller.

## Consequences

- One identity system: Cognito decides who hears what, at subscribe time, against current league state.
- The Momento key, `MomentoCacheParameterName`, the `@gomomento/sdk` and `@gomomento/sdk-web` dependencies, and the SSM and secret permissions go away.
- AppSync Events is billed per connection-minute and per message (in and out). At this app's scale it is comparable to Momento; the global `Scores Updated` fan-out on Sundays is the largest line and should be checked after the switch.
- The app's subscribe code changes: AppSync Events speaks its own WebSocket subprotocol. Use Amplify's `events` client, or a small client written to the documented protocol if the Amplify bundle is too heavy.
- Until the migration ships, the #151 seat-change token gap stays open. It is not fixed in Momento, because that work would be thrown away.

## Alternatives considered

- **Keep Momento and rotate topic names on seat change.** This closes the gap but keeps the dependency we want out, and adds a seat epoch that every publisher and subscriber has to agree on.
- **API Gateway WebSocket API.** All AWS, but we would own the connection table, the fan-out, and stale-connection cleanup, which AppSync Events manages.
- **Polling only.** Simplest, and it already exists as the fallback, but the live draft, chat, and Sunday scoring would feel slower.
