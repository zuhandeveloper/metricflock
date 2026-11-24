import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createLogger, errMeta, incr } from "@metricflock/shared";

const log = createLogger("api");

/** Correlation id for this request: the middleware-stamped x-request-id
 *  when available, else a fresh UUID (Stage 8). */
export function requestIdOf(req?: { headers: Headers } | null): string {
  return req?.headers.get("x-request-id") ?? randomUUID();
}

/** Central API error contract (API-9): every error response is
 *  `{ error: <stable_code>, requestId }` (plus `details` only for
 *  validation issues the client can act on). Raw exception/provider text
 *  is logged server-side under the same requestId, never returned. */
export function apiError(
  code: string,
  status: number,
  details?: unknown,
  requestId: string = randomUUID(),
): NextResponse {
  return NextResponse.json(
    { error: code, requestId, ...(details !== undefined ? { details } : {}) },
    { status, headers: { "x-request-id": requestId } },
  );
}

/** Map known Prisma error codes to stable API errors; anything else is a
 *  logged 500. Returns null when the error is not a Prisma error. */
export function prismaErrorResponse(
  e: unknown,
  context: string,
  requestId: string = randomUUID(),
): NextResponse | null {
  const code = (e as { code?: string } | null)?.code;
  if (typeof code !== "string" || !code.startsWith("P")) return null;
  log.error("prisma error", { requestId, route: context, prismaCode: code, ...errMeta(e) });
  incr("api.prisma_error");
  switch (code) {
    case "P2002":
      return NextResponse.json(
        { error: "conflict", requestId },
        { status: 409, headers: { "x-request-id": requestId } },
      );
    case "P2003":
      return NextResponse.json(
        { error: "invalid_reference", requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    case "P2025":
      return NextResponse.json(
        { error: "not_found", requestId },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    default:
      return NextResponse.json(
        { error: "internal_error", requestId },
        { status: 500, headers: { "x-request-id": requestId } },
      );
  }
}

/** Typed client error a handler can throw to produce a contract error
 *  response instead of a 500 (A-API-03: invalid range/status). The
 *  wrapper maps it to `{ error: code, requestId }` with the given
 *  status — no log line, the client did something wrong, not the server. */
export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    public details?: unknown,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

/** Ensure a returned error response carries the requestId (A-API-02):
 *  handlers that return a bare `{ error }` JSON instead of going through
 *  `apiError()` get the id injected here, so the contract holds for every
 *  route — present and future — without a per-site conversion. Success
 *  responses, redirects and non-JSON bodies pass through untouched. */
async function enrichErrorResponse(res: NextResponse, requestId: string): Promise<NextResponse> {
  if (res.status < 400) return res;
  if (!res.headers.get("content-type")?.includes("application/json")) return res;
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return res;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return res;
  const rec = body as Record<string, unknown>;
  if (typeof rec.error !== "string") return res;
  if (typeof rec.requestId === "string" && rec.requestId) {
    if (!res.headers.get("x-request-id")) res.headers.set("x-request-id", rec.requestId);
    return res;
  }
  const headers = new Headers(res.headers);
  headers.set("x-request-id", requestId);
  return NextResponse.json({ ...rec, requestId }, { status: res.status, headers });
}

/** Wrap a route handler so uncaught errors become contract responses
 *  instead of opaque framework 500s. */
export function withApiErrors<T extends unknown[], R extends Response>(
  context: string,
  handler: (...args: T) => Promise<R>,
): (...args: T) => Promise<R | NextResponse> {
  return async (...args: T) => {
    const first = args[0] as { headers?: Headers } | undefined;
    const requestId = requestIdOf(first?.headers ? { headers: first.headers } : null);
    try {
      const res = await handler(...args);
      // Only NextResponse results can carry the enriched error body;
      // plain Responses (e.g. the better-auth mount) pass through.
      if (res instanceof NextResponse) return enrichErrorResponse(res, requestId);
      return res;
    } catch (e) {
      if (e instanceof ApiError) return apiError(e.code, e.status, e.details, requestId);
      const mapped = prismaErrorResponse(e, context, requestId);
      if (mapped) return mapped;
      log.error("unhandled route error", { requestId, route: context, ...errMeta(e) });
      incr("api.internal_error");
      return NextResponse.json(
        { error: "internal_error", requestId },
        { status: 500, headers: { "x-request-id": requestId } },
      );
    }
  };
}
