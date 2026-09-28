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
    }
  ],
  get_chat: [
    { label: 'newest first', path: `${CHAT}?limit=5`, status: 200 },
    { label: 'bad cursor', path: `${CHAT}?after=nope`, status: 400 },
    { label: 'outsider', path: CHAT, init: { token: outsider }, status: 403 }
  ],
  get_realtime_token: [
    { label: 'realtime off', path: '/api/v1/leagues/lg-1/realtime', status: 200 },
    { label: 'outsider', path: '/api/v1/leagues/lg-1/realtime', init: { token: outsider }, status: 403 }
  ]
};
