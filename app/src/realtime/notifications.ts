import type { ToastVariant } from '@readysetcloud/ui';
import type { ChatMessage } from '../chat/api';
import { notificationHref, type AppNotification } from '../notifications/types';
import { CHAT_EVENT, type LeagueEvent } from './leagueEvents';

/**
 * Which live events deserve a toast, and what it says. The relay (packages/server/src/realtime/
 * relay.ts) passes each event's detail through, so the toast can name the players; the page that
 * owns the data still re-reads it through the API.
 *
 * News about your own team (trade offers and answers, waiver results, your turn in the draft) comes
 * as your inbox's `Notification Created` (#165), so the toast and the bell say the same thing and
 * the toast can mark the item delivered. League news you're not part of (a trade up for review or
 * vetoed) and chat mentions and DMs come straight from their events.
 */
export const NOTIFICATION_EVENT = 'Notification Created';

export const NOTIFY_EVENTS = [NOTIFICATION_EVENT, 'Trade Accepted', 'Trade Vetoed', CHAT_EVENT] as const;

export interface Notification {
  message: string;
  variant: ToastVariant;
  /** Chat: the room the message is in, so the toast can open it. */
  roomId?: string;
  /** An inbox item: where it leads, and its id to mark delivered (and read, when opened). */
  inbox?: { id: string; leagueId: string; href: string };
}

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const VARIANTS: Record<string, ToastVariant> = {
  trade_accepted: 'success',
  trade_processed: 'success',
  waiver_won: 'success',
  trade_rejected: 'warning',
  trade_vetoed: 'warning',
  trade_expired: 'warning',
  waiver_lost: 'warning'
};

/** Player news and routine status changes (#200) wait quietly in the inbox: only the bell moves. */
const QUIET_KINDS = new Set(['player_news', 'player_status']);

function inbox(detail: Record<string, unknown>, you: string): Notification | null {
  const n = detail.notification as AppNotification | undefined;
  if (n === undefined || typeof n.id !== 'string' || n.teamId !== you || n.target === undefined) return null;
  const urgent = n.urgent === true;
  if (!urgent && QUIET_KINDS.has(n.kind)) return null;
  return {
    message: `${n.title}. ${n.body}`,
    variant: urgent ? 'error' : (VARIANTS[n.kind] ?? 'info'),
    inbox: { id: n.id, leagueId: n.leagueId, href: notificationHref(n) }
  };
}

/** Trades between other teams that the whole league hears about. */
function leagueTrade(type: string, detail: Record<string, unknown>, you: string): Notification | null {
  if (detail.fromTeamId === you || detail.toTeamId === you) return null; // Your inbox has it.
  if (type === 'Trade Accepted') {
    return detail.review === 'league_vote'
      ? { message: 'A trade was accepted and is up for league review.', variant: 'info' }
      : null;
  }
  return { message: 'A trade was vetoed.', variant: 'info' };
}

function mention(detail: Record<string, unknown>, you: string): Notification | null {
  const message = detail.message as ChatMessage | undefined;
  if (message === undefined || message.author?.teamId === you) return null;
  const roomId = message.roomId ?? 'trash-talk';
  const who = message.author?.name ?? 'Someone';
  // A DM reaches only its two teams' topics: any DM you receive is addressed to you.
  if (roomId.startsWith('dm-')) {
    return { message: `${who} sent you a message: “${clip(message.text)}”`, variant: 'info', roomId };
  }
  if (!Array.isArray(message.mentionedTeamIds) || !message.mentionedTeamIds.includes(you)) return null;
  return { message: `${who} mentioned you: “${clip(message.text)}”`, variant: 'info', roomId };
}

/** The toast for a live event, or null when it isn't news to you (or you have no team). */
export function notificationFor(event: LeagueEvent, yourTeamId: string | null): Notification | null {
  if (yourTeamId === null || event.detail === undefined) return null;
  if (event.detailType === NOTIFICATION_EVENT) return inbox(event.detail, yourTeamId);
  if (event.detailType === CHAT_EVENT) return mention(event.detail, yourTeamId);
  if (event.detailType === 'Trade Accepted' || event.detailType === 'Trade Vetoed')
    return leagueTrade(event.detailType, event.detail, yourTeamId);
  return null;
}
