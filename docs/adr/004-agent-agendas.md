# ADR 004: Persistent roster agendas

Status: accepted, first slice of #214. The broader player-behavior roadmap is #219.

## Problem and decision

Event-triggered managers can repeatedly rediscover the same roster problem without retaining an explicit objective. Natural-language memory is lossy and does not provide a reliable completion condition. Keep a small, typed operational agenda beside memory, reconciled from authorized game state before roster decisions and after successful actions.

The first objective is `repair_position`: acquire enough available players to cover an unfillable starting slot this week. For example, an injured RB with no healthy cover creates a stable goal across check-ins, waiver scans, and trade decisions. Submitting a waiver claim or trade offer leaves that goal active. A subsequent roster observation that can cover the slot completes it. A model's summary cannot change goal state.

## State and lifecycle

- Core owns the schema, pure reconciliation, prompt projection, and candidate-priority helper in `packages/core/src/agents/agenda.ts`.
- Repositories store one schema-versioned row per league, agent, and seat tenure: `pk=LEAGUE#<leagueId>`, `sk=AGENTAGENDA#<agentId>#<occupiedSince-or-createdAt>`. A new occupant starts empty. No migration or secondary index is required; missing rows read as an empty agenda.
- Each row holds at most three active goals and twelve historical goals. Goals record a stable ID, slot, missing count, week, timestamps, source task, reason, and explicit `owner_decisions` audience.
- Still-relevant priorities retain their order; newly discovered needs are ordered by the archetype's position weights. No new random choice occurs on each check-in.
- Verified cover completes a goal; week rollover expires it; league completion cancels active goals and closes the agenda. Completion reconciliation happens on the next applicable task, not a new scheduled job. A need that recurs in the same week reopens the same goal ID.
- DynamoDB uses consistent reads, a revision condition, and up to three compare-and-swap attempts. Reconciliation rejects older observation times and regressing weeks. A closed agenda cannot reopen. Timestamps are observation-start times, not an atomic game-state revision; equal-time snapshots and changes outside the team version are a remaining concurrency limitation. Subsequent tasks reconcile again.

## Runtime and behavior

`packages/agents/src/agenda.ts` reads the manager's own roster through its existing principal and tool registry. It rejects a changing team version/tenure and mismatched week. Byes and IR do not provide cover. Locked starters consume their actual slots, and locked bench players cannot fill an open slot. Healthy bench depth can satisfy a need without requiring an acquisition.

The runner supplies active priorities to check-in, lineup, waiver, trade proposal/response, and post-draft decision tasks. Waiver scouting considers priorities before reserving drops and applying its action cap; trade scouting considers them before narrowing candidates. Existing legality checks, valuation floors, FAAB calculations, permissions, and action limits still apply. Priority is a preference, not permission to overpay or execute an invalid move.

Agenda refresh adds repository reads and one authorized roster read before task preparation, plus another after an action. It adds no model call or scheduled task. The existing check-in probes still decide whether to invoke a model. Failure to read/validate/store agenda state logs a warning and leaves the ordinary task available; stale saved priorities are not injected after such a failure.

## Privacy and boundaries

Agenda rows are not part of natural-language memory, public APIs, chat prompts, or activity responses. This first slice stores only roster shortages; it does not persist sealed bids, negotiation limits, promises, or opponent assessments. A decision model can still describe its roster need in its ordinary summary: this boundary is not a general remedy for memory disclosure (#206).

This is groundwork, not all of #214. Deferred work includes other goal kinds (FAAB conservation, preferred partners, standings-driven plans), explicit blocked/waiting states, pending-action links, cooldowns, success metrics, and owner-facing inspection. Commitments and follow-through (#215) should build on typed goal IDs after task recovery (#207) and memory visibility (#206) are addressed. Attachments (#216), adaptation (#217), and reciprocal chat (#218) remain separate features. No public promise or autonomous outreach is added here.

## Validation

Core tests cover stable identity, completion/reopening, stale observation rejection, weekly expiration, terminal closure, bounded history, and candidate eligibility. Both repository backends test persistence, isolation, and competing observations. Runtime tests exercise repeated check-ins, authoritative recovery, real pickups with and without a model, untrusted model claims, chat isolation, unavailable reads, seat replacement, and league completion. Existing decision and simulation suites continue to validate action behavior.
