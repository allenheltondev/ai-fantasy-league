import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StatChange } from './log.js';
import {
  isDefensivePlay,
  matchScoringPlay,
  namesPlayer,
  nameTokens,
  PLAY_MATCH_WINDOW_MS,
  playRoles,
  wantsPlay,
  type PlayMatchEntry,
  type PlayMatchPlayer,
  type ScoringPlayCandidate
} from './plays.js';

const T0 = Date.parse('2026-10-04T18:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const play = (id: string, text: string, over: Partial<ScoringPlayCandidate> = {}): ScoringPlayCandidate => ({
  id,
  kind: 'touchdown',
  typeText: null,
  text,
  team: 'KC',
  seenAt: at(0),
  ...over
});

const person = (name: string, firstName: string, lastName: string, team: string, position: string) =>
  ({ name, firstName, lastName, team, position }) satisfies PlayMatchPlayer;

const KELCE = person('Travis Kelce', 'Travis', 'Kelce', 'KC', 'TE');
const MAHOMES = person('Patrick Mahomes', 'Patrick', 'Mahomes', 'KC', 'QB');
const BUTKER = person('Harrison Butker', 'Harrison', 'Butker', 'KC', 'K');
const KC_DEF = {
  name: 'Kansas City Chiefs',
  firstName: 'Kansas City',
  lastName: 'Chiefs',
  team: 'KC',
  position: 'DEF'
};

const c = (stat: string, delta: number): StatChange => ({ stat, delta });
const entry = (player: PlayMatchPlayer, changes: StatChange[], minutes = 1): PlayMatchEntry => ({
  at: at(minutes),
  changes,
  player
});

const KELCE_TD = play('401', 'Travis Kelce 18 Yd pass from Patrick Mahomes (Harrison Butker Kick)', {
  typeText: 'Passing Touchdown'
});

describe('nameTokens and namesPlayer', () => {
  it('drops accents, apostrophes, and periods, and joins hyphens', () => {
    expect(nameTokens("D'Andre Swift")).toEqual(['dandre', 'swift']);
    expect(nameTokens('A.J. Brown')).toEqual(['aj', 'brown']);
    expect(nameTokens('P.Mahomes 5 Yd Run')).toEqual(['p', 'mahomes', '5', 'yd', 'run']);
    expect(nameTokens('Amon-Ra St. Brown')).toEqual(['amonra', 'st', 'brown']);
    expect(nameTokens('Tomás Pérez')).toEqual(['tomas', 'perez']);
  });

  it('matches a full name, ignoring a generational suffix on either side', () => {
    const mhj = person('Marvin Harrison Jr.', 'Marvin', 'Harrison', 'ARI', 'WR');
    expect(namesPlayer('Marvin Harrison Jr. 12 Yd pass from Kyler Murray', mhj)).toBe(true);
    expect(namesPlayer('Marvin Harrison 12 Yd pass', mhj)).toBe(true);
    const walker = person('Kenneth Walker', 'Kenneth', 'Walker', 'SEA', 'RB');
    expect(namesPlayer('Kenneth Walker III 4 Yd Run', walker)).toBe(true);
    const mahomesII = person('Patrick Mahomes II', 'Patrick', 'Mahomes II', 'KC', 'QB');
    expect(namesPlayer('Patrick Mahomes 1 Yd Run', mahomesII)).toBe(true);
    expect(namesPlayer('P.Mahomes 1 Yd Run', mahomesII)).toBe(true);
  });

  it('matches names with hyphens, periods, and two-word last names', () => {
    const arsb = person('Amon-Ra St. Brown', 'Amon-Ra', 'St. Brown', 'DET', 'WR');
    expect(namesPlayer('Amon-Ra St. Brown 9 Yd pass from Jared Goff', arsb)).toBe(true);
    expect(namesPlayer('A. St. Brown 9 Yd pass', arsb)).toBe(true);
    expect(namesPlayer('Equanimeous St. Brown 9 Yd pass', arsb)).toBe(false);
    const jsn = person('Jaxon Smith-Njigba', 'Jaxon', 'Smith-Njigba', 'SEA', 'WR');
    expect(namesPlayer('Jaxon Smith-Njigba 30 Yd pass', jsn)).toBe(true);
    const aj = person('A.J. Brown', 'A.J.', 'Brown', 'PHI', 'WR');
    expect(namesPlayer('A.J. Brown 40 Yd pass from Jalen Hurts', aj)).toBe(true);
  });

  it('accepts a first initial, but not another first name or a partial word', () => {
    expect(namesPlayer('T. Kelce 18 Yd pass', KELCE)).toBe(true);
    expect(namesPlayer('Jason Kelce 18 Yd pass', KELCE)).toBe(false);
    expect(namesPlayer('J. Kelce 18 Yd pass', KELCE)).toBe(false);
    expect(namesPlayer('Kelce 18 Yd pass', KELCE)).toBe(false);
    expect(namesPlayer('Travis Kelcey 18 Yd pass', KELCE)).toBe(false);
    const ray = person('Ray Davis', 'Ray', 'Davis', 'BUF', 'RB');
    expect(namesPlayer('Ray-Ray Davis 5 Yd Run', ray)).toBe(false);
    expect(namesPlayer('Pele 5 Yd Run', { name: 'Pele' })).toBe(false);
    expect(namesPlayer('T Kelce 18 Yd pass', { name: 'Travis Kelce' })).toBe(false);
  });
});

