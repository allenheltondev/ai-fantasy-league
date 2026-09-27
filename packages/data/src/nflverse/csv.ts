import { SchemaDriftError } from '../errors.js';

export type CsvRow = Record<string, string>;

/** RFC 4180 CSV parser: quoted fields, escaped quotes (`""`), CRLF or LF line endings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        field += ch;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else {
      field += ch;
    }
    i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/**
 * Parses CSV into objects keyed by header. Raises `SchemaDriftError` when a required column is
 * missing, so upstream renames are caught instead of silently producing zeros.
 */
export function parseCsvObjects(text: string, requiredColumns: readonly string[], source: string): CsvRow[] {
  const [header, ...body] = parseCsv(text.replace(/^\uFEFF/, ''));
  if (!header) throw new SchemaDriftError(source, [{ path: '', message: 'empty CSV' }]);
  const missing = requiredColumns.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new SchemaDriftError(
      source,
      missing.map((c) => ({ path: c, message: 'required column missing' }))
    );
  }
  return body.map((cells) => {
    const obj: CsvRow = {};
    header.forEach((h, idx) => {
      obj[h] = cells[idx] ?? '';
    });
    return obj;
  });
}

/** nflverse writes missing values as `NA` or an empty string. */
export function csvValue(row: CsvRow, column: string): string | undefined {
  const v = row[column];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' || t === 'NA' ? undefined : t;
}

export function csvNumber(row: CsvRow, column: string): number | undefined {
  const v = csvValue(row, column);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
