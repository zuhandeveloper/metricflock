// Shared helpers for component tests (tests/unit/components/*.test.tsx).
// Plain functions only — no vi.mock calls here; each test file declares
// its own next/navigation + next/link mocks (vi.mock must live in the
// test file that uses it).
import { vi } from "vitest";

export type FetchBody = unknown;

/** Minimal Response stand-in for a fetch() result. */
export function jsonResponse(body: FetchBody, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Install a fetch stub that answers every call with the same response. */
export function mockFetch(body: FetchBody, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => jsonResponse(body, ok, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Install a fetch stub driven by a per-call implementation. */
export function mockFetchImpl(impl: (...args: unknown[]) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Route fetch calls by URL substring; unmatched URLs get a 404 error body. */
export function mockFetchRoutes(routes: Record<string, { body: FetchBody; ok?: boolean; status?: number }>) {
  return mockFetchImpl(async (url: unknown) => {
    const u = String(url);
    for (const [key, r] of Object.entries(routes)) {
      if (u.includes(key)) return jsonResponse(r.body, r.ok ?? true, r.status ?? 200);
    }
    return jsonResponse({ error: "not_found" }, false, 404);
  });
}

/** Body string of the nth fetch call (the init object is the 2nd arg). */
export function fetchBody(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0): string {
  const call = fetchMock.mock.calls[callIndex];
  if (!call) throw new Error(`fetch was not called (expected call ${callIndex})`);
  const init = call[1] as RequestInit | undefined;
  return String(init?.body ?? "");
}

/** Fetch stub whose response body fails to parse as JSON — exercises the
 * `res.json().catch(() => null)` fallbacks in the form/action helpers. */
export function mockFetchBadJson(ok = false, status = 500) {
  const fetchMock = vi.fn(
    async () =>
      ({
        ok,
        status,
        json: async () => {
          throw new Error("bad json");
        },
      }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Fetch stub that answers after `delay` ms — lets tests double-click while
 * the component is busy, exercising the `if (busy) return` guards. */
export function mockFetchDelayed(body: FetchBody, ok = true, status = 200, delay = 200) {
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => resolve(jsonResponse(body, ok, status)), delay);
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Stub window.confirm to return `value` (default true). Returns the spy. */
export function mockConfirm(value = true) {
  return vi.spyOn(window, "confirm").mockReturnValue(value);
}

/** Stub window.location.assign; returns the spy so tests can assert on it. */
export function mockLocationAssign() {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    value: { assign },
    writable: true,
    configurable: true,
  });
  return assign;
}
