import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { ArchiveFilesSchema, SIM_ARCHIVE_VERSION, type ArchiveWeek, type SimArchive } from './format.js';

/** `packages/sim/fixtures/`: the small committed archive (4 weeks) used by tests and CI. */
export const FIXTURE_ARCHIVE_DIR = fileURLToPath(new URL('../../fixtures/', import.meta.url));

/** `packages/sim/archives/`: full archives built by `npm run sim:archive` (gitignored). */
export const ARCHIVES_DIR = fileURLToPath(new URL('../../archives/', import.meta.url));

/** Formats a file's text before it is written (the CLI passes Prettier so committed fixtures pass format checks). */
export type TextFormatter = (text: string, file: string) => Promise<string>;

/** Thrown when an archive directory is missing files or does not match the expected shape. */
export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveFormatError';
  }
}

const weekFile = (week: number): string => `weeks/${String(week).padStart(2, '0')}.json`;

/**
 * Writes an archive as small JSON files: `manifest.json`, `schedule.json`, `byes.json`, `crosswalk.json`,
 * `players.json`, and `weeks/NN.json` (stats, projections, and trending for one week). The directory's
 * previous `weeks/` are removed so a rebuild never leaves stale weeks behind.
 */
export async function writeSimArchive(
  dir: string,
  archive: SimArchive,
  format?: TextFormatter
): Promise<void> {
  await rm(join(dir, 'weeks'), { recursive: true, force: true });
  await mkdir(join(dir, 'weeks'), { recursive: true });
  const files: [string, unknown][] = [
    ['manifest.json', archive.manifest],
    ['schedule.json', archive.schedule],
    ['byes.json', archive.byeWeeks],
    ['crosswalk.json', archive.crosswalk],
    ['players.json', archive.players],
    ...archive.manifest.weeks.map((w): [string, unknown] => [weekFile(w), archive.weeks[w]])
  ];
  for (const [file, value] of files) {
    const text = `${JSON.stringify(value)}\n`;
    await writeFile(join(dir, file), format ? await format(text, file) : text);
  }
}

async function readJson<S extends z.ZodType>(dir: string, file: string, schema: S): Promise<z.infer<S>> {
  let text: string;
  try {
    text = await readFile(join(dir, file), 'utf8');
  } catch (cause) {
    throw new ArchiveFormatError(
      `Archive file ${join(dir, file)} is missing. Build it with: npm run sim:archive -w @fantasy/sim -- --season <year>` +
        (cause instanceof Error ? ` (${cause.message})` : '')
    );
  }
  const parsed = schema.safeParse(JSON.parse(text) as unknown);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ArchiveFormatError(
      `Archive file ${file} does not match the expected shape at ${issue?.path.join('.') || '<root>'}: ${issue?.message ?? 'invalid'}`
    );
  }
  return parsed.data;
}

/** Reads and validates an archive written by `writeSimArchive`. */
export async function readSimArchive(dir: string): Promise<SimArchive> {
  const raw = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8').catch(() => '{}')) as {
    version?: unknown;
  };
  if (raw.version !== undefined && raw.version !== SIM_ARCHIVE_VERSION) {
    throw new ArchiveFormatError(
      `Archive at ${dir} is version ${String(raw.version)}; this simulator reads version ${SIM_ARCHIVE_VERSION}. Rebuild it.`
    );
  }
  const manifest = await readJson(dir, 'manifest.json', ArchiveFilesSchema.manifest);
  const weeks: Record<number, ArchiveWeek> = {};
  const present = new Set(await readdir(join(dir, 'weeks')).catch(() => [] as string[]));
  for (const w of manifest.weeks) {
    if (!present.has(weekFile(w).slice('weeks/'.length))) {
      throw new ArchiveFormatError(`Archive at ${dir} lists week ${w} but ${weekFile(w)} is missing.`);
    }
    weeks[w] = await readJson(dir, weekFile(w), ArchiveFilesSchema.week);
  }
  return {
    manifest,
    schedule: await readJson(dir, 'schedule.json', ArchiveFilesSchema.schedule),
    byeWeeks: await readJson(dir, 'byes.json', ArchiveFilesSchema.byeWeeks),
    crosswalk: await readJson(dir, 'crosswalk.json', ArchiveFilesSchema.crosswalk),
    players: await readJson(dir, 'players.json', ArchiveFilesSchema.players),
    weeks
  };
}
