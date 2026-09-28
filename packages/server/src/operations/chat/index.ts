import { getChat } from './get-chat.js';
import { getRealtimeToken } from './get-realtime-token.js';
import { postMessage } from './post-message.js';

/** Group chat and realtime (#68, #69). */
export const chatOperations = [getChat, postMessage, getRealtimeToken];
