import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineOperation, OperationResult, withWarnings } from './operation.js';
import { createRegistry } from './registry.js';

const base = {
  name: 'get_thing',
  method: 'GET' as const,
  path: '/things/{thingId}',
  summary: 'Get a thing',
  description: 'Gets a thing.',
  mutation: false,
  input: z.object({ thingId: z.string() }),
  output: z.object({ ok: z.boolean() }),
  handler: async () => ({ ok: true })
};

describe('defineOperation', () => {
  it('defaults auth and extracts path params', () => {
    const op = defineOperation(base);
    expect(op.auth).toBe('authenticated');
    expect(op.pathParams).toEqual(['thingId']);
  });

  it.each([
    [{ name: 'GetThing' }, /snake_case/],
    [{ name: 'get__thing' }, /snake_case/],
    [{ path: 'things' }, /must start/],
    [{ description: ' ' }, /required/],
    [{ summary: '' }, /required/],
    [{ path: '/things/{other}' }, /"other" is not a field/],
    [{ mutation: true }, /cannot use GET/]
  ])('rejects %o', (override, message) => {
    expect(() => defineOperation({ ...base, ...override })).toThrow(message);
  });
});

describe('createRegistry', () => {
  const a = defineOperation(base);
  it('sorts operations and looks them up by name', () => {
    const b = defineOperation({ ...base, name: 'a_first', path: '/a' });
    const registry = createRegistry([a, b]);
    expect(registry.operations.map((op) => op.name)).toEqual(['a_first', 'get_thing']);
    expect(registry.get('get_thing')).toBe(a);
    expect(registry.get('missing')).toBeUndefined();
  });

  it('rejects duplicate names and routes', () => {
    expect(() => createRegistry([a, a])).toThrow(/Duplicate operation name/);
    const sameRoute = defineOperation({
      ...base,
      name: 'other',
      path: '/things/{id}',
      input: z.object({ id: z.string() })
    });
    expect(() => createRegistry([a, sameRoute])).toThrow(/Duplicate route/);
  });
});

describe('withWarnings', () => {
  it('wraps data', () => {
    const result = withWarnings({ ok: true }, [{ code: 'X', message: 'y' }]);
    expect(result).toBeInstanceOf(OperationResult);
    expect(result.warnings).toHaveLength(1);
  });
});
