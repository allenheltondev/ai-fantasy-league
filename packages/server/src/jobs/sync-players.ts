import type { Clock } from '@fantasy/core';
import { diffPlayers, type PlayerChange, type Player as SourcePlayer } from '@fantasy/data';
import type { EventDetailOf } from '../events/details.js';
import type { Player, StatusSource } from '../players/model.js';
import { inSyncScope, toProfile } from '../players/profile.js';
import type { SyncedPlayer } from '../repos/reference.js';
import { mapLimit, type JobDeps, type JobResult } from './deps.js';

/**
 * Player sync (1–2× a day). Pulls the Sleeper universe through the DataProvider, diffs it against
 * the stored source records, and upserts only what changed into the `PLAYER#` partition and the
 * GSI1 name index. Status, injury, team, and depth-chart changes become `Player Status Changed`
 * events (one per player). The first sync stores everything and emits nothing.
 *
 * Game-day statuses win (#200): a player whose injury status came from ESPN's game-day report
 * (`syncGameDayInjuries`) keeps it until the end of that NFL week, so Sleeper's slower feed cannot
 * revert an inactive to "Questionable" in the meantime; his other fields still sync.
 */
export async function syncPlayers(
  deps: Pick<JobDeps, 'provider' | 'reference' | 'events' | 'directory' | 'log'>,
  clock: Clock
): Promise<JobResult> {
  const now = clock.now();
  const [fetched, previous] = await Promise.all([
    deps.provider.getPlayers(now),
    deps.reference.playerSync.listSources()
  ]);
  const stored = new Set(previous.map((p) => p.id));
  const scoped = fetched.filter((p) => inSyncScope(p, stored));
  const firstDiff = diffPlayers(previous, scoped);
  const storedProfiles = await profilesOf(
    deps,
    firstDiff.upserts.filter((p) => stored.has(p.id)).map((p) => p.id)
  );
  const held = new Map([...storedProfiles].filter(([, player]) => isGameDayHeld(player, now)));
  const diff = held.size === 0 ? firstDiff : diffPlayers(previous, pinGameDay(scoped, previous, held));

  const updatedAt = now.toISOString();
  const records: SyncedPlayer[] = diff.upserts.flatMap((source) => {
    const player = toProfile(source, updatedAt);
    if (player === null) return [];
    const gameDay = held.get(source.id);
    const profile = gameDay === undefined ? player : { ...player, ...gameDayMarkers(gameDay) };
    return [{ player: keepInjuryNote(profile, storedProfiles.get(source.id)), source }];
  });
  await deps.reference.playerSync.upsert(records);

  const byPlayer = new Map<string, PlayerChange[]>();
  for (const change of diff.changes) {
    const list = byPlayer.get(change.playerId) ?? [];
    list.push(change);
    byPlayer.set(change.playerId, list);
  }
  const profiles = new Map(records.map((r) => [r.player.id, r.player]));
  const alerts = [...byPlayer.entries()].flatMap(([playerId, changes]) => {
    const player = profiles.get(playerId);
    return player === undefined ? [] : [{ player, changes }];
  });
  await mapLimit(alerts, 10, ({ player, changes }) =>
    deps.events.publish('Player Status Changed', statusChangedDetail(player, changes, updatedAt))
  );

  if (records.length > 0) deps.directory.invalidate();
  const result: JobResult = {
    status: 'ok',
    fetched: fetched.length,
    inScope: scoped.length,
    upserted: records.length,
    statusChanges: alerts.length,
    removed: diff.removed.length,
    gameDayHeld: held.size
  };
  deps.log.info('player sync finished', result);
  return result;
}

/** The stored profiles of `ids`, by id. */
async function profilesOf(
  deps: Pick<JobDeps, 'reference'>,
  ids: readonly string[]
): Promise<Map<string, Player>> {
  if (ids.length === 0) return new Map();
  const records = await deps.reference.playerSync.getMany(ids);
  return new Map(records.map(({ player }) => [player.id, player] as const));
}

/**
 * ESPN's injury note (`syncGameDayInjuries`) stays on the rebuilt profile while the designation it
 * explains stands; a changed or cleared designation drops it.
 */
function keepInjuryNote(player: Player, stored: Player | undefined): Player {
  const note = stored?.injuryNote;
  return note !== undefined && player.injuryStatus !== null && player.injuryStatus === stored?.injuryStatus
    ? { ...player, injuryNote: note }
    : player;
}

/** Whether a stored game-day status (#200) still outranks Sleeper at `now`. */
export function isGameDayHeld(player: Player, now: Date): boolean {
  return (
    player.statusSource === 'espn_gameday' &&
    player.statusHeldUntil !== undefined &&
    Date.parse(player.statusHeldUntil) > now.getTime()
  );
}

function gameDayMarkers(player: Player): Pick<Player, 'statusSource' | 'statusAsOf' | 'statusHeldUntil'> {
  return {
    statusSource: 'espn_gameday',
    ...(player.statusAsOf === undefined ? {} : { statusAsOf: player.statusAsOf }),
    ...(player.statusHeldUntil === undefined ? {} : { statusHeldUntil: player.statusHeldUntil })
  };
}

/** Sleeper's records with each held player's injury status put back to the stored (game-day) one. */
function pinGameDay(
  fetched: readonly SourcePlayer[],
  previous: readonly SourcePlayer[],
  held: ReadonlyMap<string, Player>
): SourcePlayer[] {
  const before = new Map(previous.map((p) => [p.id, p]));
  return fetched.map((p) => {
    const stored = held.has(p.id) ? before.get(p.id) : undefined;
    if (stored === undefined) return p;
    const { injuryStatusRaw: _raw, ...rest } = p;
    return {
      ...rest,
      injuryStatus: stored.injuryStatus,
      ...(stored.injuryStatusRaw === undefined ? {} : { injuryStatusRaw: stored.injuryStatusRaw })
    };
  });
}

/** The `Player Status Changed` detail: one player's status, injury, team, or depth-chart changes. */
export function statusChangedDetail(
  player: Player,
  changes: readonly PlayerChange[],
  changedAt: string,
  source: StatusSource = 'sleeper'
): EventDetailOf<'Player Status Changed'> {
  return {
    playerId: player.id,
    name: player.name,
    team: player.team,
    position: player.position,
    changes: changes.map((c) => ({ field: c.field, from: c.from, to: c.to })),
    changedAt,
    source
  };
}
