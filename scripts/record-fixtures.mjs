#!/usr/bin/env node
// Records REAL, trimmed Sleeper and nflverse responses into packages/data/fixtures/.
//
// Run it somewhere api.sleeper.app is reachable (CI, AWS, most laptops):
//
//   node scripts/record-fixtures.mjs                 # Sleeper + nflverse, season 2025, weeks 1-2
//   node scripts/record-fixtures.mjs --sleeper       # only Sleeper
//   node scripts/record-fixtures.mjs --nflverse      # only nflverse (works from the dev sandbox)
//   node scripts/record-fixtures.mjs --season 2025 --weeks 1,2 --out /tmp/fixtures
//
// Responses are trimmed to the fixture player set below so the files stay small (< 2 MB total).
// Synthetic players (ids starting with 900) in the existing players.json are preserved because
// the crosswalk tests rely on them. After recording, run `npm run test -w packages/data` and
// update any assertion that pinned a hand-authored value.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const SLEEPER = 'https://api.sleeper.app';
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

const { values } = parseArgs({
  options: {
    season: { type: 'string', default: '2025' },
    weeks: { type: 'string', default: '1,2' },
    out: { type: 'string', default: 'packages/data/fixtures' },
    sleeper: { type: 'boolean', default: false },
    nflverse: { type: 'boolean', default: false }
  }
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

if (doNflverse) await recordNflverse();
if (doSleeper) await recordSleeper();
