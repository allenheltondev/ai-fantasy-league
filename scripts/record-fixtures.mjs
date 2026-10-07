#!/usr/bin/env node
// Records REAL, trimmed Sleeper and nflverse responses into packages/data/fixtures/.
//
// Run it somewhere api.sleeper.app is reachable (CI, AWS, most laptops):
//
//   node scripts/record-fixtures.mjs                 # Sleeper + nflverse, season 2025, weeks 1-2
//   node scripts/record-fixtures.mjs --sleeper       # only Sleeper
//   node scripts/record-fixtures.mjs --nflverse      # only nflverse (works from the dev sandbox)
//   node scripts/record-fixtures.mjs --season 2025 --weeks 1,2 --out /tmp/fixtures
//   node scripts/record-fixtures.mjs --scoring --weeks 1,2     # scoring validation sets (below)
//   node scripts/record-fixtures.mjs --espn-summary 401772901  # only one ESPN game summary (#164)
//   node scripts/record-fixtures.mjs --espn-injuries           # only ESPN's injury report (#200)
//   node scripts/record-fixtures.mjs --espn-scoreboard 2026 4  # only one week of ESPN's scoreboard
//   node scripts/record-fixtures.mjs --sleeper-app-projections 2026 4  # both projection endpoints (#184)
//
// --sleeper-app-projections <season> <week> records one week's projections from both Sleeper
// endpoints, as returned, so their real shapes can be committed (#184):
//   fixtures/sleeper/projection-sources/v1_{season}_{week}.json   api.sleeper.app/v1/projections map
//   fixtures/sleeper/projection-sources/app_{season}_{week}.json  api.sleeper.com/projections rows
//   fixtures/sleeper/projection-sources/summary_{season}_{week}.json  status, counts, and keys of each
// Both are trimmed to the fixture players (the app's rows to theirs, or its first rows when none
// match); the summary counts the whole response. An HTTP error is recorded in the summary.
//
// --scoring records the scoring validation sets (#30) instead: every player's weekly stat line with
// the source's own fantasy points, trimmed to the scoring stat keys.
//   Sleeper:  fixtures/sleeper/scoring/stats_regular_{season}_{week}.json (pts_ppr/half/std)
//   nflverse: fixtures/nflverse/scoring_sample_{season}.csv (fantasy_points, fantasy_points_ppr)
// The data package's scoring harness test validates whatever sets are present; for a whole season,
// run `npm run validate-scoring -w @fantasy/data -- <files>` instead of committing it.
//
// Responses are trimmed to the fixture player set below so the files stay small (< 2 MB total).
// Synthetic players (ids starting with 900) in the existing players.json are preserved because
// the crosswalk tests rely on them. Runs without --scoring rewrite the curated fixtures that unit
// tests pin (state, stats, projections, trending), so the Record fixtures workflow runs them only
// when its `curated` input is on. After recording them, run `npm run test -w packages/data` and
// update any assertion that pinned a hand-authored value.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const SLEEPER = 'https://api.sleeper.app';
const SLEEPER_APP = 'https://api.sleeper.com';
const NFLVERSE = {
  idMap: 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv',
  weeklyStats: (season) =>
    `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`,
  schedules: 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv'
};

/** Sleeper ids of the fixture players (QB/RB/WR/TE/K/IDP starters, namesakes, and two defenses). */
const PLAYER_IDS = [
  '96',
  '1466',
  '4034',
  '4046',
  '4227',
  '4866',
  '4881',
  '4984',
  '6786',
  '6794',
  '6904',
  '6994',
  '7564',
  '7640',
  '9221',
  '9493',
  '9509',
  '11533',
  '11604',
  'KC',
  'PHI'
];
/** Extra id-map rows kept for the name-fallback crosswalk tests (gsis ids with no sleeper id). */
const EXTRA_GSIS = ['00-0041239', '00-0041399'];
/** Namesakes kept in the id map for ambiguity tests. */
const EXTRA_SLEEPER_IN_IDMAP = ['13524'];

