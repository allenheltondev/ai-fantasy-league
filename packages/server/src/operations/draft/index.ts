import { getDraftBoard } from './get-draft-board.js';
import { makeDraftPick } from './make-draft-pick.js';
import { pauseDraft, resumeDraft } from './pause-draft.js';
import { startDraft } from './start-draft.js';

/** The draft (#46, #47): start it, read the board, pick, and pause or resume the clock. */
export const draftOperations = [startDraft, getDraftBoard, makeDraftPick, pauseDraft, resumeDraft];
