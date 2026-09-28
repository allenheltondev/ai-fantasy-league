import { describe, expect, it } from 'vitest';
import { UsageError, intArg, parseArgs, stringArg } from './args.js';

describe('cli args', () => {
  it('parses --key value, --key=value, and bare flags', () => {
    const args = parseArgs(['--season', '2025', '--fixture', '--out=dir', '--weeks', '4']);
    expect(Object.fromEntries(args)).toEqual({ season: '2025', fixture: true, out: 'dir', weeks: '4' });
    expect(intArg(args, 'season')).toBe(2025);
    expect(intArg(args, 'missing', 8)).toBe(8);
    expect(stringArg(args, 'out')).toBe('dir');
    expect(stringArg(args, 'missing', 'x')).toBe('x');
  });

  it('explains bad input', () => {
    expect(() => parseArgs(['stray'])).toThrow(UsageError);
    expect(() => intArg(parseArgs(['--weeks', 'four']), 'weeks')).toThrow(/whole number/);
    expect(() => intArg(parseArgs(['--weeks']), 'weeks')).toThrow(/whole number/);
    expect(() => stringArg(parseArgs(['--seed']), 'seed')).toThrow(/needs a value/);
  });
});
