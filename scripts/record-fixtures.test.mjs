// Run with: npm run test:scripts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = new URL('./record-fixtures.mjs', import.meta.url).pathname;

/** Runs the recorder with no network: every case here must fail on its arguments first. */
function record(args) {
  const out = mkdtempSync(join(tmpdir(), 'record-fixtures-'));
  try {
    const run = spawnSync(process.execPath, [SCRIPT, ...args, '--out', out], { encoding: 'utf8' });
    return { status: run.status, stderr: run.stderr, wrote: existsSync(join(out, 'espn')) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

describe('record-fixtures --espn-scoreboard', () => {
  it('refuses a bad week, a missing week, or an unknown season type before fetching', () => {
    for (const args of [
      ['--espn-scoreboard', '2026', '23'],
      ['--espn-scoreboard', '2026'],
      ['--espn-scoreboard', 'next', '4'],
      ['--espn-scoreboard', '2026', '4', '--season-type', 'preseason']
    ]) {
      const run = record(args);
      assert.notEqual(run.status, 0, args.join(' '));
      assert.match(run.stderr, /--espn-scoreboard takes a season and a week/, args.join(' '));
      assert.equal(run.wrote, false, args.join(' '));
    }
  });
});