const { values, positionals } = parseArgs({
  options: {
    season: { type: 'string', default: '2025' },
    weeks: { type: 'string', default: '1,2' },
    out: { type: 'string', default: 'packages/data/fixtures' },
    sleeper: { type: 'boolean', default: false },
    nflverse: { type: 'boolean', default: false },
    scoring: { type: 'boolean', default: false },
    'espn-summary': { type: 'string' },
    'espn-injuries': { type: 'boolean', default: false },
    'espn-scoreboard': { type: 'string' },
    'season-type': { type: 'string', default: 'regular' },
    'sleeper-app-projections': { type: 'string' }
  },
  allowPositionals: true
});
const season = Number(values.season);
const weeks = values.weeks.split(',').map(Number);
const out = resolve(values.out);
const doSleeper = values.sleeper || !values.nflverse;
const doNflverse = values.nflverse || !values.sleeper;

async function get(url, attempt = 0) {
  const res = await fetch(url, { headers: { accept: 'application/json, text/csv' } });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return get(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

const pick = (obj, ids) =>
  Object.fromEntries(ids.filter((id) => id in (obj ?? {})).map((id) => [id, obj[id]]));
const writeJson = (path, data) => writeFileSync(path, JSON.stringify(data, null, 1) + '\n');

async function recordSleeper() {
  const dir = join(out, 'sleeper');
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const files = {};

  const players = JSON.parse(await get(`${SLEEPER}/v1/players/nfl`));
  const trimmed = pick(players, PLAYER_IDS);
  const existing = join(dir, 'players.json');
  if (existsSync(existing)) {
    for (const [id, p] of Object.entries(JSON.parse(readFileSync(existing, 'utf8')))) {
      if (id.startsWith('900')) trimmed[id] = p;
    }
  }
  writeJson(existing, trimmed);
  files['players.json'] = { endpoint: '/v1/players/nfl', capturedAt: now };

  writeJson(join(dir, 'state.json'), JSON.parse(await get(`${SLEEPER}/v1/state/nfl`)));
  files['state.json'] = { endpoint: '/v1/state/nfl', capturedAt: now };

  for (const kind of ['stats', 'projections']) {
    for (const week of weeks) {
      const endpoint = `/v1/${kind}/nfl/regular/${season}/${week}`;
      const body = JSON.parse(await get(`${SLEEPER}${endpoint}`));
      const file = `${kind}_regular_${season}_${week}.json`;
      writeJson(join(dir, file), pick(body, PLAYER_IDS));
      // Stats are served once each game is final, so they carry only an informational recordedAt.
      // Projections are gated on capturedAt < kickoff; we stamp the real capture time (see note).
      files[file] =
        kind === 'stats' ? { endpoint, recordedAt: now, week } : { endpoint, capturedAt: now, week };
    }
  }

  for (const type of ['add', 'drop']) {
    const endpoint = `/v1/players/nfl/trending/${type}`;
    writeJson(join(dir, `trending_${type}.json`), JSON.parse(await get(`${SLEEPER}${endpoint}?limit=10`)));
    files[`trending_${type}.json`] = { endpoint, capturedAt: now };
  }

  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        source: 'recorded',
        note: `Recorded from api.sleeper.app by scripts/record-fixtures.mjs at ${now}. Ids 900xx are synthetic and preserved from the hand-authored set. Projections recorded after kickoff are hidden by the historical provider; edit capturedAt to a pre-kickoff time if you need them visible.`,
        season,
        files
      },
      null,
      2
    ) + '\n'
  );
  console.log(`sleeper: wrote ${Object.keys(files).length} files to ${dir}`);
}

function splitCsvLine(line) {
  const cells = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      cells.push(field);
      field = '';
    } else field += c;
  }
  cells.push(field);
  return cells;
}

