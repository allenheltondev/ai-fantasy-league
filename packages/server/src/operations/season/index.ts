import { getMatchupOutlook } from './get-matchup-outlook.js';
import { getRoster } from './get-roster.js';
import { setLineup } from './set-lineup.js';

/** The season loop: rosters and lineups (#52). Matchups and standings live with the league reads. */
export const seasonOperations = [getRoster, setLineup, getMatchupOutlook];
