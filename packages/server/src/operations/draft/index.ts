import { getDraftBoard } from './get-draft-board.js';
import { checkInDraftLobby } from './lobby.js';
import { getDraftDepth } from './get-draft-depth.js';
import { getDraftReportCard } from './get-draft-report-card.js';
import { makeDraftPick } from './make-draft-pick.js';
import { pauseDraft, resumeDraft } from './pause-draft.js';
import { getDraftQueue, setDraftQueue } from './queue.js';
import { startDraft } from './start-draft.js';

/**
 * The draft (#46, #47, #134, #136): start it, read the board and every team's depth, pick, pause or
 * resume the clock, queue players, and wait in the lobby.
 */
export const draftOperations = [
  startDraft,
  getDraftBoard,
  makeDraftPick,
  pauseDraft,
  resumeDraft,
  getDraftQueue,
  setDraftQueue,
  // Draft research (#136)
  getDraftDepth,
  // The lobby before the draft (#134)
  checkInDraftLobby,
  // Post-draft grades and projected standings
  getDraftReportCard
];
