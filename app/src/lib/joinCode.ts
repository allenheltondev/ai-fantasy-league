/**
 * Join codes: the six-character alias for an invite link (`K7M-Q2X`). Same alphabet as the server's
 * (no 0/O or 1/I/L), so what people type is what the server accepts.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PATTERN = new RegExp(`^[${ALPHABET}]{6}$`);

/** The code inside what a person typed (any case, spaces and dashes ignored), or null if it is not one. */
export function parseJoinCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  return PATTERN.test(code) ? code : null;
}

/** `K7MQ2X` as `K7M-Q2X`. */
export function formatJoinCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}
