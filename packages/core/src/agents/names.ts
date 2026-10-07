import { z } from 'zod';
import { seededRandom } from '../schedule/random.js';
import type { PersonalityId } from './personalities.js';

/**
 * AI manager names and avatars (#159). Every agent seat has a person-like name ("Marcus Hale",
 * sometimes with a nickname from its personality: `Marcus "Spreadsheet" Hale`) and an avatar seed
 * the SPA hashes into a picture. Both are stored on the seat config when set; seats stored before
 * they existed get a deterministic default from a stable key (the agent id), so no migration.
 * Pure data plus pure functions: every roll takes a `random` source, so tests and replays repeat.
 */

export const MANAGER_NAME_MAX = 40;
export const AVATAR_SEED_MAX = 40;

export const ManagerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MANAGER_NAME_MAX)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'Manager names cannot contain line breaks or control characters.')
  .describe(`The AI manager's name, 1-${MANAGER_NAME_MAX} characters on one line.`);

export const AvatarSeedSchema = z
  .string()
  .trim()
  .min(1)
  .max(AVATAR_SEED_MAX)
  .regex(/^[A-Za-z0-9_-]+$/, 'Avatar seeds use only letters, digits, "-" and "_".')
  .describe(
    `Seed the app hashes into the manager's avatar: 1-${AVATAR_SEED_MAX} letters, digits, "-" or "_".`
  );

/** Realistic, varied first names. Family friendly; no famous football names. */
// prettier-ignore
export const MANAGER_FIRST_NAMES = [
  'Marcus', 'Priya', 'Diego', 'Aisha', 'Tomás', 'Mei', 'Kwame', 'Sofia', 'Jamal', 'Ingrid',
  'Rafael', 'Nadia', 'Hiroshi', 'Leilani', 'Omar', 'Grace', 'Mateo', 'Yara', 'Dmitri', 'Chloe',
  'Tariq', 'Rosa', 'Kenji', 'Amara', 'Liam', 'Fatima', 'Andrés', 'Hannah', 'Kofi', 'Elena',
  'Ravi', 'Maya', 'Samuel', 'Ximena', 'Jin', 'Olivia', 'Emeka', 'Lucia', 'Arjun', 'Zoe',
  'Malik', 'Ana', 'Theo', 'Imani', 'Viktor', 'Noor', 'Wesley', 'Camila', 'Dev', 'Ruth'
] as const;

// prettier-ignore
export const MANAGER_LAST_NAMES = [
  'Hale', 'Okafor', 'Ramirez', 'Nguyen', 'Patel', 'Kowalski', 'Haddad', 'Tanaka', 'Mensah', 'Lindqvist',
  'Castillo', 'Chen', 'Abernathy', 'Kahananui', 'Rossi', 'Adeyemi', 'Silva', 'Novak', 'Brooks', 'Iyer',
  'Moreau', 'Oyelaran', 'Park', 'Delgado', 'Fitzgerald', 'Nakamura', 'Asante', 'Petrov', 'Whitfield', 'Soto',
  'Kim', 'Obi', 'Larsen', 'Mahmoud', 'Ortega', 'Sullivan', 'Eze', 'Varga', 'Tran', 'Bishop',
  'Quinn', 'Reyes', 'Singh', 'Fontaine', 'Mwangi', 'Holloway', 'Suzuki', 'Alvarez', 'Carter', 'Yilmaz'
] as const;

/** Nicknames that fit each personality, used now and then as `First "Nick" Last`. */
export const PERSONALITY_NICKNAMES: Readonly<Record<PersonalityId, readonly string[]>> = {
  'stats-nerd': ['Spreadsheet', 'Decimal', 'Sigma'],
  'old-school-scout': ['Tape', 'Whistle', 'Stopwatch'],
  'the-homer': ['Foam Finger', 'Hometown'],
  'chaos-agent': ['Wildcard', 'Dice', 'Scramble'],
  'smug-veteran': ['Ringmaster', 'Been There'],
  'hype-man': ['Megaphone', 'Turbo', 'Boom'],
  'zen-master': ['Breathe', 'Lotus', 'Calm'],
  'film-room-junkie': ['Rewind', 'All-22', 'Frame'],
  'soap-opera-narrator': ['Drama', 'Plot Twist'],
  'pirate-captain': ['Waiverbeard', 'Anchor', 'Plank'],
  'cranky-grandpa': ['Cardigan', 'Grumpy', 'Porch'],
  'corporate-consultant': ['Synergy', 'Bottom Line', 'Pivot'],
  'noir-detective': ['Fedora', 'Gumshoe', 'Clue'],
  'radio-caller': ['Long Time', 'Caller Five', 'Dial-In'],
  'literal-robot': ['Unit', 'Beep', 'Byte'],
  'the-oracle': ['Crystal Ball', 'Prophecy', 'Omen'],
  'chill-surfer': ['Brah', 'Tide', 'Swell'],
  'chef-de-roster': ['Chef', 'Sous', 'Spatula'],
  'lucky-charm': ['Lucky', 'Clover', 'Horseshoe'],
  'nature-narrator': ['Wildlife', 'Safari', 'Habitat'],
  'drill-sergeant': ['Sarge', 'Reveille', 'Double Time'],
  'poet-laureate': ['Sonnet', 'Stanza', 'Verse'],
  'startup-founder': ['Unicorn', 'Disrupt', 'Series A'],
  'grumpy-ref': ['Flag', 'Stripes', 'Replay']
};

