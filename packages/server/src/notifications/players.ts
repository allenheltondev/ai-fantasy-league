import {
  designationChange,
  isStarterSlot,
  PLAYER_NEWS_WINDOW_MS,
  playerNewsDraft,
  playerStatusDraft,
  type NoticePlayer,
  type NotificationDraft
} from '@fantasy/core';
import type { Services } from '../context.js';
import { eventDetail, type BusEvent } from '../events/bus.js';
import { inSeasonRosters, teamsRostering } from '../players/roster-index.js';
import { seatTenureStart, type League, type Team } from '../repos/types.js';
import { resolveLineup, weekGames } from '../season/lineups.js';
import { deliver, eventTime, type NotificationOutcome } from './consumer.js';

/**
 * Player status and news notifications (#200). `Player Status Changed` and `Player News Alert` are
 * league-less, so the teams they reach come from the roster index: every in-season team a person
 * holds that rosters the player. Each gets an inbox item from core `playerStatusDraft` or
 * `playerNewsDraft`, stored and pushed like every other item (`Notification Created`).
 *
 * Quiet by design: a depth-chart or team move, or the same designation again, reads nothing and
 * writes nothing; news counts only when it is about one player, only for managers who keep player
 * news on, and at most once per player an hour per team.
 */

/** A game this far off or closer is "today's game". */
const TODAY_MS = 12 * 60 * 60 * 1000;

type Deps = Pick<Services, 'repos' | 'events' | 'clock' | 'data'>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export async function writePlayerNotifications(
  services: Deps,
  event: BusEvent
): Promise<NotificationOutcome> {
  const detailType = event['detail-type'];
  const detail = eventDetail(event);
  const news = detailType === 'Player News Alert';
  const ids = news
    ? (Array.isArray(detail.playerIds) ? detail.playerIds : []).filter((id) => typeof id === 'string')
    : [detail.playerId].filter((id) => typeof id === 'string');
  const playerId = ids.length === 1 ? (ids[0] as string) : null;
  // News about several players is a roundup, not news about yours; a status event that did not
  // move a designation (depth chart, team, a repeat) is not news at all.
  if (playerId === null) return { status: 'skipped', reason: 'not_notifiable' };
  const changes = Array.isArray(detail.changes)
    ? (detail.changes as { field: string; from: unknown; to: unknown }[])
    : [];
  if (!news && designationChange(changes) === null) return { status: 'skipped', reason: 'not_notifiable' };

  const createdAt = eventTime(event, services.clock.now());
  const holders = teamsRostering(await inSeasonRosters(services.repos), playerId).filter(
    ({ team }) => team.seatType === 'human' && team.ownerUserId !== null && seatTenureStart(team) <= createdAt
  );
  if (holders.length === 0) return { status: 'skipped', reason: 'nobody' };
  const player = await noticePlayer(services, playerId, detail);

  const outcome: Extract<NotificationOutcome, { status: 'written' }> = {
    status: 'written',
    notifications: [],
    duplicates: 0
  };
  for (const { league, team } of holders) {
    const draft = news
      ? await newsDraft(services, league, team, player, detail, createdAt)
      : await statusDraft(services, league, team, player, changes);
    if (draft === null) continue;
    const result = await deliver(services, league.id, [draft], event, createdAt);
    /* v8 ignore next -- deliver always writes */
    if (result.status !== 'written') continue;
    outcome.notifications.push(...result.notifications);
    outcome.duplicates += result.duplicates;
  }
  return outcome.notifications.length === 0 && outcome.duplicates === 0
    ? { status: 'skipped', reason: 'nobody' }
    : outcome;
}

/** The player as the event names him, filled from the stored record when the event does not. */
async function noticePlayer(
  services: Deps,
  playerId: string,
  detail: Record<string, unknown>
): Promise<NoticePlayer> {
  const name = str(detail.name);
  const position = str(detail.position);
  if (name !== null && position !== null) {
    return { id: playerId, name, position, team: str(detail.team) };
  }
  const stored = await services.repos.players.get(playerId);
  return {
    id: playerId,
    name: stored?.name ?? playerId,
    position: stored?.position ?? '?',
    team: stored?.team ?? null
  };
}

async function statusDraft(
  services: Deps,
  league: League,
  team: Team,
  player: NoticePlayer,
  changes: { field: string; from: unknown; to: unknown }[]
): Promise<NotificationDraft | null> {
  const week = league.week;
  let starter = false;
  let game: { started: boolean; today: boolean } | null = null;
  if (week !== null) {
    const [lineup, games] = await Promise.all([
      resolveLineup(services.repos, team, week),
      weekGames(services.data.reference, league.season, week)
    ]);
    const slot = lineup.entries.find((e) => e.playerId === player.id)?.slot;
    starter = slot !== undefined && isStarterSlot(slot);
    const match = games.find(
      (g) => player.team !== null && (g.homeTeam === player.team || g.awayTeam === player.team)
    );
    if (match !== undefined) {
      const until = Date.parse(match.kickoff) - services.clock.now().getTime();
      game = { started: until <= 0, today: until <= TODAY_MS };
    }
  }
  return playerStatusDraft({ teamId: team.id, player, changes, starter, game });
}

async function newsDraft(
  services: Deps,
  league: League,
  team: Team,
  player: NoticePlayer,
  detail: Record<string, unknown>,
  createdAt: string
): Promise<NotificationDraft | null> {
  const preferences = await services.repos.notifications.getPreferences(team.ownerUserId as string);
  if (!preferences.playerNews) return null;
  // At most one news item per player an hour: the newest items say whether one went out already.
  const since = new Date(Date.parse(createdAt) - PLAYER_NEWS_WINDOW_MS).toISOString();
  const recent = await services.repos.notifications.list(league.id, team.id, {
    limit: 20,
    visibleFrom: since
  });
  const sent = recent.notifications.some(
    (n) => n.kind === 'player_news' && n.target.playerId === player.id && n.createdAt <= createdAt
  );
  if (sent) return null;
  return playerNewsDraft({
    teamId: team.id,
    player,
    title: str(detail.title) ?? 'New story',
    source: str(detail.source) ?? 'news'
  });
}