async function recordNflverse() {
  const dir = join(out, 'nflverse');
  mkdirSync(dir, { recursive: true });

  const ids = (await get(NFLVERSE.idMap)).split('\n');
  const header = splitCsvLine(ids[0]);
  const gsisCol = header.indexOf('gsis_id');
  const sleeperCol = header.indexOf('sleeper_id');
  const wanted = new Set([...PLAYER_IDS, ...EXTRA_SLEEPER_IN_IDMAP]);
  const keptIds = [ids[0]];
  const gsis = new Set();
  for (const line of ids.slice(1)) {
    const c = splitCsvLine(line);
    if (wanted.has(c[sleeperCol]) || EXTRA_GSIS.includes(c[gsisCol])) {
      keptIds.push(line);
      gsis.add(c[gsisCol]);
    }
  }
  writeFileSync(join(dir, 'db_playerids.csv'), keptIds.join('\n') + '\n');

  const stats = (await get(NFLVERSE.weeklyStats(season))).split('\n');
  const sHeader = splitCsvLine(stats[0]);
  const [idCol, weekCol, typeCol] = ['player_id', 'week', 'season_type'].map((c) => sHeader.indexOf(c));
  const keptStats = [stats[0]];
  for (const line of stats.slice(1)) {
    if (!line) continue;
    const c = splitCsvLine(line);
    if (gsis.has(c[idCol]) && c[typeCol] === 'REG' && weeks.includes(Number(c[weekCol])))
      keptStats.push(line);
  }
  writeFileSync(join(dir, `stats_player_week_${season}.csv`), keptStats.join('\n') + '\n');

  const games = (await get(NFLVERSE.schedules)).split('\n');
  const keptGames = [games[0], ...games.filter((l) => l.startsWith(`${season}_`))];
  writeFileSync(join(dir, `games_${season}.csv`), keptGames.join('\n') + '\n');
  console.log(
    `nflverse: ${keptIds.length - 1} id rows, ${keptStats.length - 1} stat rows, ${keptGames.length - 1} games -> ${dir}`
  );
}

/**
 * Sleeper stat keys no scoring reads (lengths, rates, splits, ranks, snaps, team context). Every
 * other key is kept: a key that Sleeper's own totals weight must be in the set, or the harness
 * cannot reproduce them (an allow-list once dropped `ff`, `st_ff`, and `st_fum_rec`).
 */
const SCORING_NOISE =
  /(_lng|_ypa|_ypc|_ypr|_ypt|_rtg|_air_yd|_yar|_yac|_btkl|_drop|_pct|_snp)$|^(tm_|rank|pos_rank|gms_active$|gs$|rec_\d+_\d+$|rec_40p$|rush_40p$|pass_cmp_40p$|def_(kr|pr)(_|$)|def_forced_punts$|def_3_and_out$)|_rz_|_td_lng$|sack_yd$/;
/** Tiered stats, where 0 scores (a shutout) and must not be dropped with the other zeros. */
const ZERO_SCORES = new Set(['pts_allow', 'yds_allow']);

/** nflverse columns the harness reads (identity, fumble breakdown, published points, mapped stats). */
const NFLVERSE_SCORING_COLUMN =
  /^(player_id|player_display_name|position|season|week|season_type|team|opponent_team|completions|attempts|passing_|sacks_suffered|sack_fumbles|carries|rushing_|receptions|targets|receiving_|special_teams_tds|fumbles_lost_total|fg_made|fg_att|fg_missed|pat_|fantasy_points)/;
/** Advanced-metric and list columns no stat key reads. */
const NFLVERSE_NOISE =
  /_(epa|cpoe|list|distance|air_yards|yards_after_catch|first_downs|\d+)$|pacr|racr|wopr|share|pct$/;

async function recordScoringSleeper() {
  const dir = join(out, 'sleeper', 'scoring');
  mkdirSync(dir, { recursive: true });
  for (const week of weeks) {
    const body = JSON.parse(await get(`${SLEEPER}/v1/stats/nfl/regular/${season}/${week}`));
    const kept = {};
    for (const [id, stats] of Object.entries(body)) {
      if (typeof stats?.pts_ppr !== 'number' || !stats.gp) continue;
      kept[id] = Object.fromEntries(
        Object.entries(stats).filter(([k, v]) => !SCORING_NOISE.test(k) && (v !== 0 || ZERO_SCORES.has(k)))
      );
    }
    writeFileSync(join(dir, `stats_regular_${season}_${week}.json`), JSON.stringify(kept) + '\n');
    console.log(`sleeper scoring: week ${week}: ${Object.keys(kept).length} players`);
  }
}

async function recordScoringNflverse() {
  const dir = join(out, 'nflverse');
  mkdirSync(dir, { recursive: true });
  const rows = (await get(NFLVERSE.weeklyStats(season))).split('\n');
  const header = splitCsvLine(rows[0]);
  const cols = header
    .map((h, i) => [h, i])
    .filter(([h]) => NFLVERSE_SCORING_COLUMN.test(h) && !NFLVERSE_NOISE.test(h));
  const [weekCol, typeCol] = ['week', 'season_type'].map((c) => header.indexOf(c));
  const quote = (v) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const kept = [cols.map(([h]) => h).join(',')];
  for (const line of rows.slice(1)) {
    if (!line) continue;
    const c = splitCsvLine(line);
    if (c[typeCol] !== 'REG' || !weeks.includes(Number(c[weekCol]))) continue;
    kept.push(cols.map(([, i]) => quote(c[i] ?? '')).join(','));
  }
  writeFileSync(join(dir, `scoring_sample_${season}.csv`), kept.join('\n') + '\n');
  console.log(`nflverse scoring: ${kept.length - 1} rows, ${cols.length} columns -> ${dir}`);
}

