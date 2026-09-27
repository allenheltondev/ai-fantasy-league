import { createTaskKindRegistry, type TaskKind } from './kinds.js';
import { lineupTask } from './lineup.js';
import { noopTask } from './noop.js';

/**
 * Task kinds the runtime ships with. Feature streams append theirs here (draft_pick, waivers,
 * trade_response, chat_reply, chat_moment); the router starts emitting a trigger's tasks as soon as
 * its kind is registered.
 */
export const DEFAULT_TASK_KINDS: readonly TaskKind[] = [lineupTask, noopTask];

export const defaultTaskKinds = createTaskKindRegistry(DEFAULT_TASK_KINDS);