describe('playRoles', () => {
  it('gives each touchdown and field-goal stat its role', () => {
    expect(playRoles([c('rec', 1), c('rec_yd', 18), c('rec_td', 1)], 'TE')).toEqual(['receiver']);
    expect(playRoles([c('rush_td', 1)], 'RB')).toEqual(['rusher']);
    expect(playRoles([c('pass_yd', 18), c('pass_td', 1)], 'QB')).toEqual(['passer']);
    expect(playRoles([c('st_td', 1)], 'WR')).toEqual(['returner']);
    expect(playRoles([c('fgm_40_49', 1), c('fgm_yds', 44)], 'K')).toEqual(['kicker']);
    expect(playRoles([c('def_td', 1), c('int', 1)], 'DEF')).toEqual(['defense']);
    expect(playRoles([c('def_st_td', 1)], 'DEF')).toEqual(['defense']);
  });

  it('gives no role to extra points, misses, removed touchdowns, or yards', () => {
    expect(playRoles([c('xpm', 1)], 'K')).toEqual([]);
    expect(playRoles([c('fgmiss_50p', 1)], 'K')).toEqual([]);
    expect(playRoles([c('rec_td', -1)], 'WR')).toEqual([]);
    expect(playRoles([c('rush_yd', 12)], 'RB')).toEqual([]);
    expect(playRoles([c('fgm_30_39', 1)], 'DEF')).toEqual([]);
    expect(wantsPlay([c('rush_yd', 12)], 'RB')).toBe(false);
    expect(wantsPlay([c('rush_td', 1)], 'RB')).toBe(true);
  });
});

describe('isDefensivePlay', () => {
  it('reads the play type first, then the description', () => {
    expect(isDefensivePlay(play('1', 'x', { typeText: 'Interception Return Touchdown' }))).toBe(true);
    expect(isDefensivePlay(play('1', 'x', { typeText: 'Kickoff Return Touchdown' }))).toBe(true);
    expect(isDefensivePlay(play('1', 'x', { typeText: 'Passing Touchdown' }))).toBe(false);
    expect(isDefensivePlay(play('1', 'x', { typeText: 'Fumble Recovery (Own)' }))).toBe(false);
    expect(
      isDefensivePlay(play('1', 'Trent McDuffie 35 Yd Interception Return (Harrison Butker Kick)'))
    ).toBe(true);
    expect(isDefensivePlay(play('1', 'Isiah Pacheco 3 Yd Run (Harrison Butker Kick)'))).toBe(false);
    expect(isDefensivePlay(play('1', 'Harrison Butker 40 Yd Field Goal', { kind: 'field_goal' }))).toBe(
      false
    );
  });
});

