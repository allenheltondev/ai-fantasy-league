# ADR 010: Realtime on AWS AppSync Events instead of Momento Topics

Status: accepted (#151), implemented (#281). Momento is gone from the code, the template, and the dependencies.

- **Code:** `packages/server/src/realtime/` (`realtime.ts` holds the `Realtime` interface, the channel names, and `seatTenureKey`; `appsync.ts` the SigV4 publisher; `relay.ts` the publisher's routing; `authorizer.ts` the subscribe check; `config.ts` the switch), `packages/server/src/operations/chat/get-realtime-config.ts`, `app/src/realtime/appsyncEvents.ts` (the WebSocket client), `app/src/chat/realtime.ts`, `app/src/realtime/leagueEvents.ts`, and `infra/template.yaml` (`RealtimeApi`, `RealtimeNamespace`, `RealtimeSubscribeFunction`, `RealtimePublisherFunction`).

## Context

Realtime (#68) pushes league updates to open browsers over Momento Topics: chat, the draft board, live scoring, NFL game state, notifications, and private team results. The API vends a disposable, subscribe-only Momento token for 30 minutes, scoped to the league topic, the caller's team topic, and the global topic. The relay Lambda publishes bus events to those topics.

Momento is the one runtime dependency outside AWS and rsc-core's Cognito pool. It brings its own API key (in the rsc-core secret), its own SDK in the browser bundle, and its own authorization model, and that model has gaps the app now has to work around:

- **No revocation.** A disposable token cannot be revoked. Someone who leaves a seat keeps receiving that team's private topic until the token expires, up to 30 minutes (#151, "Realtime token after leaving a seat"). The workarounds are shorter tokens (more re-fetching) or rotating topic names on every seat change (every publisher and subscriber has to agree on the epoch).
- **No publish scope we want to hand out.** Live lobby presence (#134) polls every 15 seconds because pushing presence would need a token that can publish.
- **Two identity systems.** Who may hear a topic is decided once, when the token is vended, from a Cognito identity, and then lives on in a credential we don't control.

We do not want Momento in this app.

## Decision

Replace Momento Topics with **AWS AppSync Events** (managed WebSocket pub/sub), defined in `infra/template.yaml` next to the rest of the stack.

- **Channels mirror the old topics.** One channel namespace for the app, `fantasy`. Channels are `/fantasy/league/<leagueId>`, `/fantasy/team/<leagueId>/<teamId>/<tenureKey>`, and `/fantasy/global`, with the same JSON items (`{ type: 'chat', ... }` and `{ type: 'event', ... }`), so `relay.ts`'s routing rules (what goes to the league and what only to a team) stay as they are.
- **Browsers subscribe with their Cognito ID token.** No vended credential. The Event API accepts only ID tokens from this stack's app client on the shared pool, and the namespace's OnSubscribe handler, a direct Lambda integration (`RealtimeSubscribeFunction`), authorizes every subscribe against current league state: any signed-in person for `/fantasy/global`, a league member (a seat holder or the commissioner) for `/fantasy/league/...`, and the team's current owner, with the current tenure key, for `/fantasy/team/...`. Wildcard subscribes are refused. When the seat changes, the next subscribe or reconnect is refused.
- **Team channels rotate with the seat.** This ADR first said the subscribe check alone would close the seat-change gap, with no rotation. It does not: AppSync Events has no way to close a subscription that is already open, and a browser can keep one socket open for hours. So the team channel's last segment is the seat's tenure key (`seatTenureKey`, a short hash of the league, the team, `ownerUserId`, and `occupiedSince`, which every seat change moves). The relay reads the team as it publishes, so after a seat change its messages go to a channel the old occupant never subscribed to, and the subscribe check refuses them that channel. The "epoch every publisher and subscriber has to agree on" that made rotation unattractive on Momento costs little here: there is one publisher, it reads the team anyway, and subscribers get their channel from `get_realtime_config` and ask again before its `refreshAt`. The one cost is a GetItem per team delivery.
- **Only the server publishes.** The relay Lambda publishes with IAM (`appsync:EventPublish`), so there is no API key to store. Browser publish stays off. Presence (#134) can later use a channel whose publish handler checks the caller's seat, still without handing out a credential.
- **The `Realtime` interface stays.** `AppSyncEventsRealtime` replaces `MomentoRealtime`; the interface's token call became `endpoint()`. `InMemoryRealtime` and the polling fallback (`enabled: false`) stay, so local dev, tests, CI, and e2e still need no realtime service. `get_realtime_token` became `get_realtime_config` (the Event API's HTTP and WebSocket domains, the caller's channels, and `refreshAt`; no token), on the same path.

## Consequences

- One identity system: Cognito decides who hears what, at subscribe time, against current league state.
- Someone who leaves a seat stops receiving that team's channel at once: the relay moves on to the new tenure's channel, and their next subscribe or reconnect is refused. There is no 30-minute window.
- The Momento key, `MomentoCacheParameterName`, the `@gomomento/sdk` and `@gomomento/sdk-web` dependencies, and the SSM and secret permissions are gone (with the `@aws-sdk/client-secrets-manager` dependency, which only realtime used).
- AppSync Events is billed per connection-minute and per message (in and out). At this app's scale it is comparable to Momento; the global `Scores Updated` fan-out on Sundays is the largest line and should be checked after the switch.
- The app's subscribe code changed: AppSync Events speaks its own WebSocket subprotocol. The app uses a small client written to the documented protocol (`app/src/realtime/appsyncEvents.ts`) rather than the Amplify bundle, loaded only when realtime is on.
- Every subscribe runs a Lambda that reads the table (the league and its teams, or one team). Subscribes happen when a page opens and every 30 minutes after, so this is small next to the API's own reads.
- The relay publishes with a SigV4-signed HTTP `POST /event` (`@smithy/signature-v4`, already in the AWS SDK's dependency tree), not a WebSocket.

## Alternatives considered

- **Keep Momento and rotate topic names on seat change.** This closes the gap but keeps the dependency we want out. (Rotation turned out to be needed on AppSync Events too, see above; it is the dependency, not the rotation, that this rules out.)
- **Subscribe check only, no rotation, with a short connection lifetime.** AppSync Events cannot close an open subscription, and the browser decides when to reconnect, so a person who left could keep hearing the team until they closed the tab.
- **API Gateway WebSocket API.** All AWS, but we would own the connection table, the fan-out, and stale-connection cleanup, which AppSync Events manages.
- **Polling only.** Simplest, and it already exists as the fallback, but the live draft, chat, and Sunday scoring would feel slower.
