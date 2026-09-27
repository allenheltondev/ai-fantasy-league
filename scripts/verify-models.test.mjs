// Run with: npm run test:scripts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activeFoundationModelIds, activeProfileIds, findMissing, formatReport } from './verify-models.mjs';

const catalog = [
  { key: 'a', bedrockId: 'us.amazon.nova-lite-v1:0' },
  { key: 'b', bedrockId: 'moonshot.kimi-k2-thinking' },
  { key: 'c', bedrockId: 'us.anthropic.missing-v1' }
];

describe('verify-models', () => {
  it('collects only active profiles and models', () => {
    const profiles = activeProfileIds({
      inferenceProfileSummaries: [
        { inferenceProfileId: 'us.amazon.nova-lite-v1:0', status: 'ACTIVE' },
        { inferenceProfileId: 'us.old-v1', status: 'LEGACY' }
      ]
    });
    const models = activeFoundationModelIds({
      modelSummaries: [
        { modelId: 'moonshot.kimi-k2-thinking', modelLifecycle: { status: 'ACTIVE' } },
        { modelId: 'retired', modelLifecycle: { status: 'LEGACY' } }
      ]
    });
    assert.deepEqual(profiles, ['us.amazon.nova-lite-v1:0']);
    assert.deepEqual(models, ['moonshot.kimi-k2-thinking']);
    assert.deepEqual(activeProfileIds({}), []);
    assert.deepEqual(activeFoundationModelIds(undefined), []);
  });

  it('lists every catalog id that is not available', () => {
    const missing = findMissing(catalog, ['us.amazon.nova-lite-v1:0', 'moonshot.kimi-k2-thinking']);
    assert.deepEqual(
      missing.map((m) => m.key),
      ['c']
    );
    const report = formatReport(catalog, missing, 'us-east-1');
    assert.match(report, /1 of 3 catalog ids are NOT available in us-east-1/);
    assert.match(report, /c: us\.anthropic\.missing-v1/);
    assert.match(formatReport(catalog, [], 'us-east-1'), /all 3 catalog ids are available/);
  });

  it('loads the real catalog', async () => {
    const { MODEL_CATALOG } = await import('../packages/core/src/agents/models.ts');
    assert.ok(MODEL_CATALOG.length >= 8);
    assert.equal(
      findMissing(
        MODEL_CATALOG,
        MODEL_CATALOG.map((m) => m.bedrockId)
      ).length,
      0
    );
  });
});