describe('matchScoringPlay', () => {
  const fg = play('402', 'Harrison Butker 44 Yd Field Goal', {
    kind: 'field_goal',
    typeText: 'Field Goal Good'
  });
  const xp = play('403', 'Travis Kelce 2 Yd pass from Patrick Mahomes (Harrison Butker Kick)', {
    kind: 'extra_point'
  });

  it('gives the receiver and the passer the touchdown pass, and the kicker nothing for the extra point', () => {
    expect(matchScoringPlay(entry(KELCE, [c('rec', 1), c('rec_td', 1)]), [KELCE_TD, fg])).toBe(KELCE_TD);
    expect(matchScoringPlay(entry(MAHOMES, [c('pass_td', 1)]), [KELCE_TD, fg])).toBe(KELCE_TD);
    expect(matchScoringPlay(entry(BUTKER, [c('xpm', 1)]), [KELCE_TD, fg])).toBeNull();
    expect(matchScoringPlay(entry(BUTKER, [c('fgm_40_49', 1)]), [KELCE_TD, fg])).toBe(fg);
  });

  it('never gives a player a play in the wrong role', () => {
    // Mahomes is in the text, but as the passer, not the scorer of a rushing or receiving TD.
    expect(matchScoringPlay(entry(MAHOMES, [c('rush_td', 1)]), [KELCE_TD])).toBeNull();
    expect(matchScoringPlay(entry(MAHOMES, [c('rec_td', 1)]), [KELCE_TD])).toBeNull();
    // A rushing touchdown is never a pass play, and a receiving one always is.
    const run = play('7', 'Travis Kelce 2 Yd Run (Harrison Butker Kick)');
    expect(matchScoringPlay(entry(KELCE, [c('rec_td', 1)]), [run])).toBeNull();
    expect(matchScoringPlay(entry(KELCE, [c('rush_td', 1)]), [run])).toBe(run);
    expect(matchScoringPlay(entry(KELCE, [c('rush_td', 1)]), [KELCE_TD])).toBeNull();
    // Kelce is the receiver, not the passer.
    expect(matchScoringPlay(entry(KELCE, [c('pass_td', 1)]), [KELCE_TD])).toBeNull();
    // Butker's name is only in the extra point, and a touchdown play is not a field goal.
    expect(matchScoringPlay(entry(BUTKER, [c('fgm_20_29', 1)]), [KELCE_TD])).toBeNull();
    // An extra-point play is not a touchdown.
    expect(matchScoringPlay(entry(KELCE, [c('rec_td', 1)]), [xp])).toBeNull();
  });

  it('requires the same team', () => {
    const allenBuf = person('Josh Allen', 'Josh', 'Allen', 'BUF', 'QB');
    const allenJax = person('Josh Allen', 'Josh', 'Allen', 'JAX', 'LB');
    const run = play('9', 'Josh Allen 1 Yd Run (Tyler Bass Kick)', { team: 'BUF' });
    expect(matchScoringPlay(entry(allenBuf, [c('rush_td', 1)]), [run])).toBe(run);
    expect(matchScoringPlay(entry(allenJax, [c('fum_rec_td', 1)]), [run])).toBeNull();
    expect(matchScoringPlay(entry({ ...KELCE, team: null }, [c('rec_td', 1)]), [KELCE_TD])).toBeNull();
    expect(matchScoringPlay(entry(KELCE, [c('rec_td', 1)]), [{ ...KELCE_TD, team: null }])).toBeNull();
  });

  it('requires the play to be seen within the window of the entry', () => {
    const window = PLAY_MATCH_WINDOW_MS / 60_000;
    expect(matchScoringPlay(entry(KELCE, [c('rec_td', 1)], window), [KELCE_TD])).toBe(KELCE_TD);
    expect(matchScoringPlay(entry(KELCE, [c('rec_td', 1)], -window), [KELCE_TD])).toBe(KELCE_TD);
    expect(matchScoringPlay(entry(KELCE, [c('rec_td', 1)], window + 1), [KELCE_TD])).toBeNull();
    expect(matchScoringPlay(entry(KELCE, [c('rec_td', 1)], 40), [KELCE_TD])).toBeNull();
    expect(matchScoringPlay({ ...entry(KELCE, [c('rec_td', 1)]), at: 'soon' }, [KELCE_TD])).toBeNull();
    expect(matchScoringPlay(entry(KELCE, [c('rec_td', 1)]), [{ ...KELCE_TD, seenAt: 'x' }])).toBeNull();
  });

  it('gives nothing when two plays fit (two touchdowns close together)', () => {
    const second = play('410', 'Travis Kelce 3 Yd pass from Patrick Mahomes (Harrison Butker Kick)', {
      seenAt: at(4)
    });
    expect(matchScoringPlay(entry(KELCE, [c('rec_td', 1)], 2), [KELCE_TD, second])).toBeNull();
    expect(matchScoringPlay(entry(KELCE, [c('rec_td', 2)], 2), [KELCE_TD, second])).toBeNull();
    // Far enough apart, each entry finds its own.
    const later = { ...second, seenAt: at(30) };
    expect(matchScoringPlay(entry(KELCE, [c('rec_td', 1)], 1), [KELCE_TD, later])).toBe(KELCE_TD);
    expect(matchScoringPlay(entry(KELCE, [c('rec_td', 1)], 31), [KELCE_TD, later])).toBe(later);
  });

  it('tells namesakes on one team apart, and gives nothing when it cannot', () => {
    const jameson = person('Jameson Williams', 'Jameson', 'Williams', 'DET', 'WR');
    const jermaine = person('Jermaine Williams', 'Jermaine', 'Williams', 'DET', 'WR');
    const catch1 = play('1', 'J. Williams 45 Yd pass from Jared Goff (Jake Bates Kick)', { team: 'DET' });
    // Only one namesake scored: the initial form is his.
    expect(matchScoringPlay(entry(jameson, [c('rec_td', 1)]), [catch1])).toBe(catch1);
    // A full name settles it.
    const full = play('2', 'Jermaine Williams 8 Yd pass from Jared Goff', { team: 'DET', seenAt: at(3) });
    expect(matchScoringPlay(entry(jameson, [c('rec_td', 1)]), [catch1, full])).toBe(catch1);
    expect(matchScoringPlay(entry(jermaine, [c('rec_td', 1)], 3), [catch1, full])).toBeNull();
    expect(matchScoringPlay(entry(jermaine, [c('rec_td', 1)], 3), [full])).toBe(full);
    // Both caught one in the window and ESPN wrote only initials: neither gets a description.
    const catch2 = { ...full, text: 'J. Williams 8 Yd pass from Jared Goff' };
    expect(matchScoringPlay(entry(jameson, [c('rec_td', 1)]), [catch1, catch2])).toBeNull();
    expect(matchScoringPlay(entry(jermaine, [c('rec_td', 1)], 3), [catch1, catch2])).toBeNull();
  });

  it('counts one play once, whatever roles fit it', () => {
    const trick = play('5', 'Travis Kelce 10 Yd pass from Travis Kelce', {});
    expect(matchScoringPlay(entry(KELCE, [c('rec_td', 1), c('pass_td', 1)]), [trick])).toBe(trick);
  });

  it('gives a team defense its defensive or return touchdown, and nothing else', () => {
    const pick6 = play('20', 'Trent McDuffie 35 Yd Interception Return (Harrison Butker Kick)', {
      typeText: 'Interception Return Touchdown'
    });
    const kr = play('21', 'Mecole Hardman 98 Yd Kickoff Return (Harrison Butker Kick)', {
      typeText: 'Kickoff Return Touchdown',
      seenAt: at(30)
    });
    expect(matchScoringPlay(entry(KC_DEF, [c('def_td', 1), c('int', 1)]), [KELCE_TD, pick6])).toBe(pick6);
    expect(matchScoringPlay(entry(KC_DEF, [c('def_st_td', 1)], 31), [KELCE_TD, kr])).toBe(kr);
    expect(matchScoringPlay(entry(KC_DEF, [c('def_td', 1)]), [KELCE_TD])).toBeNull();
    // The other team's pick-six is not KC's.
    expect(matchScoringPlay(entry(KC_DEF, [c('def_td', 1)]), [{ ...pick6, team: 'DEN' }])).toBeNull();
    // Two defensive scores in the window: ambiguous.
    const fumble = play('22', 'Chris Jones 4 Yd Fumble Return', {
      typeText: 'Fumble Return Touchdown',
      seenAt: at(2)
    });
    expect(matchScoringPlay(entry(KC_DEF, [c('def_td', 1)]), [pick6, fumble])).toBeNull();
    // The returner gets the kickoff return too, as himself.
    const hardman = person('Mecole Hardman', 'Mecole', 'Hardman', 'KC', 'WR');
    expect(matchScoringPlay(entry(hardman, [c('st_td', 1)], 30), [kr])).toBe(kr);
    // A receiving touchdown never takes a defensive play, even with the name in it.
    const mcduffie = person('Trent McDuffie', 'Trent', 'McDuffie', 'KC', 'WR');
    expect(matchScoringPlay(entry(mcduffie, [c('rec_td', 1)]), [pick6])).toBeNull();
  });

  it('gives nothing to entries without a touchdown or a field goal', () => {
    expect(matchScoringPlay(entry(KELCE, [c('rec', 1), c('rec_yd', 18)]), [KELCE_TD])).toBeNull();
    expect(matchScoringPlay(entry(KELCE, [c('rec_td', 1)]), [])).toBeNull();
  });

  it('never matches a player whose name is not in the play (property)', () => {
    const word = fc.stringMatching(/^[A-Z][a-z]{2,8}$/);
    fc.assert(
      fc.property(
        word,
        word,
        word,
        word,
        fc.integer({ min: -9, max: 9 }),
        (first, last, other1, other2, minutes) => {
          fc.pre(nameTokens(last)[0] !== nameTokens(other2)[0]);
          const player = person(`${first} ${last}`, first, last, 'KC', 'WR');
          const text = `${other1} ${other2} 12 Yd pass from ${first} ${last} (${first} ${last} Kick)`;
          expect(matchScoringPlay(entry(player, [c('rec_td', 1)], minutes), [play('1', text)])).toBeNull();
          const own = `${first} ${last} 12 Yd pass from ${other1} ${other2}`;
          expect(matchScoringPlay(entry(player, [c('rec_td', 1)], minutes), [play('1', own)])?.id).toBe('1');
        }
      )
    );
  });

  it('returns a play only when it is the single fit (property)', () => {
    const texts = fc.constantFrom(
      KELCE_TD.text,
      'Travis Kelce 3 Yd pass from Patrick Mahomes',
      'Isiah Pacheco 3 Yd Run',
      'T. Kelce 7 Yd pass from P.Mahomes'
    );
    const plays = fc.array(
      fc.record({
        id: fc.integer({ min: 1, max: 6 }).map(String),
        text: texts,
        team: fc.constantFrom('KC', 'DEN'),
        minutes: fc.integer({ min: -20, max: 20 })
      }),
      { maxLength: 6 }
    );
    fc.assert(
      fc.property(plays, (list) => {
        const candidates = list.map((p) => play(p.id, p.text, { team: p.team, seenAt: at(p.minutes) }));
        const found = matchScoringPlay(entry(KELCE, [c('rec_td', 1)], 0), candidates);
        const fitting = new Set(
          list
            .filter((p) => p.team === 'KC' && Math.abs(p.minutes) <= 10 && p.text.includes('Kelce'))
            .map((p) => p.id)
        );
        if (fitting.size === 1) expect(found?.id).toBe([...fitting][0]);
        else expect(found).toBeNull();
      })
    );
  });
});
