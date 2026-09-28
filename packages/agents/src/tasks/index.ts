import { draftTask } from './draft.js';
import { chatMomentTask, chatReplyTask } from './chat.js';
import { createTaskKindRegistry, type TaskKind } from './kinds.js';
import { lineupTask } from './lineup.js';
import { noopTask } from './noop.js';
import { waiverTask } from './waivers.js';

/**
 * Task kinds the runtime ships with. Feature streams append theirs here (waivers,
 * trade_response, chat_reply, chat_moment); the router starts emitting a trigger's tasks as soon as
 * its kind is registered.
 */
export const DEFAULT_TASK_KINDS: readonly TaskKind[] = [
  draftTask,
  lineupTask,
  noopTask,
  waiverTask,
  chatReplyTask,
  chatMomentTask
];

export const defaultTaskKinds = createTaskKindRegistry(DEFAULT_TASK_KINDS);
