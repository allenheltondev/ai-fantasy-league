import { describe, expect, it } from 'vitest';
import { fixtureJson, json, mockFetch, text } from '../../test/helpers.js';
import { HttpStatusError, SchemaDriftError } from '../errors.js';
import { NflverseClient } from '../nflverse/client.js';
import { LiveDataProvider } from '../providers/live.js';
import { SleeperClient } from '../sleeper/client.js';
import { normalizePlayers } from '../sleeper/normalize.js';
import { sleeperPlayersSchema } from '../sleeper/schemas.js';
import type { InjuryReport } from '../types.js';
import { EspnClient } from './client.js';
import { espnInjuryStatus, matchInjuryReports, normalizeInjuries } from './injuries.js';
import { espnInjuriesSchema } from './schemas.js';

const asOf = new Date('2026-10-04T15:35:00.000Z');
/** Hand-authored from the public response shape: the sandbox cannot reach ESPN (see README). */
const FIXTURE = 'espn/hand-authored/injuries.json';
const report = () => normalizeInjuries(espnInjuriesSchema.parse(fixtureJson(FIXTURE)));
const players = () => normalizePlayers(sleeperPlayersSchema.parse(fixtureJson('sleeper/players.json')));

describe('EspnClient.injuries', () => {
  it('reads the league-wide injury report', async () => {
    const m = mockFetch((url) =>
      url.pathname.endsWith('/injuries') ? json(fixtureJson(FIXTURE)) : text('not found', 404)
    );
    const body = await new EspnClient({ fetch: m.fetch }).injuries();
    expect(m.calls).toEqual(['https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries']);
    expect(body.injuries).toHaveLength(5);
  });

  it('fails with the status, and flags a changed envelope as drift', async () => {
    const failing = mockFetch(() => text('busy', 503));
    const espn = new EspnClient({ fetch: failing.fetch, sleep: async () => undefined, random: () => 0 });
    await expect(espn.injuries()).rejects.toBeInstanceOf(HttpStatusError);
    const odd = mockFetch(() => json({ teams: [] }));
    const proxied = new EspnClient({ fetch: odd.fetch, injuriesUrl: 'https://proxy.test/inj' });
    await expect(proxied.injuries()).rejects.toBeInstanceOf(SchemaDriftError);
    expect(odd.calls).toEqual(['https://proxy.test/inj']);
  });
});

describe('normalizeInjuries (fixture)', () => {
  it('reads each entry with its ESPN id, our team code, and our designation', () => {
    const entries = report();
    expect(entries.map((r) => [r.name, r.espnId, r.team, r.injuryStatus])).toEqual([
      ['Christian McCaffrey', '3117251', 'SF', 'Out'],
      ['Justin Jefferson', '4262921', 'MIN', 'Doubtful'],
      ["Ja'Marr Chase", null, 'CIN', 'Questionable'],
      ['Practice Fixture', '4999999', 'WAS', 'IR']
    ]);
    expect(entries[0]).toMatchObject({
      position: 'RB',
      statusText: 'Out',
      reportedAt: '2026-10-04T15:28Z',
      comment: "McCaffrey (Achilles) is inactive for Sunday's game."
    });
  });

  it('skips unknown words and malformed entries, and calls it drift only when none parse', () => {
    const group = (...entries: unknown[]) => normalizeInjuries({ injuries: [{ injuries: entries }] });
    const ok = { status: 'Questionable', athlete: { displayName: 'A B' } };
    expect(group({ status: 'Out' }, ok)).toHaveLength(1);
    expect(group({ ...ok, status: 'Day-To-Day' })).toEqual([]);
    expect(() => group({ status: 'Out' })).toThrow(SchemaDriftError);
    expect(normalizeInjuries({ injuries: [{ injuries: null }, {}] })).toEqual([]);
    expect(group({ ...ok, athlete: { displayName: 'A B', team: { abbreviation: 'AFC' } } })[0]).toMatchObject(
      {
        team: null,
        position: null,
        espnId: null,
        reportedAt: null,
        comment: null
      }
    );
    expect(
      group({ ...ok, athlete: { displayName: 'A B', id: 'x', links: [{ href: null }] } })[0]?.espnId
    ).toBe(null);
  });

  it('maps every status word, and leaves unknown ones undecided', () => {
    expect(espnInjuryStatus('Injured Reserve')).toBe('IR');
    expect(espnInjuryStatus(' inactive ')).toBe('Out');
    expect(espnInjuryStatus('Physically Unable to Perform')).toBe('PUP');
    expect(espnInjuryStatus('Suspension')).toBe('Suspended');
    expect(espnInjuryStatus('Active')).toBeNull();
    expect(espnInjuryStatus('Probable')).toBeNull();
    expect(espnInjuryStatus('Day-To-Day')).toBeUndefined();
    expect(espnInjuryStatus('hasOwnProperty')).toBeUndefined();
  });
});

describe('matchInjuryReports', () => {
  it('matches by the Sleeper espn_id first, then by name, team, and position', () => {
    const matches = matchInjuryReports(report(), players());
    expect([...matches.byPlayer].map(([id, r]) => [id, r.injuryStatus])).toEqual([
      ['4034', 'Out'],
      ['6794', 'Doubtful'],
      ['7564', 'Questionable']
    ]);
    expect(matches).toMatchObject({ byId: 2, byName: 1, unmatched: 1 });
  });

  const entry = (over: Partial<InjuryReport>): InjuryReport => ({
    espnId: null,
    name: 'Lamar Jackson',
    team: 'BAL',
    position: 'QB',
    injuryStatus: 'Out',
    statusText: 'Out',
    reportedAt: null,
    comment: null,
    ...over
  });

  it('never matches a name shared by two candidates or two entries, or a different known id', () => {
    const twins = [
      { id: 'a', name: 'Lamar Jackson', team: 'BAL', position: 'QB' },
      { id: 'b', name: 'Lamar Jackson', team: 'BAL', position: 'QB' }
    ];
    expect(matchInjuryReports([entry({})], twins).byPlayer.size).toBe(0);
    const one = [{ id: 'a', name: 'Lamar Jackson Jr.', team: 'BAL', position: 'QB' }];
    expect(matchInjuryReports([entry({}), entry({})], one).byPlayer.size).toBe(0);
    expect(matchInjuryReports([entry({})], one).byPlayer.get('a')?.injuryStatus).toBe('Out');
    const known = [{ ...one[0], espnId: '1' } as (typeof one)[number] & { espnId: string }];
    expect(matchInjuryReports([entry({ espnId: '2' })], known)).toMatchObject({ byName: 0, unmatched: 1 });
    expect(matchInjuryReports([entry({ espnId: '1' })], known)).toMatchObject({ byId: 1 });
  });
});

describe('LiveDataProvider.getInjuries', () => {
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

  it('reads the report from ESPN, and has none without an ESPN client', async () => {
    expect(await provider(true).live.getInjuries(asOf)).toHaveLength(4);
    const none = provider(false);
    expect(await none.live.getInjuries(asOf)).toEqual([]);
    expect(none.calls).toEqual([]);
  });
});
