import { describe, expect, it } from 'vitest';
import { formatJoinCode, parseJoinCode } from './joinCode';

describe('join codes', () => {
  it('reads a code typed any way', () => {
    expect(parseJoinCode('K7MQ2X')).toBe('K7MQ2X');
    expect(parseJoinCode('k7m-q2x')).toBe('K7MQ2X');
    expect(parseJoinCode('  k7m q2x\n')).toBe('K7MQ2X');
  });

  it('rejects anything that cannot be a code', () => {
    for (const text of [
      '',
      'K7MQ2',
      'K7MQ2XX',
      'K7MQ20',
      'K7MQ2O',
      'K7MQ2I',
      'K7MQ2L',
      'K7MQ21',
      'K7M_Q2X',
      'K7MQ2!'
    ]) {
      expect(parseJoinCode(text), text).toBeNull();
    }
    // An invite link's token is far longer, so it is never mistaken for a code.
    expect(parseJoinCode('x'.repeat(43))).toBeNull();
  });

  it('shows a code with a dash in the middle', () => {
    expect(formatJoinCode('K7MQ2X')).toBe('K7M-Q2X');
  });
});
