import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureArchive, freshArchive } from '../../test/helpers.js';
import { ArchiveFormatError, readSimArchive, writeSimArchive } from './io.js';

describe('archive io', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sim-archive-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips an archive through small JSON files', async () => {
    const archive = await fixtureArchive();
    await writeSimArchive(dir, archive);
    expect(await readSimArchive(dir)).toEqual(archive);
  });

  it('runs a formatter over every file and removes stale weeks on rewrite', async () => {
    const archive = await freshArchive();
    const seen: string[] = [];
    await writeSimArchive(dir, archive, async (text, file) => {
      seen.push(file);
      return text;
    });
    expect(seen).toEqual([
      'manifest.json',
      'schedule.json',
      'byes.json',
      'crosswalk.json',
      'players.json',
      'weeks/01.json',
      'weeks/02.json',
      'weeks/03.json',
      'weeks/04.json'
    ]);
    archive.manifest.weeks = [1];
    await writeSimArchive(dir, archive);
    const read = await readSimArchive(dir);
    expect(Object.keys(read.weeks)).toEqual(['1']);
  });

  it('explains missing archives, missing weeks, bad shapes, and other versions', async () => {
    await expect(readSimArchive(join(dir, 'nope'))).rejects.toThrow(/sim:archive/);
    const archive = await fixtureArchive();
    await writeSimArchive(dir, archive);
    await rm(join(dir, 'weeks', '03.json'));
    await expect(readSimArchive(dir)).rejects.toThrow(/week 3/);

    await writeSimArchive(dir, archive);
    const players = JSON.parse(await readFile(join(dir, 'players.json'), 'utf8')) as { position: string }[];
    players[0]!.position = 'LB';
    await writeFile(join(dir, 'players.json'), JSON.stringify(players));
    await expect(readSimArchive(dir)).rejects.toThrow(ArchiveFormatError);
    await expect(readSimArchive(dir)).rejects.toThrow(/players\.json .* 0\.position/);

    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...archive.manifest, version: 99 }));
    await expect(readSimArchive(dir)).rejects.toThrow(/version 99/);
  });
});
