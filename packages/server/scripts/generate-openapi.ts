// Regenerates packages/server/openapi.json from the operation registry.
// Run with `npm run openapi -w @fantasy/server`.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registry } from '../src/operations/index.js';
import { renderOpenApi } from '../src/openapi/generate.js';

const target = fileURLToPath(new URL('../openapi.json', import.meta.url));
writeFileSync(target, renderOpenApi(registry));
process.stdout.write(`Wrote ${target}\n`);
