import { isAbsolute, join, resolve } from 'node:path';
import { ARCHIVES_DIR, FIXTURE_ARCHIVE_DIR } from '../archive/io.js';

/** `--archive`: `fixtures` (the committed fixture), a season (`2025`, built by sim:archive), or a directory. */
export function archiveDir(value: string, cwd: string = process.cwd()): string {
  if (value === 'fixtures') return FIXTURE_ARCHIVE_DIR;
  if (/^\d{4}$/.test(value)) return join(ARCHIVES_DIR, value);
  return isAbsolute(value) ? value : resolve(cwd, value);
}
