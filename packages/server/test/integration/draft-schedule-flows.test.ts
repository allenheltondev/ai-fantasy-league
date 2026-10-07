import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postSystemMessage } from '../../src/chat/system-messages.js';
import { handleLeagueEvent } from '../../src/events/handlers.js';
import { draftReminderScheduleName, draftStartScheduleName } from '../../src/league/draft-schedule.js';
import { registry } from '../../src/operations/index.js';
import { fixtureDraftPool } from '../../src/players/fixtures.js';
import { createHarness, type Harness } from '../support/harness.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE, BOB, CAROL, seedLeague } from '../support/leagues.js';

/**
 * The scheduled draft over HTTP (DynamoDB Local): setting, moving, and clearing `draft.scheduledAt`
 * schedules, moves, and cancels the start and its reminder; the start handler starts the draft,
 * refuses (and says why in chat) while a seat is open, and ignores stale fires; a manual start
 * supersedes the schedule; and the lobby shows who is in the draft room.
 */

const L = 'lg-sched';
const M = 'lg-sched-manual';
let h: Harness;
let alice: Caller;
let bob: Caller;
let carol: Caller;

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const now = () => h.clock.now().getTime();
const events = (type: string) => h.events.events.filter((e) => e.detailType === type);
const schedules = (name: string) =>
  events('Schedule Event').filter((e) => (e.detail as { name?: string }).name === name);
const cancels = () => events('Cancel Scheduled Event').map((e) => (e.detail as { name: string }).name);
const setTime = (caller: Caller, leagueId: string, draft: Record<string, unknown>) =>
  caller.patch(`/leagues/${leagueId}/settings`, { changes: { draft } });

let seq = 0;
const fire = (detailType: string, leagueId: string, scheduledAt: string) =>
  handleLeagueEvent(h.services, {
    id: `sched-${++seq}`,
    source: 'fantasy',
    'detail-type': detailType,
    detail: { leagueId, scheduledAt }
  });

beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo', registry, players: fixtureDraftPool });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  carol = as(h, CAROL);
  await seedLeague(h.repos, { id: L, owners: [ALICE, BOB] });
  await seedLeague(h.repos, { id: M, owners: [ALICE] });
});
afterAll(() => h.close());

