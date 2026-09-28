import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mentionedTeamIds, type MentionTarget } from './mentions.js';
import {
  CLOSE_MATCHUP_MARGIN,
  DEFAULT_ROOM_ID,
  FIXED_ROOM_IDS,
  MATCHUP_ROOM_TEMPLATES,
  ROOM_ID_PATTERN,
  SYSTEM_MESSAGE_ROUTES,
  dmPartner,
  dmRoomId,
  isFixedRoomId,
  matchupRoomId,
  matchupRoomTitle,
  parseRoomId,
  renderMatchupRoomLine,
  roomMentionTargets,
  systemMessageRoute
} from './rooms.js';
import { SYSTEM_MESSAGE_TEMPLATES } from './system-messages.js';

const TEAMS = ['team-1', 'team-2', 'team-3', 'team-10'];
const teamId = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,12}$/);

describe('room ids', () => {
  it('has the five fixed rooms, trash talk first in line', () => {
    expect(FIXED_ROOM_IDS).toEqual(['league', 'trash-talk', 'draft', 'trades', 'waivers-news']);
    expect(DEFAULT_ROOM_ID).toBe('trash-talk');
    expect(isFixedRoomId('draft')).toBe(true);
    expect(isFixedRoomId('dm-team-1-team-2')).toBe(false);
    for (const id of FIXED_ROOM_IDS) expect(parseRoomId(id, TEAMS)).toEqual({ kind: 'fixed', id });
  });

  it('names matchup rooms by season, padded week, and matchup id', () => {
    const id = matchupRoomId(2026, 5, 'W05-1');
    expect(id).toBe('m-2026-W05-W05-1');
    expect(parseRoomId(id, TEAMS)).toEqual({
      kind: 'matchup',
      id,
      season: 2026,
      week: 5,
      matchupId: 'W05-1'
    });
    expect(parseRoomId(matchupRoomId(2026, 15, 'W15-P-semi-1'), TEAMS)).toMatchObject({
      week: 15,
      matchupId: 'W15-P-semi-1'
    });
    expect(parseRoomId('m-2026-W00-x', TEAMS)).toBeNull();
    expect(parseRoomId('m-26-W05-x', TEAMS)).toBeNull();
    expect(matchupRoomTitle(5, 'Big Tuna', 'Gridiron Gang')).toBe('Wk 5: Big Tuna vs Gridiron Gang');
  });

  it('names a DM the same way from either side and resolves team ids that contain dashes', () => {
    expect(dmRoomId('team-2', 'team-1')).toBe('dm-team-1-team-2');
    expect(dmRoomId('team-1', 'team-2')).toBe('dm-team-1-team-2');
    expect(() => dmRoomId('team-1', 'team-1')).toThrow(/two different teams/);
    expect(parseRoomId('dm-team-1-team-10', TEAMS)).toEqual({
      kind: 'dm',
      id: 'dm-team-1-team-10',
      teamIds: ['team-1', 'team-10']
    });
    expect(dmPartner({ teamIds: ['team-1', 'team-10'] }, 'team-10')).toBe('team-1');
    expect(dmPartner({ teamIds: ['team-1', 'team-10'] }, 'team-1')).toBe('team-10');
    // Unsorted, unknown teams, a team with itself, and junk are not rooms.
    expect(parseRoomId('dm-team-2-team-1', TEAMS)).toBeNull();
    expect(parseRoomId('dm-team-1-team-9', TEAMS)).toBeNull();
    expect(parseRoomId('dm-team-1-team-1', TEAMS)).toBeNull();
    expect(parseRoomId('general', TEAMS)).toBeNull();
    expect(parseRoomId('trash talk', TEAMS)).toBeNull();
    expect(parseRoomId('', TEAMS)).toBeNull();
  });

  it('round-trips any pair of distinct teams (property)', () => {
    fc.assert(
      fc.property(teamId, teamId, fc.array(teamId, { maxLength: 6 }), (a, b, others) => {
        fc.pre(a !== b);
        const id = dmRoomId(a, b);
        expect(dmRoomId(b, a)).toBe(id);
        expect(ROOM_ID_PATTERN.test(id)).toBe(true);
        const parsed = parseRoomId(id, [...others, a, b]);
        expect(parsed?.kind).toBe('dm');
        if (parsed?.kind === 'dm') {
          expect([...parsed.teamIds].sort()).toEqual([a, b].sort());
          expect(`dm-${parsed.teamIds[0]}-${parsed.teamIds[1]}`).toBe(id);
        }
      })
    );
  });

  it('round-trips any matchup (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2000, max: 2099 }),
        fc.integer({ min: 1, max: 18 }),
        fc.stringMatching(/^[A-Za-z0-9._-]{1,20}$/),
        (season, week, matchupId) => {
          const id = matchupRoomId(season, week, matchupId);
          expect(parseRoomId(id, TEAMS)).toEqual({ kind: 'matchup', id, season, week, matchupId });
        }
      )
    );
  });
});

