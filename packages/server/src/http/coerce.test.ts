import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { coerceParams, kindOf } from './coerce.js';

describe('kindOf', () => {
  it('unwraps optional, nullable, and default', () => {
    expect(kindOf(z.boolean().default(false))).toBe('boolean');
    expect(kindOf(z.number().int().nullable().optional())).toBe('number');
    expect(kindOf(z.array(z.string()).optional())).toBe('array');
    expect(kindOf(z.string())).toBe('other');
  });
});

describe('coerceParams', () => {
  const shape = {
    detail: z.boolean().optional(),
    week: z.number().optional(),
    ids: z.array(z.string()).optional(),
    q: z.string().optional()
  };

  it('coerces booleans, numbers, and arrays', () => {
    expect(
      coerceParams(shape, { detail: ['true'], week: ['5'], ids: ['a', 'b'], q: ['x', 'y'], extra: ['1'] })
    ).toEqual({ detail: true, week: 5, ids: ['a', 'b'], q: 'y', extra: '1' });
    expect(coerceParams(shape, { detail: ['0'], week: ['-2.5'] })).toEqual({ detail: false, week: -2.5 });
    expect(coerceParams(shape, { detail: ['1'] })).toEqual({ detail: true });
    expect(coerceParams(shape, { detail: ['false'] })).toEqual({ detail: false });
  });

  it('passes unparseable values through for validation to reject', () => {
    expect(coerceParams(shape, { detail: ['yes'], week: ['five'], q: [] })).toEqual({
      detail: 'yes',
      week: 'five'
    });
  });
});
