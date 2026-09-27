/** Parses `--key value` and `--flag` arguments. Values never start with `--`. */
export function parseArgs(argv: readonly string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) throw new UsageError(`Unexpected argument "${arg}".`);
    const eq = arg.indexOf('=');
    if (eq > 0) {
      out.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out.set(arg.slice(2), next);
      i++;
    } else {
      out.set(arg.slice(2), true);
    }
  }
  return out;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** A whole-number option, or `fallback` when absent. */
export function intArg(args: Map<string, string | true>, key: string, fallback?: number): number | undefined {
  const raw = args.get(key);
  if (raw === undefined) return fallback;
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(n)) throw new UsageError(`--${key} needs a whole number.`);
  return n;
}

/** A string option, or `fallback` when absent. */
export function stringArg(
  args: Map<string, string | true>,
  key: string,
  fallback?: string
): string | undefined {
  const raw = args.get(key);
  if (raw === undefined) return fallback;
  if (raw === true) throw new UsageError(`--${key} needs a value.`);
  return raw;
}
