import { describe, expect, it } from 'vitest';
import { fixtureJson, json, mockFetch, text } from '../../test/helpers.js';
import { HttpStatusError, SchemaDriftError } from '../errors.js';
import { NflverseClient } from '../nflverse/client.js';
import { LiveDataProvider } from '../providers/live.js';
import { SleeperClient } from '../sleeper/client.js';
import { EspnClient } from './client.js';
import { normalizeScoringPlays } from './normalize.js';
import { espnSummarySchema } from './schemas.js';

const asOf = new Date('2026-10-04T18:30:00.000Z');
const FIXTURE = 'espn/summary_401772901.json';
const summary = () => espnSummarySchema.parse(fixtureJson(FIXTURE));

describe('EspnClient.summary', () => {
  it("reads one game's summary by its event id", async () => {
    const m = mockFetch((url) =>
      url.hostname === 'site.api.espn.com' && url.pathname.endsWith('/summary')
        ? json(fixtureJson(FIXTURE))
        : text('not found', 404)
    );
    const espn = new EspnClient({ fetch: m.fetch });
    const body = await espn.summary('401772901');
    expect(m.calls).toEqual([
      'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401772901'
    ]);
    expect(body.scoringPlays).toHaveLength(4);
  });

  it('rejects a bad event id, fails with the status, and flags a non-list as drift', async () => {
    const failing = mockFetch(() => text('busy', 503));
    const espn = new EspnClient({ fetch: failing.fetch, sleep: async () => undefined, random: () => 0 });
    await expect(espn.summary('abc')).rejects.toBeInstanceOf(RangeError);
    await expect(espn.summary('401772901')).rejects.toBeInstanceOf(HttpStatusError);
    const odd = mockFetch(() => json({ scoringPlays: 'none' }));
    const proxied = new EspnClient({
      fetch: odd.fetch,
      summaryUrl: 'https://proxy.test/sum',
      retry: { maxRetries: 0 }
    });
    await expect(proxied.summary('1')).rejects.toBeInstanceOf(SchemaDriftError);
    expect(odd.calls[0]).toBe('https://proxy.test/sum?event=1');
  });
});

describe('normalizeScoringPlays (fixture)', () => {
  const plays = normalizeScoringPlays(summary());

  it('reads every scoring play in game order, with Sleeper team codes', () => {
    expect(plays.map((p) => [p.kind, p.team, p.awayScore, p.homeScore])).toEqual([
      ['field_goal', 'DAL', 3, 0],
      ['touchdown', 'PHI', 3, 7],
      ['touchdown', 'DAL', 10, 7],
      ['touchdown', 'PHI', 10, 14]
    ]);
    expect(plays[3]).toEqual({
      id: '4017729011120',
      kind: 'touchdown',
      typeText: 'Passing Touchdown',
      text: 'A.J. Brown 31 Yd pass from Jalen Hurts (Jake Elliott Kick)',
      period: 2,
      clock: '11:20',
      team: 'PHI',
      awayScore: 10,
      homeScore: 14
    });
  });
});

describe('normalizeScoringPlays (tolerance)', () => {
  const one = (play: Record<string, unknown>) => normalizeScoringPlays({ scoringPlays: [play] })[0];

  it('keeps a play with only an id and a description', () => {
    expect(one({ id: 7, text: '  Justin   Tucker 50 Yd Field Goal ' })).toEqual({
      id: '7',
      kind: 'other',
      typeText: null,
      text: 'Justin Tucker 50 Yd Field Goal',
      period: null,
      clock: null,
      team: null,
      awayScore: null,
      homeScore: null
    });
  });

  it('reads the kind from the scoring type, the abbreviations, or the type text', () => {
    const kind = (play: Record<string, unknown>) => one({ id: '1', text: 'x', ...play })?.kind;
    expect(kind({ scoringType: { name: 'field-goal' } })).toBe('field_goal');
    expect(kind({ scoringType: { name: 'extra-point' } })).toBe('extra_point');
    expect(kind({ scoringType: { name: 'two-point-conversion' } })).toBe('two_point');
    expect(kind({ scoringType: { name: 'Safety' } })).toBe('safety');
    expect(kind({ scoringType: { name: 'weird', abbreviation: 'td' } })).toBe('touchdown');
    expect(kind({ type: { abbreviation: 'PAT' } })).toBe('extra_point');
    expect(kind({ type: { text: 'Interception Return Touchdown' } })).toBe('touchdown');
    expect(kind({ type: { text: 'Field Goal Good' } })).toBe('field_goal');
    expect(kind({ type: { text: 'Blocked Field Goal' } })).toBe('other');
    expect(kind({ type: { text: 'Safety' } })).toBe('safety');
    expect(kind({ type: null, scoringType: null })).toBe('other');
  });

  it('reads string scores and ESPN team codes, and drops what it cannot place', () => {
    expect(
      one({ id: '1', text: 'x', awayScore: '7', homeScore: 'n/a', team: { abbreviation: 'WSH' }, clock: {} })
    ).toMatchObject({ awayScore: 7, homeScore: null, team: 'WAS', clock: null });
    expect(one({ id: '1', text: 'x', team: { abbreviation: 'AFC' } })?.team).toBeNull();
  });

  it('skips a play without a description, and calls it drift only when none parse', () => {
    const two = (first: Record<string, unknown>) =>
      normalizeScoringPlays({ scoringPlays: [first, { id: '2', text: 'ok' }] });
    expect(two({ id: '1', text: '  ' })).toHaveLength(1);
    expect(two({ id: '1' })).toHaveLength(1);
    expect(() => normalizeScoringPlays({ scoringPlays: [{ id: '1' }] })).toThrow(SchemaDriftError);
    expect(normalizeScoringPlays({ scoringPlays: [{ id: '', text: 'x' }] })).toEqual([]);
    expect(normalizeScoringPlays({})).toEqual([]);
    expect(normalizeScoringPlays({ scoringPlays: null })).toEqual([]);
  });
});

describe('LiveDataProvider.getScoringPlays', () => {
  const provider = (espn: boolean) => {
    const m = mockFetch((url) =>
      url.hostname === 'site.api.espn.com' ? json(fixtureJson(FIXTURE)) : text('not found', 404)
    );
    return {
      calls: m.calls,
      live: new LiveDataProvider({
        sleeper: new SleeperClient({
          clock: { now: () => asOf },
          fetch: m.fetch,
          limiter: { acquire: async () => undefined }
        }),
        nflverse: new NflverseClient({ fetch: m.fetch, sleep: async () => undefined }),
        ...(espn && { espn: new EspnClient({ fetch: m.fetch }) })
      })
    };
  };

  it("reads a game's scoring plays from ESPN's summary", async () => {
    const { live } = provider(true);
    expect(await live.getScoringPlays('401772901', asOf)).toHaveLength(4);
  });

  it('has none without an ESPN client', async () => {
    const { live, calls } = provider(false);
    expect(await live.getScoringPlays('401772901', asOf)).toEqual([]);
    expect(calls).toEqual([]);
  });
});
