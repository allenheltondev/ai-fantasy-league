import { hashString } from '@fantasy/core';
import { normalizeName, uniqueNonEmpty, type Player } from '@fantasy/data';

const FIRST = [
  'Avery',
  'Blake',
  'Cameron',
  'Dakota',
  'Emerson',
  'Finley',
  'Grayson',
  'Harper',
  'Indigo',
  'Jordan',
  'Kendall',
  'Logan',
  'Marlowe',
  'Noel',
  'Oakley',
  'Parker',
  'Quinn',
  'Reese',
  'Sawyer',
  'Tatum',
  'Umber',
  'Vaughn',
  'Wren',
  'Xander',
  'Yael',
  'Zion',
  'Arden',
  'Bellamy',
  'Corin',
  'Darby',
  'Ellis',
  'Frankie'
] as const;

const LAST = [
  'Ashford',
  'Brightwater',
  'Coldbrook',
  'Dunmore',
  'Everhart',
  'Fairholm',
  'Glenwood',
  'Hollowell',
  'Ironside',
  'Juniper',
  'Kingsley',
  'Larkspur',
  'Merriweather',
  'Northcott',
  'Oakridge',
  'Pembrook',
  'Quarry',
  'Redfern',
  'Stonebridge',
  'Thornbury',
  'Underhill',
  'Vantage',
  'Westbrook',
  'Yarrow',
  'Alder',
  'Birchwood',
  'Crane',
  'Driftwood',
  'Elmstead',
  'Foxglove',
  'Greystone',
  'Hawthorne'
] as const;

/**
 * Maps real player names to stable pseudonyms, so agent-facing data does not name the 2025 players a
 * model might remember. Different ids never share a pseudonym (a numeral suffix breaks collisions).
 * Pseudonyms are assigned in player-id order by `assign`, so the same seed and player universe always
 * give the same names, whatever order agents later ask in. Team defenses keep their names: a team is not a
 * memorable outcome on its own. See docs/sim.md for what this does and does not hide.
 */
export class PlayerAnonymizer {
  readonly #seed: string;
  readonly #byId = new Map<string, { first: string; last: string }>();
  readonly #taken = new Set<string>();

  constructor(seed: string | number = 'anonymize') {
    this.#seed = String(seed);
  }

  /** Assigns pseudonyms to `playerIds` in sorted order (ids already assigned keep theirs). */
  assign(playerIds: Iterable<string>): void {
    for (const id of [...playerIds].sort()) this.pseudonym(id);
  }

  /** The pseudonym for a player id, assigned on first use. */
  pseudonym(playerId: string): { first: string; last: string; name: string } {
    let entry = this.#byId.get(playerId);
    if (!entry) {
      const h = hashString(`${this.#seed}:${playerId}`);
      const first = FIRST[h % FIRST.length] as string;
      const baseLast = LAST[Math.floor(h / FIRST.length) % LAST.length] as string;
      let last = baseLast;
      for (let n = 2; this.#taken.has(`${first} ${last}`); n++) last = `${baseLast} ${toRoman(n)}`;
      this.#taken.add(`${first} ${last}`);
      entry = { first, last };
      this.#byId.set(playerId, entry);
    }
    return { ...entry, name: `${entry.first} ${entry.last}` };
  }

  /** Copies of the players with names (and search names) replaced. DEF players are returned unchanged. */
  anonymizeAll(players: readonly Player[]): Player[] {
    this.assign(players.map((p) => p.id));
    return players.map((p) => this.anonymize(p));
  }

  /** A copy of the player with his name (and search names) replaced. DEF players are returned unchanged. */
  anonymize(player: Player): Player {
    if (player.position === 'DEF') return player;
    const { first, last, name } = this.pseudonym(player.id);
    const out: Player = {
      ...player,
      name,
      firstName: first,
      lastName: last,
      searchNames: uniqueNonEmpty([normalizeName(name)])
    };
    delete out.gsisId;
    return out;
  }
}

function toRoman(n: number): string {
  const table: [number, string][] = [
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I']
  ];
  let out = '';
  let rest = n;
  for (const [value, numeral] of table) {
    while (rest >= value) {
      out += numeral;
      rest -= value;
    }
  }
  return out;
}
