import { claimWaiver, previewWaiverClaim } from './claim.js';
import { cancelWaiverClaim, listWaiverClaims, reorderWaiverClaims } from './claims.js';
import { dropPlayer } from './drop.js';
import { listTransactions } from './transactions.js';

/** Waivers and free agency (#55): pickups, claims, drops, and the transactions log. */
export const waiverOperations = [
  claimWaiver,
  previewWaiverClaim,
  listWaiverClaims,
  cancelWaiverClaim,
  reorderWaiverClaims,
  dropPlayer,
  listTransactions
];
