// Structured JSON logging (Stage 8). One line per event:
//   {"ts":"...","level":"info","context":"worker","msg":"...","requestId":"..."}
// Deliberately dependency-free (no pino/winston): both the web app and
// the worker run under platforms that capture stdout, and JSON lines are
// what log aggregators (Vercel, Railway, Docker, Loki) parse natively.
// LOG_LEVEL env: debug|info|warn|error (default info).
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
import { sanitizeProviderError } from "./redact";

function minLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return ORDER[raw] ?? ORDER.info;
}

export type Logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  child: (meta: Record<string, unknown>) => Logger;
};

export function createLogger(context: string, baseMeta: Record<string, unknown> = {}): Logger {
  function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
    if (ORDER[level] < minLevel()) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      context,
      msg,
      ...baseMeta,
      ...(meta ?? {}),
    });
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  }
  return {
    debug: (msg, meta) => emit("debug", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
    child: (meta) => createLogger(context, { ...baseMeta, ...meta }),
  };
}

/** Normalize an unknown thrown value into log-safe meta. The message
 * is secret-redacted (F-6.7): provider errors can embed tokens/URLs. */
export function errMeta(e: unknown): Record<string, unknown> {
  return { error: sanitizeProviderError(e, 1000) };
}
