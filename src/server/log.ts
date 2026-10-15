const SECRET_KEYS = ['secret', 'proof', 'joinkey', 'token', 'nonce', 'key', 'fragment', 'authorization'];

export interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  [k: string]: unknown;
}

const sink: ((line: string) => void)[] = [
  (line) => {
    process.stdout.write(line + '\n');
  }
];

let level: LogRecord['level'] = 'info';
const ORDER: Record<LogRecord['level'], number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function setLogLevel(next: LogRecord['level']): void {
  level = next;
}

/** Redacting logger: nothing that looks like a fragment, secret or token is emitted. */
export function scrub(value: unknown, keyHint = ''): unknown {
  if (typeof value === 'string') {
    const lowerKey = keyHint.toLowerCase();
    if (SECRET_KEYS.some((k) => lowerKey.includes(k))) return '[redacted]';
    // URL fragments carry the invite secret; strip them from any logged string.
    const stripped = value.replace(/#.{4,}/g, '#[redacted]');
    return stripped.length > 300 ? stripped.slice(0, 300) + '…' : stripped;
  }
  if (Buffer.isBuffer(value)) return `[buffer ${value.length}B]`;
  if (value instanceof Uint8Array) return `[bytes ${value.length}B]`;
  if (Array.isArray(value)) return value.map((v) => scrub(v, keyHint));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrub(v, k);
    return out;
  }
  return value;
}

export function log(levelName: LogRecord['level'], msg: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[levelName] < ORDER[level]) return;
  const rec: LogRecord = { level: levelName, msg, ...scrub(fields) as Record<string, unknown> };
  const line = JSON.stringify(rec, (_k, v) => (v instanceof Uint8Array ? `[bytes ${v.length}B]` : v));
  for (const s of sink) s(line);
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => log('debug', m, f ?? {}),
  info: (m: string, f?: Record<string, unknown>) => log('info', m, f ?? {}),
  warn: (m: string, f?: Record<string, unknown>) => log('warn', m, f ?? {}),
  error: (m: string, f?: Record<string, unknown>) => log('error', m, f ?? {})
};

/** Test hook: capture emitted lines so gates can assert the log stays free of secrets. */
export function captureLogs(fn: () => void | Promise<void>): Promise<string[]> {
  return (async () => {
    const lines: string[] = [];
    sink.push((l) => lines.push(l));
    try {
      await fn();
    } finally {
      sink.pop();
    }
    return lines;
  })();
}
