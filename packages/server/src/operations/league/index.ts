import { createInvite } from './create-invite.js';
import { createLeague } from './create-league.js';
import { deleteLeague } from './delete-league.js';
import { getInvite } from './get-invite.js';
import { getLeague } from './get-league.js';
import { getLeagueState } from './get-league-state.js';
import { getMatchup } from './get-matchup.js';
import { getStandings } from './get-standings.js';
import { joinLeague } from './join-league.js';
import { leaveLeague } from './leave-league.js';
import { listInvites } from './list-invites.js';
import { listMyLeagues } from './list-my-leagues.js';
import { removeMember } from './remove-member.js';
import { renameTeam } from './rename-team.js';
import { revokeInvite } from './revoke-invite.js';
import { setSeatType } from './set-seat-type.js';
import { transferCommissioner } from './transfer-commissioner.js';
import { updateLeagueSettings } from './update-league-settings.js';

/** League lifecycle: creation, membership, invites, settings, and the league-state reads. */
export const leagueOperations = [
  createLeague,
  listMyLeagues,
  getLeague,
  getLeagueState,
  updateLeagueSettings,
  createInvite,
  listInvites,
  revokeInvite,
  getInvite,
  joinLeague,
  leaveLeague,
  removeMember,
  transferCommissioner,
  setSeatType,
  renameTeam,
  deleteLeague,
  getStandings,
  getMatchup
];
