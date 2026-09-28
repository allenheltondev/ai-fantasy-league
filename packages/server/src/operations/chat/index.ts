import { getChat } from './get-chat.js';
import { getRealtimeToken } from './get-realtime-token.js';
import { postMessage } from './post-message.js';
import { listChatRooms, markRoomRead } from './rooms.js';

/** Chat rooms and realtime (#68, #69, #144). */
export const chatOperations = [getChat, postMessage, listChatRooms, markRoomRead, getRealtimeToken];
