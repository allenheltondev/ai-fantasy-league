import type { Clock } from '@fantasy/core';
import { diffPlayers, type PlayerChange } from '@fantasy/data';
import { inSyncScope, toProfile } from '../players/profile.js';
import type { SyncedPlayer } from '../repos/reference.js';
import { mapLimit, type JobDeps, type JobResult } from './deps.js';

/**
 * Player sync (1–2× a day). Pulls the Sleeper universe through the DataProvider, diffs it against
 * the stored source records, and upserts only what changed into the `PLAYER#` partition and the
 * GSI1 name index. Status, injury, team, and depth-chart changes become `Player Status Changed`
 * events (one per player). The first sync stores everything and emits nothing.
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
  const diff = diffPlayers(previous, scoped);

  const updatedAt = now.toISOString();
  const records: SyncedPlayer[] = diff.upserts.flatMap((source) => {
    const player = toProfile(source, updatedAt);
    return player === null ? [] : [{ player, source }];
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
    deps.events.publish('Player Status Changed', {
      playerId: player.id,
      name: player.name,
      team: player.team,
      position: player.position,
      changes: changes.map((c) => ({ field: c.field, from: c.from, to: c.to })),
      changedAt: updatedAt
    })
  );

  if (records.length > 0) deps.directory.invalidate();
  const result: JobResult = {
    status: 'ok',
    fetched: fetched.length,
    inScope: scoped.length,
    upserted: records.length,
    statusChanges: alerts.length,
    removed: diff.removed.length
  };
  deps.log.info('player sync finished', result);
  return result;
}
