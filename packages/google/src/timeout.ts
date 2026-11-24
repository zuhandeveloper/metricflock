// Shared timeout for every Google API call (A-GGL-03). Before this, the
// googleapis paths had no timeout at all: a hung Google endpoint hung the
// dashboard request until the platform killed it, and hung worker sync
// jobs. Ad Manager already had its own 15 s timeout (ad-manager.ts);
// this is the same value, shared, so every provider fails fast the
// same way.
//
// Two layers, both needed:
// 1. `withGoogleTimeout` races the call against a timer, so the *caller*
//    always returns within the timeout — including against a client whose
//    underlying transport never settles (this is what the regression test
//    pins with a never-resolving mocked client).
// 2. Call sites also pass `{ timeout: GOOGLE_API_TIMEOUT_MS }` as the
//    googleapis MethodOptions, so gaxios aborts the real HTTP request
//    instead of leaving a hung socket behind.
//
// A timeout rejects with `GOOGLE_API_TIMEOUT`, which
// `classifyAnalyticsError` maps to `temporarily_unavailable` (retryable).
// `GOOGLE_API_TIMEOUT_MS` may be overridden per-process via env for
// tests; any non-positive/invalid value falls back to the default.
export const GOOGLE_API_TIMEOUT_MS = 15_000;

function resolveTimeoutMs(): number {
  const raw = Number(process.env.GOOGLE_API_TIMEOUT_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : GOOGLE_API_TIMEOUT_MS;
}

export function isGoogleTimeoutError(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("GOOGLE_API_TIMEOUT");
}

export function withGoogleTimeout<T>(
  promise: Promise<T>,
  operation: string,
  timeoutMs: number = resolveTimeoutMs(),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`GOOGLE_API_TIMEOUT: ${operation} did not respond within ${timeoutMs}ms`));
    }, timeoutMs);
    // A caller that already settled must not keep the process alive.
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
