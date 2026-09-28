# ADR 002: The weekly cycle runs on EventBridge Scheduler and deferred events, not Step Functions

- **Status:** Accepted
- **Issues:** #52, #53, #54, #56, #85
- **Code:** `packages/server/src/season/` (`cycle.ts`, `scoring.ts`, `lineups.ts`), the `scoreLiveWeek` and `advanceSeason` jobs in `packages/server/src/jobs/season.ts`, and the pure rules in `packages/core/src/season/cycle.ts`.

## Context

SPEC §5 and the first version of `docs/ARCHITECTURE.md` planned Step Functions for the weekly cycle (waivers, trade window, lineup lock, scoring, finalization). Building the season loop showed what the cycle actually has to do each week:

- **Lock lineups per player.** Each player locks at his own game's kickoff, so there is no single lock moment to wait for. The lock is a rule checked at write time (`validateLineup` with the clock), not a workflow step.
- **Warn agents before each game window.** Thursday night, Sunday early, Sunday late, Sunday night, and Monday night each need a `Lineup Lock Approaching` event shortly before kickoff.
- **Score live during game windows,** every couple of minutes, and stop outside them.
- **Finalize the week** once the last Monday night game is over, and roll the league to the next week (or into the playoffs, or to `complete`).

All of these are keyed to kickoff times that the NFL can move (flexed games), and every league follows the same NFL clock. The simulator (`@fantasy/sim`) also has to run a whole season in minutes with its own clock.

## Decision

The cycle is **clock-driven, idempotent jobs** plus **deferred events**, with no Step Functions state machine:

| Piece | Mechanism | What it does |
|---|---|---|
| `scoreLiveWeek` | EventBridge Scheduler, `rate(2 minutes)` on the data jobs Lambda | Inside a game window (kickoff to +4.5h, the same window as `ingestStats`), recomputes each in-season league's matchups from the stored stats and emits `Scores Updated` when a score changed. Outside a window it returns after one query. |
| `advanceSeason` | EventBridge Scheduler, `rate(15 minutes)` | For each in-season league whose week is over (the last kickoff + 4.5h): final scores, a standings snapshot, `Week Provisionally Final`, then the rollover: lineups carried forward, playoff games when the playoffs start or advance, the league's week and phase updated, `Week Rolled Over`. |
| `Lineup Lock Approaching` | rsc-core deferred events (`ctx.events.scheduleAt`) | Scheduled at each rollover (and when a season starts) for every game window of the new week, one hour before the window's first kickoff. The names are stable per league, week, and window, so scheduling again moves the pending event instead of duplicating it. |
| Lineup locks | `validateLineup` at write time | `set_lineup` refuses to move a player whose game has kicked off (`PLAYER_LOCKED`). |

In-season leagues are found with one query: while a league is in `regular_season` or `playoffs`, its `META` item carries GSI2 `LEAGUES#IN_SEASON` / `<leagueId>` (a sparse index entry that drops off when the league completes).

**Everything reads `ctx.clock`** (or the job's clock). The simulator runs the cycle by calling `advanceLeague` / the jobs with its simulated clock; nothing waits on wall-clock time.

**Idempotency:** before the week is over `advanceLeague` does nothing. Every write it makes is a full put (matchups, standings, lineups, playoff games). The version-checked league update is the commit point: a concurrent run that loses the race emits nothing. Events are published after the commit, so a crash between the commit and the publish loses the events rather than duplicating them.

## Why not Step Functions

- **One workflow per league per week buys little.** The waits are "until kickoff X" for times that can change after the execution starts; a state machine would need to re-read the schedule and loop anyway, which is what the job does every 15 minutes.
- **The simulator cannot drive a state machine.** A replay runs 18 weeks in minutes against a simulated clock. Plain functions called with a clock can be; Wait states cannot.
- **Fewer moving parts to deploy and test.** The jobs reuse the data jobs Lambda, its IAM, and the in-memory and dynalite test setups. The template gains two schedules and no new resources.
- **Per-player locks are a rule, not a step,** so the workflow's "lineup lock" stage disappears.

Step Functions remains a good fit for long, multi-step work with retries per step and human-visible history. If waiver processing or the Thursday stat-correction job grows into that, it can adopt a state machine without changing this cycle.

## Consequences

- The waiver stream hooks its processing into the same cycle: `Week Rolled Over` (and its own deferred events) rather than a Step Functions stage.
- Up to 15 minutes pass between the end of the Monday night window and the rollover. That is fine for fantasy football and keeps the job cheap.
- A flexed game after the rollover keeps its old warning time until the next rollover reschedules; the lock itself is always checked against the stored schedule, so it is never wrong.
- Mid-season starts (#85) reuse the same pieces: `startLeagueSeason` sets the league's first scoring week (`firstScoringWeek`, the later of `schedule.startWeek` and the next unlocked week) and schedules that week's warnings.
