const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/**
 * Lowercases, strips accents, joins initials and apostrophes (`A.J.` → `aj`, `Ja'Marr` → `jamarr`),
 * and collapses everything else to single spaces.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’.`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** `normalizeName` without generational suffixes (`jr`, `iii`, ...). */
export function normalizeNameNoSuffix(name: string): string {
  const parts = normalizeName(name).split(' ');
  while (parts.length > 1 && SUFFIXES.has(parts[parts.length - 1] ?? '')) parts.pop();
  return parts.join(' ');
}

export function uniqueNonEmpty(values: Iterable<string>): string[] {
  const out: string[] = [];
  for (const v of values) if (v !== '' && !out.includes(v)) out.push(v);
  return out;
}
