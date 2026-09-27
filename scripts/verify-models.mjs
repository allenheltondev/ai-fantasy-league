#!/usr/bin/env node
// Verifies that every Bedrock id in the agent model catalog
// (packages/core/src/agents/models.ts) is available in the deploy account and region.
//
//   node scripts/verify-models.mjs [--region us-east-1]
//
// Needs AWS credentials allowed to call bedrock:ListInferenceProfiles and
// bedrock:ListFoundationModels. Exits non-zero, listing every missing id, when any catalog id is
// neither an ACTIVE inference profile nor an ACTIVE foundation model. The runtime falls back to the
// next model in a tier when one is unavailable, but a missing id is still a catalog bug: fix the id
// (or remove the model) rather than relying on the fallback.
//
// models.ts has no imports, so Node's built-in TypeScript type stripping loads it directly.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CATALOG = new URL('../packages/core/src/agents/models.ts', import.meta.url);

/** Ids of ACTIVE inference profiles from `aws bedrock list-inference-profiles` output. */
export function activeProfileIds(output) {
  return (output?.inferenceProfileSummaries ?? [])
    .filter((p) => p.status === undefined || p.status === 'ACTIVE')
    .map((p) => p.inferenceProfileId);
}

/** Ids of ACTIVE foundation models from `aws bedrock list-foundation-models` output. */
export function activeFoundationModelIds(output) {
  return (output?.modelSummaries ?? [])
    .filter((m) => m.modelLifecycle?.status === undefined || m.modelLifecycle.status === 'ACTIVE')
    .map((m) => m.modelId);
}

/** Catalog entries whose Bedrock id is not among the available ids. */
export function findMissing(catalog, availableIds) {
  const available = new Set(availableIds);
  return catalog.filter((m) => !available.has(m.bedrockId));
}

/** The vendor segment of a Bedrock id: `us.anthropic.claude-x` and `anthropic.claude-x` both give `anthropic`. */
function vendorOf(id) {
  const parts = id.split('.');
  return parts.length > 2 && /^[a-z]{2,4}$/.test(parts[0]) ? parts[1] : parts[0];
}

/** Available ids from the same vendor as `id`, so a wrong guess can be corrected from the deploy log. */
export function sameVendorIds(id, availableIds) {
  const vendor = vendorOf(id);
  return [...new Set(availableIds)].filter((a) => vendorOf(a) === vendor).sort();
}

export function formatReport(catalog, missing, region, availableIds = []) {
  if (missing.length === 0) {
    return `verify-models: all ${catalog.length} catalog ids are available in ${region}.`;
  }
  const lines = missing.flatMap((m) => {
    const candidates = sameVendorIds(m.bedrockId, availableIds);
    return [
      `  - ${m.key}: ${m.bedrockId}`,
      candidates.length > 0
        ? `      available ${vendorOf(m.bedrockId)} ids: ${candidates.join(', ')}`
        : `      no ${vendorOf(m.bedrockId)} ids are available in this account and region`
    ];
  });
  return [
    `verify-models: ${missing.length} of ${catalog.length} catalog ids are NOT available in ${region}:`,
    ...lines,
    'Fix the ids in packages/core/src/agents/models.ts (and the Bedrock IAM ARNs in infra/template.yaml),',
    'or request model access in the Bedrock console.'
  ].join('\n');
}

function aws(args) {
  return JSON.parse(execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8' }));
}

export async function main(argv = process.argv.slice(2)) {
  const regionFlag = argv.indexOf('--region');
  const region =
    regionFlag >= 0
      ? argv[regionFlag + 1]
      : (process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1');
  const { MODEL_CATALOG } = await import(CATALOG.href);
  const profiles = aws([
    'bedrock',
    'list-inference-profiles',
    '--region',
    region,
    '--type-equals',
    'SYSTEM_DEFINED'
  ]);
  const models = aws(['bedrock', 'list-foundation-models', '--region', region]);
  const available = [...activeProfileIds(profiles), ...activeFoundationModelIds(models)];
  const missing = findMissing(MODEL_CATALOG, available);
  const report = formatReport(MODEL_CATALOG, missing, region, available);
  if (missing.length > 0) {
    console.error(report);
    return 1;
  }
  console.log(report);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`verify-models: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  );
}
