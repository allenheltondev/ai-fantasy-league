import { describe, expect, it } from 'vitest';
import { SchemaDriftError } from '../errors.js';
import { csvNumber, csvValue, parseCsv, parseCsvObjects } from './csv.js';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded commas and newlines, and CRLF', () => {
    const text = 'a,b,c\r\n1,"x, y","say ""hi"""\n2,"multi\nline",\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', 'say "hi"'],
      ['2', 'multi\nline', '']
    ]);
  });

  it('handles a final line without a newline and skips blank lines', () => {
    expect(parseCsv('a\n\n1')).toEqual([['a'], ['1']]);
    expect(parseCsv('')).toEqual([]);
  });
});

describe('parseCsvObjects', () => {
  it('keys rows by header, strips a BOM, and pads short rows', () => {
    expect(parseCsvObjects('﻿a,b\n1\n', ['a'], 't')).toEqual([{ a: '1', b: '' }]);
  });

  it('raises SchemaDriftError for missing required columns or an empty file', () => {
    const err = (() => {
      try {
        parseCsvObjects('a,b\n1,2', ['a', 'c', 'd'], 'test.csv');
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(SchemaDriftError);
    expect((err as SchemaDriftError).issues.map((i) => i.path)).toEqual(['c', 'd']);
    expect(() => parseCsvObjects('', ['a'], 'empty.csv')).toThrow(/empty CSV/);
  });
});

describe('csvValue / csvNumber', () => {
  const row = { a: ' 3 ', b: 'NA', c: '', d: 'x' };
  it('treats NA and empty as missing', () => {
    expect(csvValue(row, 'a')).toBe('3');
    expect(csvValue(row, 'b')).toBeUndefined();
    expect(csvValue(row, 'c')).toBeUndefined();
    expect(csvValue(row, 'zz')).toBeUndefined();
    expect(csvNumber(row, 'a')).toBe(3);
    expect(csvNumber(row, 'b')).toBeUndefined();
    expect(csvNumber(row, 'd')).toBeUndefined();
  });
});
