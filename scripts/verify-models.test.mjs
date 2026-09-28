// Run with: npm run test:scripts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  activeFoundationModelIds,
  activeProfileIds,
  findMissing,
  accessDeniedWarning,
  formatReport,
  isListingAccessDenied,
  sameVendorIds
} from './verify-models.mjs';

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

  it('suggests available ids from the same vendor for each missing one', () => {
    const available = [
      'us.amazon.nova-lite-v1:0',
      'us.anthropic.claude-sonnet-5-20260801-v1:0',
      'anthropic.claude-haiku-4-5-20251001-v1:0',
      'moonshot.kimi-k2-thinking'
    ];
    assert.deepEqual(sameVendorIds('us.anthropic.missing-v1', available), [
      'anthropic.claude-haiku-4-5-20251001-v1:0',
      'us.anthropic.claude-sonnet-5-20260801-v1:0'
    ]);
    const report = formatReport(catalog, findMissing(catalog, available), 'us-east-1', available);
    assert.match(report, /available anthropic ids: .*us\.anthropic\.claude-sonnet-5-20260801-v1:0/);
    const none = formatReport(catalog, findMissing(catalog, []), 'us-east-1', []);
    assert.match(none, /no moonshot ids are available/);
  });

  it('treats a denied listing call as unverifiable, not as a bad catalog', () => {
    const denied = Object.assign(new Error('Command failed: aws bedrock list-inference-profiles'), {
      stderr:
        'An error occurred (AccessDeniedException) when calling the ListInferenceProfiles operation: ' +
        'User: arn:aws:sts::1:assumed-role/Deploy/x is not authorized to perform: bedrock:ListInferenceProfiles'
    });
    assert.equal(isListingAccessDenied(denied), true);
    assert.equal(isListingAccessDenied(new Error('network timeout')), false);
    assert.equal(isListingAccessDenied(new Error('AccessDenied when calling bedrock:InvokeModel')), false);
    assert.match(accessDeniedWarning(), /^::warning title=Model catalog not verified::/);
  });
});
