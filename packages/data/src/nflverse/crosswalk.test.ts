import { describe, expect, it } from 'vitest';
import { fixtureJson, fixtureText, makePlayer } from '../../test/helpers.js';
import { normalizePlayers } from '../sleeper/normalize.js';
import { sleeperPlayersSchema } from '../sleeper/schemas.js';
import { toSleeperTeam } from '../teams.js';
import { IdCrosswalk, applyCrosswalk, buildCrosswalk, parseIdMap, type IdMapRow } from './crosswalk.js';

const idMap = parseIdMap(fixtureText('nflverse/db_playerids.csv'));
const players = normalizePlayers(sleeperPlayersSchema.parse(fixtureJson('sleeper/players.json')));

describe('parseIdMap', () => {
  it('parses the dynastyprocess table and converts team codes', () => {
    const mahomes = idMap.find((r) => r.sleeperId === '4046');
    expect(mahomes).toMatchObject({
      gsisId: '00-0033873',
      name: 'Patrick Mahomes',
      position: 'QB',
      team: 'KC', // KCC in the source
      espnId: '3139477',
      pfrId: 'MahoPa00'
    });
    const trayanum = idMap.find((r) => r.name === 'Chip Trayanum');
    expect(trayanum?.sleeperId).toBeUndefined();
    expect(trayanum?.gsisId).toBe('00-0041239');
  });
});

describe('buildCrosswalk (fixtures)', () => {
  const { crosswalk, report } = buildCrosswalk(players, idMap);

  it('maps via the id map, then by unique name + position', () => {
    expect(crosswalk.toGsis('4046')).toBe('00-0033873');
    expect(crosswalk.toSleeper('00-0036900')).toBe('7564');
    expect(crosswalk.entry('90001')).toEqual({ sleeperId: '90001', gsisId: '00-0041239', method: 'name' });
    expect(crosswalk.entry('90002')?.method).toBe('name');
    // The namesake CB maps to his own gsis id, not the QB's.
    expect(crosswalk.toGsis('6994')).toBe('00-0036152');
    expect(crosswalk.toGsis('4881')).toBe('00-0034796');
  });

  it('reports what could not be mapped', () => {
    expect(report).toEqual({
      considered: 20,
      mapped: 19,
      byMethod: { idmap: 17, sleeper: 0, name: 2 },
      unmapped: [
        { sleeperId: '90003', name: 'Fixture Nobody', position: 'WR', team: null, reason: 'no_match' }
      ],
      conflicts: []
    });
  });

  it('lists nflverse gsis ids with no Sleeper player', () => {
    expect(crosswalk.unmappedGsis(['00-0033873', '00-9999999', '00-9999999', '00-0000001'])).toEqual([
      '00-0000001',
      '00-9999999'
    ]);
  });

  it('applyCrosswalk fills gsis ids without touching the rest', () => {
    const applied = applyCrosswalk(players, crosswalk);
    expect(applied.find((p) => p.id === '90001')?.gsisId).toBe('00-0041239');
    const mahomes = players.find((p) => p.id === '4046');
    expect(applied.find((p) => p.id === '4046')).toBe(mahomes);
    expect(applied.find((p) => p.id === 'KC')?.gsisId).toBeUndefined();
  });
});

describe('buildCrosswalk conflicts and fallbacks', () => {
  const row = (r: Partial<IdMapRow>): IdMapRow => ({ name: 'X', position: 'WR', team: null, ...r });

  it('prefers the id map when Sleeper disagrees, and reports the mismatch', () => {
    const { crosswalk, report } = buildCrosswalk(
      [makePlayer({ id: '1', gsisId: '00-1' })],
      [row({ sleeperId: '1', gsisId: '00-2' })]
    );
    expect(crosswalk.toGsis('1')).toBe('00-2');
    expect(report.conflicts).toEqual([
      expect.objectContaining({ sleeperId: '1', kind: 'gsis_mismatch', kept: '00-2', other: '00-1' })
    ]);
  });

  it('falls back to the gsis id Sleeper carries', () => {
    const { crosswalk, report } = buildCrosswalk([makePlayer({ id: '1', gsisId: '00-1' })], []);
    expect(crosswalk.entry('1')?.method).toBe('sleeper');
    expect(report.byMethod.sleeper).toBe(1);
  });

  it('reports two Sleeper ids claiming one gsis id', () => {
    const { crosswalk, report } = buildCrosswalk(
      [makePlayer({ id: '1' }), makePlayer({ id: '2', gsisId: '00-1' })],
      [row({ sleeperId: '1', gsisId: '00-1' })]
    );
    expect(crosswalk.toSleeper('00-1')).toBe('1');
    expect(report.conflicts).toEqual([
      expect.objectContaining({ sleeperId: '2', kind: 'duplicate_gsis', kept: '00-1', other: '1' })
    ]);
    expect(report.unmapped.map((u) => u.sleeperId)).toEqual(['2']);
  });

  it('uses team to break name ties and reports true ambiguity', () => {
    const idRows = [
      row({ name: 'Mike Williams', gsisId: '00-A', team: 'NYJ' }),
      row({ name: 'Mike Williams', gsisId: '00-B', team: 'PIT' }),
      row({ name: 'Sam Smith', gsisId: '00-C', team: 'KC', position: 'PK' }),
      row({ name: 'Sam Smith', gsisId: '00-D', team: 'KC', position: 'PK' })
    ];
    const { crosswalk, report } = buildCrosswalk(
      [
        makePlayer({ id: '1', name: 'Mike Williams', team: 'PIT' }),
        makePlayer({ id: '2', name: 'Sam Smith', team: 'KC', position: 'K' }),
        makePlayer({ id: '3', name: 'Mike Williams', team: null })
      ],
      idRows
    );
    expect(crosswalk.toGsis('1')).toBe('00-B');
    expect(report.unmapped).toEqual([
      expect.objectContaining({ sleeperId: '2', reason: 'ambiguous_name' }),
      expect.objectContaining({ sleeperId: '3', reason: 'ambiguous_name' })
    ]);
  });

  it('honors custom positions and includeInactive', () => {
    const ps = [makePlayer({ id: '1', position: 'LB', active: false })];
    expect(buildCrosswalk(ps, []).report.considered).toBe(0);
    expect(buildCrosswalk(ps, [], { positions: ['LB'], includeInactive: true }).report.considered).toBe(1);
  });
});

describe('IdCrosswalk', () => {
  it('is one-to-one', () => {
    const cw = new IdCrosswalk([{ sleeperId: '1', gsisId: 'a', method: 'idmap' }]);
    expect(cw.add({ sleeperId: '1', gsisId: 'b', method: 'name' })).toBe(false);
    expect(cw.add({ sleeperId: '2', gsisId: 'a', method: 'name' })).toBe(false);
    expect(cw.size).toBe(1);
    expect(cw.entries()).toHaveLength(1);
  });
});

describe('toSleeperTeam', () => {
  it('maps nflverse, PFR, and relocated codes; free agents are null', () => {
    expect(toSleeperTeam('LA')).toBe('LAR');
    expect(toSleeperTeam('oak')).toBe('LV');
    expect(toSleeperTeam('JAC')).toBe('JAX');
    expect(toSleeperTeam('KC')).toBe('KC');
    expect(toSleeperTeam('FA*')).toBeNull();
    expect(toSleeperTeam('NA')).toBeNull();
    expect(toSleeperTeam(null)).toBeNull();
  });
});