describe('scheduled draft (DynamoDB Local)', () => {
  let first: string;

  it('schedules the start and a reminder ten minutes before, stored in UTC', async () => {
    first = iso(now() + 2 * HOUR);
    // Written with a zone offset, stored as UTC.
    const local = '2026-09-10T10:00:00-04:00';
    const res = await setTime(alice, L, { scheduledAt: local, orderMode: 'random' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(data(res)).toMatchObject({
      changedPaths: ['draft.orderMode', 'draft.scheduledAt'],
      settings: { draft: { scheduledAt: first, orderMode: 'random' } }
    });
    expect(schedules(draftStartScheduleName(L)).at(-1)?.detail).toMatchObject({
      at: first,
      whenPast: 'send',
      event: { detailType: 'Draft Start Scheduled', detail: { leagueId: L, scheduledAt: first } }
    });
    expect(schedules(draftReminderScheduleName(L)).at(-1)?.detail).toMatchObject({
      at: iso(Date.parse(first) - 10 * 60_000),
      whenPast: 'skip',
      event: { detailType: 'Draft Reminder Due', detail: { leagueId: L, scheduledAt: first } }
    });
    const state = data<{ deadlines: { draftScheduledAt: string | null } }>(
      await bob.get(`/leagues/${L}/state`)
    );
    expect(state.deadlines.draftScheduledAt).toBe(first);
  });

  it('refuses a time in the past or too far ahead, and anyone but the commissioner', async () => {
    const past = await setTime(alice, L, { scheduledAt: iso(now() - 1000) });
    expect(past.body).toMatchObject({
      error: { code: 'INVALID_SETTINGS', details: { issues: [{ code: 'DRAFT_TIME_IN_PAST' }] } }
    });
    const far = await setTime(alice, L, { scheduledAt: iso(now() + 61 * 24 * HOUR) });
    expect(far.body).toMatchObject({ error: { details: { issues: [{ code: 'DRAFT_TIME_TOO_FAR' }] } } });
    expect(errorCode(await setTime(bob, L, { scheduledAt: iso(now() + HOUR) }))).toBe('FORBIDDEN');
    expect((await h.repos.leagues.get(L))?.settings.draft.scheduledAt).toBe(first);
  });

  it('moves the schedule under the same names, and a stale fire does nothing', async () => {
    const before = schedules(draftStartScheduleName(L)).length;
    const moved = iso(now() + 5 * 60_000);
    expect((await setTime(alice, L, { scheduledAt: moved })).status).toBe(200);
    expect(schedules(draftStartScheduleName(L))).toHaveLength(before + 1);
    // Five minutes out: the reminder time has passed, so it is cancelled rather than moved.
    expect(cancels()).toContain(draftReminderScheduleName(L));
    h.clock.set(new Date(Date.parse(first)));
    expect(await fire('Draft Start Scheduled', L, first)).toEqual({ handled: true, outcome: 'stale' });
    expect(await fire('Draft Reminder Due', L, first)).toEqual({ handled: true, outcome: 'stale' });
    expect((await h.repos.leagues.get(L))?.phase).toBe('setup');
    // Put it back two hours out for the rest of the story.
    h.clock.set(new Date('2026-09-10T12:00:00.000Z'));
    expect((await setTime(alice, L, { scheduledAt: first })).status).toBe(200);
  });

  it('reminds the league ten minutes before, in chat and to open lobbies', async () => {
    h.clock.set(new Date(Date.parse(first) - 10 * 60_000));
    expect(await fire('Draft Reminder Due', L, first)).toEqual({ handled: true, outcome: 'reminded' });
    const soon = events('Draft Starting Soon').at(-1);
    expect(soon?.detail).toEqual({ leagueId: L, scheduledAt: first, minutes: 10 });
    const chat = await postSystemMessage(h.services, {
      id: 'soon-1',
      source: 'fantasy',
      'detail-type': 'Draft Starting Soon',
      detail: soon?.detail
    });
    expect(chat).toMatchObject({
      status: 'posted',
      message: { text: 'The draft starts in 10 minutes. Set your queue in the draft room!' }
    });
  });

  it('waits when a human seat is open, and tells the commissioner why', async () => {
    const team = await h.repos.teams.get(L, 'team-3');
    await h.repos.teams.update({ ...team!, seatType: 'human' });
    // Fired a little early (the scheduler is not exact): it re-schedules and waits.
    h.clock.set(new Date(Date.parse(first) - 1000));
    expect(await fire('Draft Start Scheduled', L, first)).toEqual({ handled: true, outcome: 'early' });
    h.clock.set(new Date(Date.parse(first)));
    expect(await fire('Draft Start Scheduled', L, first)).toEqual({ handled: true, outcome: 'blocked' });
    expect((await h.repos.leagues.get(L))?.phase).toBe('setup');
    const blocked = events('Draft Start Blocked').at(-1);
    expect(blocked?.detail).toMatchObject({
      leagueId: L,
      scheduledAt: first,
      commissionerId: 'alice',
      code: 'SEATS_NOT_FILLED',
      fix: expect.stringContaining('set_seat_type')
    });
    const chat = await postSystemMessage(h.services, {
      id: 'blocked-1',
      source: 'fantasy',
      'detail-type': 'Draft Start Blocked',
      detail: blocked?.detail
    });
    expect(chat).toMatchObject({
      status: 'posted',
      message: {
        text: expect.stringMatching(/^The draft could not start at its scheduled time\. 1 human seat/)
      }
    });
    // And by email: the seeded league learned Alice's email when she set the draft time.
    expect(h.events.emails).toEqual([
      expect.objectContaining({
        to: ALICE.email,
        subject: `Your ${(await h.repos.leagues.get(L))?.name} draft did not start`,
        text: expect.stringContaining('set_seat_type')
      })
    ]);
    // A redelivered fire (at-least-once delivery, or a Lambda retry) emails nobody again.
    expect(await fire('Draft Start Scheduled', L, first)).toEqual({ handled: true, outcome: 'blocked' });
    expect(h.events.emails).toHaveLength(1);
    const reverted = await h.repos.teams.get(L, 'team-3');
    await h.repos.teams.update({ ...reverted!, seatType: 'agent' });
  });

  it('starts the draft at a new time through the same path as start_draft', async () => {
    const later = iso(Date.parse(first) + HOUR);
    expect((await setTime(alice, L, { scheduledAt: later })).status).toBe(200);
    h.clock.set(new Date(Date.parse(later)));
    const turns = events('Draft Turn Started').length;
    expect(await fire('Draft Start Scheduled', L, later)).toEqual({ handled: true, outcome: 'started' });
    const league = await h.repos.leagues.get(L);
    expect(league).toMatchObject({ phase: 'drafting', deadlines: { draftStartsAt: later } });
    const draft = await h.repos.drafts.get(L);
    expect(draft?.state.teamIds).toHaveLength(8);
    expect(events('Draft Turn Started')).toHaveLength(turns + 1);
    expect(await h.repos.agents.listSeats(L)).toHaveLength(6);
    // Agent seats filled by the scheduled start are the system's doing.
    expect((await h.repos.agents.listSeats(L))[0]?.updatedBy).toBe('system');
    // A repeat of the fire (at-least-once delivery) changes nothing.
    expect(await fire('Draft Start Scheduled', L, later)).toEqual({ handled: false, outcome: 'ignored' });
    expect(await fire('Draft Reminder Due', L, later)).toEqual({ handled: false, outcome: 'ignored' });
    const state = data<{ deadlines: { draftScheduledAt: string | null } }>(
      await bob.get(`/leagues/${L}/state`)
    );
    expect(state.deadlines.draftScheduledAt).toBeNull();
  });

  it('lets a manual start supersede the schedule; clearing the time cancels it', async () => {
    const at = iso(now() + HOUR);
    expect((await setTime(alice, M, { scheduledAt: at })).status).toBe(200);
    expect((await setTime(alice, M, { scheduledAt: null })).status).toBe(200);
    expect(cancels().slice(-2)).toEqual([draftStartScheduleName(M), draftReminderScheduleName(M)]);
    expect((await setTime(alice, M, { scheduledAt: at })).status).toBe(200);
    const started = await alice.post(`/leagues/${M}/draft/start`, {});
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(cancels().slice(-2)).toEqual([draftStartScheduleName(M), draftReminderScheduleName(M)]);
    h.clock.set(new Date(Date.parse(at)));
    expect(await fire('Draft Start Scheduled', M, at)).toEqual({ handled: false, outcome: 'ignored' });
    expect(
      await handleLeagueEvent(h.services, {
        id: 'bad',
        source: 'fantasy',
        'detail-type': 'Draft Start Scheduled',
        detail: { leagueId: M }
      })
    ).toEqual({ handled: false });
  });

  it('schedules a draft set when the league is created, and checks its time', async () => {
    const at = iso(now() + 3 * HOUR);
    const created = await carol.post('/leagues', {
      name: 'Scheduled',
      settings: { draft: { scheduledAt: at } }
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = data<{ id: string }>(created).id;
    expect(schedules(draftStartScheduleName(id)).at(-1)?.detail).toMatchObject({ at });
    expect((await h.repos.leagues.get(id))?.commissionerEmail).toBe(CAROL.email);
    const past = await carol.post('/leagues', {
      name: 'Too late',
      settings: { draft: { scheduledAt: iso(now() - HOUR) } }
    });
    expect(past.body).toMatchObject({ error: { code: 'INVALID_SETTINGS' } });
  });
});

describe('draft lobby (DynamoDB Local)', () => {
  const LOBBY = 'lg-lobby';
  const lobby = (caller: Caller) => caller.post(`/leagues/${LOBBY}/draft/lobby`);
  interface Lobby {
    phase: string;
    scheduledAt: string | null;
    serverTime: string;
    order: { teamId: string }[] | null;
    teams: { teamId: string; here: boolean; seatType: string }[];
    commissionerHere: boolean;
    canStart: boolean;
  }

  beforeAll(async () => {
    h.clock.set(new Date('2026-09-10T12:00:00.000Z'));
    await seedLeague(h.repos, { id: LOBBY, owners: [ALICE, BOB] });
  });

  it('shows who is in the draft room, the order, and whether you can start', async () => {
    const at = iso(now() + HOUR);
    expect((await setTime(alice, LOBBY, { scheduledAt: at })).status).toBe(200);
    const first = data<Lobby>(await lobby(bob));
    expect(first).toMatchObject({
      phase: 'setup',
      scheduledAt: at,
      serverTime: iso(now()),
      commissionerHere: false,
      canStart: false
    });
    expect(first.order?.map((t) => t.teamId)).toEqual(first.teams.map((t) => t.teamId));
    const here = (l: Lobby) => l.teams.filter((t) => t.here).map((t) => t.teamId);
    // Bob is here, and agent seats always are; Alice has not opened the room.
    expect(here(first)).toEqual(['team-2', 'team-3', 'team-4', 'team-5', 'team-6', 'team-7', 'team-8']);
    const mine = data<Lobby>(await lobby(alice));
    expect(mine).toMatchObject({ commissionerHere: true, canStart: true });
    expect(here(mine)).toContain('team-1');
    // A check-in counts for 45 seconds.
    h.clock.advance(46_000);
    expect(here(data<Lobby>(await lobby(alice)))).not.toContain('team-2');
    expect(errorCode(await lobby(carol))).toBe('FORBIDDEN');
  });

  it('hides a shuffled order until the draft starts, and closes after the draft', async () => {
    expect((await setTime(alice, LOBBY, { orderMode: 'random' })).status).toBe(200);
    expect(data<Lobby>(await lobby(bob)).order).toBeNull();
    expect((await alice.post(`/leagues/${LOBBY}/draft/start`, {})).status).toBe(200);
    const live = data<Lobby>(await lobby(bob));
    expect(live).toMatchObject({ phase: 'drafting', scheduledAt: null, canStart: false });
    expect(live.order).toHaveLength(8);
    const league = await h.repos.leagues.get(LOBBY);
    await h.repos.leagues.update({ ...league!, phase: 'regular_season', week: 1 });
    expect(errorCode(await lobby(bob))).toBe('PHASE_NOT_ALLOWED');
  });
});