/**
 * One game's ESPN summary, trimmed to the parts the scoring plays read (#164):
 * fixtures/espn/summary_<event id>.json. site.api.espn.com is public but not reachable from the dev
 * sandbox.
 */
async function recordEspnSummary(eventId) {
  if (!/^\d+$/.test(eventId)) throw new Error(`--espn-summary takes an ESPN event id, got ${eventId}`);
  const dir = join(out, 'espn');
  mkdirSync(dir, { recursive: true });
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${eventId}`;
  const body = JSON.parse(await get(url));
  const kept = { header: body.header, scoringPlays: body.scoringPlays ?? [] };
  writeJson(join(dir, `summary_${eventId}.json`), kept);
  console.log(`espn summary ${eventId}: ${kept.scoringPlays.length} scoring plays -> ${dir}`);
}

/**
 * ESPN's league-wide injury report (#200), as returned, to fixtures/espn/injuries.json (the
 * hand-authored stand-in is fixtures/espn/hand-authored/injuries.json). Record it on a game day,
 * about 90 minutes before a kickoff, to capture the inactives. The report is small (a few hundred
 * entries), so it is kept whole; the summary line counts entries and the status words ESPN used.
 */
async function recordEspnInjuries() {
  const dir = join(out, 'espn');
  mkdirSync(dir, { recursive: true });
  const body = JSON.parse(await get('https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries'));
  writeJson(join(dir, 'injuries.json'), body);
  const entries = (body.injuries ?? []).flatMap((team) => team.injuries ?? []);
  const statuses = [...new Set(entries.map((e) => e.status))].sort();
  const withId = entries.filter((e) => e.athlete?.id !== undefined).length;
  console.log(
    `espn injuries: ${(body.injuries ?? []).length} teams, ${entries.length} entries (${withId} with athlete.id), statuses: ${statuses.join(', ')} -> ${dir}`
  );
}

/** ESPN's `seasontype` ids, by the names our fixtures use. */
const ESPN_SEASON_TYPES = { regular: 2, post: 3 };

/**
 * One week of ESPN's scoreboard, as returned, to fixtures/espn/scoreboard_<type>_<season>_<week>.json
 * (the hand-authored stand-in is fixtures/espn/hand-authored/scoreboard_regular_2026_4.json). Only
 * the league's season calendar is dropped (every week of the year, which nothing reads). Record it
 * during a game window to capture live situations (possession, down and distance, red zone); the
 * summary line counts the games in each state. The data package's tests check every recorded week
 * parses and maps to our team codes.
 */
async function recordEspnScoreboard(season, week, seasonType) {
  const type = ESPN_SEASON_TYPES[seasonType];
  if (
    !Number.isInteger(season) ||
    season < 2000 ||
    !Number.isInteger(week) ||
    week < 1 ||
    week > 22 ||
    !type
  ) {
    throw new Error(
      '--espn-scoreboard takes a season and a week, e.g. --espn-scoreboard 2026 4 (--season-type regular or post)'
    );
  }
  const dir = join(out, 'espn');
  mkdirSync(dir, { recursive: true });
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=${type}&week=${week}`;
  const body = JSON.parse(await get(url));
  for (const league of body.leagues ?? []) delete league.calendar;
  const file = `scoreboard_${seasonType}_${season}_${week}.json`;
  writeJson(join(dir, file), body);
  const events = body.events ?? [];
  const states = {};
  for (const event of events) {
    const state = event.competitions?.[0]?.status?.type?.state ?? 'unknown';
    states[state] = (states[state] ?? 0) + 1;
  }
  const situations = events.filter((e) => e.competitions?.[0]?.situation).length;
  console.log(
    `espn scoreboard ${season} ${seasonType} week ${week}: ${events.length} games (${Object.entries(states)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ')}), ${situations} with a situation -> ${join(dir, file)}`
  );
}

