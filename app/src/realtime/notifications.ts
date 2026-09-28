import type { ToastVariant } from '@readysetcloud/ui';
import type { ChatMessage } from '../chat/api';
import { CHAT_EVENT, type LeagueEvent } from './leagueEvents';

/**
 * Which live events deserve a toast, and what it says. The relay (packages/server/src/realtime/
 * relay.ts) passes each event's detail through, so the toast can name the players; the page that
 * owns the data still re-reads it through the API.
 */
export const NOTIFY_EVENTS = [
  'Waivers Processed',
  'Trade Proposed',
  'Trade Countered',
  'Trade Accepted',
  'Trade Processed',
  'Trade Vetoed',
  CHAT_EVENT
] as const;

export interface Notification {
  message: string;
  variant: ToastVariant;
  /** Chat: the room the message is in, so the toast can open it. */
  roomId?: string;
}

interface Named {
  name?: unknown;
}

const list = (v: unknown): Named[] => (Array.isArray(v) ? (v as Named[]) : []);
const names = (v: unknown) =>
  list(v)
    .map((p) => (typeof p?.name === 'string' ? p.name : null))
    .filter((n): n is string => n !== null)
    .join(', ') || 'nothing';

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function waivers(detail: Record<string, unknown>, you: string): Notification | null {
  const mine = list(detail.awarded).filter((a) => (a as { teamId?: unknown }).teamId === you);
  if (mine.length === 0) return null;
  const won = mine
    .map((a) => {
      const award = a as { player?: Named | null; cost?: unknown };
      const name = typeof award.player?.name === 'string' ? award.player.name : 'a player';
      return typeof award.cost === 'number' && award.cost > 0 ? `${name} ($${award.cost})` : name;
    })
    .join(', ');
  return {
    message:
      mine.length === 1 ? `Waiver claim won: ${won}.` : `You won ${mine.length} waiver claims: ${won}.`,
    variant: 'success'
  };
}

function trade(type: string, detail: Record<string, unknown>, you: string): Notification | null {
  const from = detail.fromTeamId === you;
  const to = detail.toTeamId === you;
  // What you would get and give, from your side of the trade.
  const get = names(from ? detail.toPlayers : detail.fromPlayers);
  const give = names(from ? detail.fromPlayers : detail.toPlayers);
  switch (type) {
    case 'Trade Proposed':
      return to ? { message: `New trade offer: you'd get ${get} for ${give}.`, variant: 'info' } : null;
    case 'Trade Countered':
      return to ? { message: `Counteroffer: you'd get ${get} for ${give}.`, variant: 'info' } : null;
    case 'Trade Accepted':
      if (from) return { message: `Trade accepted! You get ${get} for ${give}.`, variant: 'success' };
      if (to) return null; // You accepted it yourself.
      return detail.review === 'league_vote'
        ? { message: 'A trade was accepted and is up for league review.', variant: 'info' }
        : null;
    case 'Trade Processed':
      return from || to
        ? { message: `Trade complete: ${get} joined your roster.`, variant: 'success' }
        : null;
    default:
      // Trade Vetoed
      if (!from && !to) return { message: 'A trade was vetoed.', variant: 'info' };
      return {
        message:
          detail.voided === true
            ? 'Your trade was cancelled: it no longer works with the current rosters.'
            : 'Your trade was vetoed.',
        variant: 'warning'
      };
  }
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
  if (event.detailType === 'Waivers Processed') return waivers(event.detail, yourTeamId);
  if (event.detailType === CHAT_EVENT) return mention(event.detail, yourTeamId);
  if (event.detailType.startsWith('Trade ')) return trade(event.detailType, event.detail, yourTeamId);
  return null;
}