describe('mentions by room', () => {
  const targets: MentionTarget[] = [
    { teamId: 'team-1', names: ['Alpha', 'team-1'] },
    { teamId: 'team-2', names: ['Bravo', 'team-2'] },
    { teamId: 'team-3', names: ['Charlie', 'team-3'] }
  ];

  it('lets anyone be mentioned outside DMs', () => {
    const room = parseRoomId('trash-talk', TEAMS);
    expect(mentionedTeamIds('@Bravo @Charlie', roomMentionTargets(room!, targets, 'team-1'))).toEqual([
      'team-2',
      'team-3'
    ]);
  });

  it('in a DM, only the other team can be mentioned (property)', () => {
    const room = parseRoomId('dm-team-1-team-2', TEAMS)!;
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('@Alpha', '@Bravo', '@Charlie', '@team-3', 'hi', '@nobody'), {
          maxLength: 8
        }),
        fc.constantFrom('team-1', 'team-2'),
        (words, author) => {
          const mentioned = mentionedTeamIds(words.join(' '), roomMentionTargets(room, targets, author));
          const other = author === 'team-1' ? 'team-2' : 'team-1';
          expect(mentioned.every((t) => t === other)).toBe(true);
        }
      )
    );
    expect(roomMentionTargets(room, targets, null)).toEqual([]);
  });
});

describe('system message routing', () => {
  it('routes every templated event to a fixed room', () => {
    for (const detailType of Object.keys(SYSTEM_MESSAGE_TEMPLATES)) {
      const route = SYSTEM_MESSAGE_ROUTES[detailType];
      expect(route, `${detailType} has a route`).toBeDefined();
      expect(FIXED_ROOM_IDS).toContain(route?.room);
    }
  });

  it('sends each kind of news to its room', () => {
    const rooms = (types: string[]) => types.map((t) => systemMessageRoute(t).room);
    expect(
      rooms([
        'Draft Pick Made',
        'Draft Completed',
        'Draft Paused',
        'Draft Resumed',
        'Draft Starting Soon',
        'Draft Start Blocked'
      ])
    ).toEqual(Array(6).fill('draft'));
    expect(rooms(['Trade Accepted', 'Trade Processed', 'Trade Vetoed', 'Trade Deadline Passed'])).toEqual(
      Array(4).fill('trades')
    );
    expect(rooms(['Waivers Processed', 'Player News Alert'])).toEqual(['waivers-news', 'waivers-news']);
    expect(
      rooms([
        'Stat Correction Applied',
        'Season Completed',
        'Achievement Earned',
        'Model Power Rankings',
        'Member Joined',
        'Member Left',
        'Agent Seat Changed',
        'Settings Changed',
        'Something New'
      ])
    ).toEqual(Array(9).fill('league'));
  });

  it('also posts week finals to every matchup room, and only those', () => {
    const withMatchups = Object.entries(SYSTEM_MESSAGE_ROUTES)
      .filter(([, r]) => r.matchupRooms === true)
      .map(([t]) => t);
    expect(withMatchups).toEqual(['Week Provisionally Final', 'Week Official Final']);
    expect(Object.keys(MATCHUP_ROOM_TEMPLATES)).toEqual(withMatchups);
    expect(systemMessageRoute('Week Official Final')).toEqual({ room: 'league', matchupRooms: true });
  });

  it('renders the matchup room line, a close game being a moment', () => {
    const names: Record<string, string> = { 'team-1': 'Alpha', 'team-2': 'Bravo' };
    const options = { teamName: (id: string) => names[id] ?? null };
    const line = { homeTeamId: 'team-1', awayTeamId: 'team-2', homeScore: 101.456, awayScore: 99 };
    expect(renderMatchupRoomLine('Week Provisionally Final', line, options)).toEqual({
      text: 'Final (provisional): Alpha 101.46, Bravo 99.',
      moment: true
    });
    expect(
      renderMatchupRoomLine(
        'Week Provisionally Final',
        { ...line, homeScore: 99 + CLOSE_MATCHUP_MARGIN },
        options
      )?.moment
    ).toBe(false);
    expect(renderMatchupRoomLine('Week Official Final', line, options)).toEqual({
      text: 'Official: Alpha 101.46, Bravo 99. This room is now archived.',
      moment: false
    });
    expect(renderMatchupRoomLine('Week Official Final', { homeTeamId: 'team-9' }, options)).toEqual({
      text: 'This matchup is official. This room is now archived.',
      moment: false
    });
    expect(renderMatchupRoomLine('Draft Completed', line, options)).toBeNull();
  });
});
