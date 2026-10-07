import { getChat } from './get-chat.js';
import { getChatContext } from './get-chat-context.js';
import { getRealtimeToken } from './get-realtime-token.js';
import { postMessage } from './post-message.js';
import { closeDm, listChatRooms, markRoomRead } from './rooms.js';

/** Chat rooms, realtime, and room context packs (#68, #69, #144, #153). */
export const chatOperations = [
  getChat,
  postMessage,
  listChatRooms,
  markRoomRead,
  closeDm,
  getRealtimeToken,
  getChatContext
];