/** The chance a rolled name carries a personality nickname. */
const NICKNAME_CHANCE = 1 / 3;

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] as T;
}

const key = (name: string) => name.trim().toLowerCase();

export interface RollManagerNameOptions {
  /** Names already taken (compared case-insensitively); the roll never returns one of them. */
  avoid?: Iterable<string>;
  /** Lets the roll add one of this personality's nicknames now and then. */
  personalityId?: PersonalityId;
}

/**
 * A realistic, family-friendly manager name, at most `MANAGER_NAME_MAX` characters, that is not in
 * `avoid`. With a personality, about one name in three carries a fitting nickname. There are 2,500
 * plain first-last pairs, so a name is always found; the same `random` sequence gives the same name.
 */
export function rollManagerName(random: () => number, options: RollManagerNameOptions = {}): string {
  const taken = new Set([...(options.avoid ?? [])].map(key));
  const nicknames = options.personalityId === undefined ? [] : PERSONALITY_NICKNAMES[options.personalityId];
  for (let attempt = 0; attempt < 50; attempt++) {
    const first = pick(MANAGER_FIRST_NAMES, random);
    const last = pick(MANAGER_LAST_NAMES, random);
    const nick = nicknames.length > 0 && random() < NICKNAME_CHANCE ? pick(nicknames, random) : null;
    const name = nick === null ? `${first} ${last}` : `${first} "${nick}" ${last}`;
    if (name.length <= MANAGER_NAME_MAX && !taken.has(key(name))) return name;
  }
  // Nearly every pair was taken: walk the pairs from a random start so the result stays seeded.
  const start = Math.floor(random() * MANAGER_FIRST_NAMES.length * MANAGER_LAST_NAMES.length);
  const total = MANAGER_FIRST_NAMES.length * MANAGER_LAST_NAMES.length;
  for (let i = 0; i < total; i++) {
    const n = (start + i) % total;
    const name = `${MANAGER_FIRST_NAMES[n % MANAGER_FIRST_NAMES.length]} ${MANAGER_LAST_NAMES[Math.floor(n / MANAGER_FIRST_NAMES.length)]}`;
    if (!taken.has(key(name))) return name;
  }
  throw new RangeError('Every manager name is taken.');
}

const SEED_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A fresh 10-character avatar seed, e.g. `k3q9z0b1ma`. */
export function rollAvatarSeed(random: () => number): string {
  let seed = '';
  for (let i = 0; i < 10; i++) seed += pick([...SEED_ALPHABET], random);
  return seed;
}

export interface ManagerIdentity {
  name: string;
  avatarSeed: string;
}

/**
 * The name and avatar seed a seat shows: the stored values, else a deterministic default from
 * `stableKey` (use the agent id, `<leagueId>.<teamId>`, so it never changes for the seat). Seats
 * saved before names existed, and agent seats not configured yet, get names this way.
 */
export function effectiveManager(
  config: { name?: string | undefined; avatarSeed?: string | undefined } | null | undefined,
  stableKey: string
): ManagerIdentity {
  const random = seededRandom(`manager:${stableKey}`);
  const name = config?.name ?? rollManagerName(random);
  const avatarSeed = config?.avatarSeed ?? rollAvatarSeed(seededRandom(`avatar:${stableKey}`));
  return { name, avatarSeed };
}

/** One seat of a league, for `leagueManagerIdentities`: its stable key and its stored config, if any. */
export interface LeagueSeatIdentityInput {
  key: string;
  config: { name?: string | undefined; avatarSeed?: string | undefined } | null | undefined;
}

/**
 * The name and avatar seed of every seat in a league (by key), with no default name repeating another
 * seat's name or any in `avoid` (compared case-insensitively). Stored names are kept as they are;
 * seats without one take their defaults in key order, each rolled from its own `effectiveManager`
 * sequence past the names already used. A default that collides with nothing is the very name
 * `effectiveManager` gives, so only the seat that would have repeated a name changes. Leagues made
 * before stored names (#161) get unique defaults this way, and every caller that passes the same
 * seats (the runner, the API) gets the same names.
 */
export function leagueManagerIdentities(
  seats: readonly LeagueSeatIdentityInput[],
  avoid: Iterable<string> = []
): Map<string, ManagerIdentity> {
  const taken = [...avoid];
  for (const seat of seats) if (seat.config?.name !== undefined) taken.push(seat.config.name);
  const byKey = [...seats].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const identities = new Map<string, ManagerIdentity>();
  for (const seat of byKey) {
    const stored = seat.config?.name;
    const name = stored ?? rollManagerName(seededRandom(`manager:${seat.key}`), { avoid: taken });
    if (stored === undefined) taken.push(name);
    identities.set(seat.key, { ...effectiveManager(seat.config, seat.key), name });
  }
  return identities;
}
