import type { z } from 'zod';
import { SchemaDriftError } from './errors.js';

/** Validates `data` against `schema`, raising `SchemaDriftError` (with every issue) on mismatch. */
export function parseOrDrift<S extends z.ZodType>(schema: S, data: unknown, source: string): z.output<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw new SchemaDriftError(
    source,
    result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }))
  );
}
