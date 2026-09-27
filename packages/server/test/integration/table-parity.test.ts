import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TABLE_KEYS, tableDefinition } from '../../src/repos/dynamo/table.js';

/**
 * The server writes items with TABLE_KEYS; infra/template.yaml creates the table. DynamoDB attribute
 * names are case-sensitive, so any drift makes index queries silently return nothing. This test reads
 * the FantasyTable block out of the SAM template and compares it with the server's definition.
 */
const templatePath = fileURLToPath(new URL('../../../../infra/template.yaml', import.meta.url));

function fantasyTableBlock(): string {
  const template = readFileSync(templatePath, 'utf8');
  const start = template.indexOf('\n  FantasyTable:');
  expect(start, 'FantasyTable resource in infra/template.yaml').toBeGreaterThan(-1);
  const rest = template.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function valuesAfter(block: string, key: string): string[] {
  return [...block.matchAll(new RegExp(`${key}: ([A-Za-z0-9_]+)`, 'g'))].map((m) => m[1] as string);
}

describe('FantasyTable key schema parity (server vs infra/template.yaml)', () => {
  const block = fantasyTableBlock();
  const definition = tableDefinition('parity');

  it('declares the same attribute definitions', () => {
    const templateAttributes = valuesAfter(block, 'AttributeName');
    const serverAttributes = (definition.AttributeDefinitions ?? []).map((a) => a.AttributeName);
    for (const name of serverAttributes) expect(templateAttributes).toContain(name);
  });

  it('declares the same GSIs with the same key attributes', () => {
    const indexNames = valuesAfter(block, 'IndexName');
    for (const index of [TABLE_KEYS.gsi1, TABLE_KEYS.gsi2]) {
      expect(indexNames).toContain(index.name);
      const indexStart = block.indexOf(`IndexName: ${index.name}`);
      const indexBlock = block.slice(indexStart, indexStart + 400);
      expect(indexBlock).toMatch(new RegExp(`AttributeName: ${index.pk}\\s+KeyType: HASH`));
      expect(indexBlock).toMatch(new RegExp(`AttributeName: ${index.sk}\\s+KeyType: RANGE`));
    }
  });

  it('uses the same TTL attribute', () => {
    expect(block).toMatch(new RegExp(`AttributeName: ${TABLE_KEYS.ttl}\\b`));
  });
});