/** Fetches without throwing on an HTTP error, so a failing endpoint is recorded, not fatal. */
async function tryGet(url) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, body, text: body === undefined ? text.slice(0, 500) : undefined };
  } catch (error) {
    return { status: null, body: undefined, text: String(error) };
  }
}

const shapeOf = (body) => (body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body);
const NOT_A_PROJECTION = /^(pos_)?(adp|rank)_/;
const projects = (stats) =>
  stats !== null &&
  typeof stats === 'object' &&
  Object.entries(stats).some(([k, v]) => typeof v === 'number' && !NOT_A_PROJECTION.test(k));

/** One week of projections from Sleeper's v1 endpoint and from its app's endpoint (#184). */
async function recordProjectionSources(season, week) {
  if (!Number.isInteger(season) || !Number.isInteger(week) || week < 1 || week > 18) {
    throw new Error(
      '--sleeper-app-projections takes a season and a week, e.g. --sleeper-app-projections 2026 4'
    );
  }
  const dir = join(out, 'sleeper', 'projection-sources');
  mkdirSync(dir, { recursive: true });
  const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((p) => `position[]=${p}`).join('&');
  const v1Url = `${SLEEPER}/v1/projections/nfl/regular/${season}/${week}`;
  const appUrl = `${SLEEPER_APP}/projections/nfl/${season}/${week}?season_type=regular&${positions}`;
  const [v1, app] = [await tryGet(v1Url), await tryGet(appUrl)];

  const v1Entries = v1.body && typeof v1.body === 'object' && !Array.isArray(v1.body) ? v1.body : {};
  writeJson(
    join(dir, `v1_${season}_${week}.json`),
    v1.body === undefined ? null : pick(v1Entries, PLAYER_IDS)
  );

  const rows = Array.isArray(app.body) ? app.body : [];
  const ours = rows.filter((r) => PLAYER_IDS.includes(String(r?.player_id)));
  writeJson(
    join(dir, `app_${season}_${week}.json`),
    app.body === undefined
      ? null
      : Array.isArray(app.body)
        ? ours.length > 0
          ? ours
          : rows.slice(0, 10)
        : app.body
  );

  const keys = (objects) =>
    [...new Set(objects.flatMap((o) => (o && typeof o === 'object' ? Object.keys(o) : [])))].sort();
  const summary = {
    recordedAt: new Date().toISOString(),
    season,
    week,
    v1: {
      url: v1Url,
      status: v1.status,
      shape: shapeOf(v1.body),
      entries: Object.keys(v1Entries).length,
      withProjectedStats: Object.values(v1Entries).filter(projects).length,
      statKeys: keys(Object.values(v1Entries)).slice(0, 80),
      ...(v1.text !== undefined && { text: v1.text })
    },
    app: {
      url: appUrl,
      status: app.status,
      shape: shapeOf(app.body),
      rows: rows.length,
      withProjectedStats: rows.filter((r) => projects(r?.stats)).length,
      rowKeys: keys(rows),
      statKeys: keys(rows.map((r) => r?.stats)).slice(0, 80),
      weeks: [...new Set(rows.map((r) => r?.week))],
      ...(app.text !== undefined && { text: app.text })
    }
  };
  writeFileSync(join(dir, `summary_${season}_${week}.json`), JSON.stringify(summary, null, 2) + '\n');
  console.log(
    `projection sources ${season} week ${week}: v1 HTTP ${v1.status}, ${summary.v1.withProjectedStats}/${summary.v1.entries} entries with stats; ` +
      `app HTTP ${app.status}, ${summary.app.withProjectedStats}/${summary.app.rows} rows with stats -> ${dir}`
  );
}

if (values['sleeper-app-projections'] !== undefined) {
  await recordProjectionSources(Number(values['sleeper-app-projections']), Number(positionals[0]));
} else if (values['espn-summary'] !== undefined) {
  await recordEspnSummary(values['espn-summary']);
} else if (values['espn-injuries']) {
  await recordEspnInjuries();
} else if (values['espn-scoreboard'] !== undefined) {
  await recordEspnScoreboard(
    Number(values['espn-scoreboard']),
    Number(positionals[0]),
    values['season-type']
  );
} else if (values.scoring) {
  if (doNflverse) await recordScoringNflverse();
  if (doSleeper) await recordScoringSleeper();
} else {
  if (doNflverse) await recordNflverse();
  if (doSleeper) await recordSleeper();
}
