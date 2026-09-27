import { z } from 'zod';

type Kind = 'boolean' | 'number' | 'array' | 'other';

/** Looks through optional/default/nullable wrappers to the value's base type. */
export function kindOf(schema: z.ZodType): Kind {
  let current: z.ZodType = schema;
  for (;;) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault
    ) {
      current = current.unwrap() as z.ZodType;
      continue;
    }
    break;
  }
  if (current instanceof z.ZodBoolean) return 'boolean';
  if (current instanceof z.ZodNumber) return 'number';
  if (current instanceof z.ZodArray) return 'array';
  return 'other';
}

function coerceScalar(kind: Kind, value: string): unknown {
  if (kind === 'boolean') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  }
  if (kind === 'number' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/**
 * Query strings and path segments are strings; turn them into the booleans,
 * numbers, and arrays the input schema expects so one schema serves REST, MCP,
 * and agent tools. Anything unrecognized passes through for zod to reject.
 */
export function coerceParams(
  shape: Record<string, z.ZodType>,
  params: Record<string, readonly string[]>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, values] of Object.entries(params)) {
    const schema = shape[name];
    const kind = schema === undefined ? 'other' : kindOf(schema);
    if (kind === 'array') {
      out[name] = [...values];
      continue;
    }
    const last = values[values.length - 1];
    if (last !== undefined) out[name] = coerceScalar(kind, last);
  }
  return out;
}
