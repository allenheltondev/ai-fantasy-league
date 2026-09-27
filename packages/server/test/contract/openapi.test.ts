import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderOpenApi } from '../../src/openapi/generate.js';
import { registry } from '../../src/operations/index.js';

const committedPath = new URL('../../openapi.json', import.meta.url);

describe('committed openapi.json', () => {
  it('matches what the registry generates (run `npm run openapi -w @fantasy/server` to update)', () => {
    expect(readFileSync(committedPath, 'utf8')).toBe(renderOpenApi(registry));
  });

  it('documents every operation with a model-oriented description', () => {
    const doc = JSON.parse(readFileSync(committedPath, 'utf8')) as {
      paths: Record<string, Record<string, { operationId: string; description: string; summary: string }>>;
    };
    const ops = Object.values(doc.paths).flatMap((methods) => Object.values(methods));
    expect(ops.map((op) => op.operationId).sort()).toEqual(registry.operations.map((op) => op.name).sort());
    for (const op of ops) {
      expect(op.summary.length, op.operationId).toBeGreaterThan(5);
      expect(op.description.length, op.operationId).toBeGreaterThan(80);
    }
  });
});
