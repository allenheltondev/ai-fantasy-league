import type { RequestOptions } from './harness.js';
import { signIdToken } from './tokens.js';

/** Contract cases for chat and realtime, against `lg-1` (Allen, the harness's default user, is commissioner). */

interface Case {
  label: string;
  path: string;
  init?: RequestOptions;
  status: number;
}

const outsider = signIdToken({ sub: 'chat-outsider', name: 'Olive' });
const CHAT = '/api/v1/leagues/lg-1/chat/messages';
const ROOMS = '/api/v1/leagues/lg-1/chat/rooms';

export const CHAT_CASES: Record<string, Case[]> = {
  post_message: [
    {
      label: 'posted with a mention',
      path: CHAT,
      init: { body: { text: 'Good luck, @team-2!' }, idempotencyKey: 'contract-chat-1' },
      status: 200
    },
    {
      label: 'empty',
      path: CHAT,
      init: { body: { text: ' ' }, idempotencyKey: 'contract-chat-2' },
      status: 400
    },
    {
      label: 'outsider',
      path: CHAT,
      init: { body: { text: 'hi' }, idempotencyKey: 'contract-chat-3', token: outsider },
      status: 403
    },
    {
      label: 'a DM',
      path: CHAT,
      init: { body: { roomId: 'dm-team-1-team-2', text: 'trade?' }, idempotencyKey: 'contract-chat-4' },
      status: 200
    },
    {
      label: 'someone else’s DM',
      path: CHAT,
      init: { body: { roomId: 'dm-team-2-team-3', text: 'hi' }, idempotencyKey: 'contract-chat-5' },
      status: 403
    },
    {
      label: 'no such room',
      path: CHAT,
      init: { body: { roomId: 'general', text: 'hi' }, idempotencyKey: 'contract-chat-6' },
      status: 404
    }
  ],
  list_chat_rooms: [
    { label: 'rooms', path: ROOMS, status: 200 },
    { label: 'outsider', path: ROOMS, init: { token: outsider }, status: 403 }
  ],
  mark_room_read: [
    {
      label: 'read',
      path: `${ROOMS}/draft/read`,
      init: { body: {}, idempotencyKey: 'contract-chat-7' },
      status: 200
    },
    {
      label: 'no such room',
      path: `${ROOMS}/general/read`,
      init: { body: {}, idempotencyKey: 'contract-chat-8' },
      status: 404
    }
  ],
  get_chat: [
    { label: 'newest first', path: `${CHAT}?limit=5`, status: 200 },
    { label: 'a room, compact', path: `${CHAT}?roomId=draft&detail=false`, status: 200 },
    { label: 'bad cursor', path: `${CHAT}?after=nope`, status: 400 },
    { label: 'outsider', path: CHAT, init: { token: outsider }, status: 403 }
  ],
  get_realtime_token: [
    { label: 'realtime off', path: '/api/v1/leagues/lg-1/realtime', status: 200 },
    { label: 'outsider', path: '/api/v1/leagues/lg-1/realtime', init: { token: outsider }, status: 403 }
  ]
};
