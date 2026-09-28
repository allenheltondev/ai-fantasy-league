/**
 * How long after kickoff a game counts as live: kickoff until 4.5 hours later, a little past the
 * data package's 4-hour default so overtime and late stat updates are still picked up. Live stats,
 * live scoring, and the week's end (provisional final) all use it. It lives here, with no runtime
 * imports, so the API (which starts the season from the draft) does not load `@fantasy/data`.
 */
export const STATS_GAME_DURATION_MS = 4.5 * 3_600_000;
