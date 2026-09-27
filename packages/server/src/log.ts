/** Structured JSON logging. Handlers get a child logger bound to the request and operation. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogSink = (line: string) => void;

export function createLogger(
  options: { level?: LogLevel; bindings?: LogFields; sink?: LogSink } = {}
): Logger {
  const level = options.level ?? 'info';
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const write = (at: LogLevel, message: string, fields?: LogFields): void => {
    if (ORDER[at] < ORDER[level]) return;
    sink(JSON.stringify({ level: at, message, ...bindings, ...fields }, errorReplacer));
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (more) => createLogger({ level, sink, bindings: { ...bindings, ...more } })
  };
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

export function parseLogLevel(value: string | undefined): LogLevel {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

export const silentLogger: Logger = createLogger({ sink: () => undefined });
