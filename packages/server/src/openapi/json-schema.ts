import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

/** zod v4 native JSON Schema (draft 2020-12, which OpenAPI 3.1 uses), minus `$schema`. */
export function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io }) as JsonSchema;
  return rest;
}

export interface ObjectJsonSchema {
  properties: Record<string, JsonSchema>;
  required: string[];
  rest: JsonSchema;
}

export function splitObjectSchema(schema: JsonSchema): ObjectJsonSchema {
  const { properties, required, type: _type, ...rest } = schema;
  return {
    properties: (properties ?? {}) as Record<string, JsonSchema>,
    required: Array.isArray(required) ? (required as string[]) : [],
    rest
  };
}
