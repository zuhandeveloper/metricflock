import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

/** Central API error contract (API-9): every error response is
 *  `{ error: <stable_code>, requestId }` (plus `details` only for
 *  validation issues the client can act on). Raw exception/provider text
 *  is logged server-side under the same requestId, never returned. */
export function apiError(code: string, status: number, details?: unknown): NextResponse {
  const requestId = randomUUID();
  return NextResponse.json(
    { error: code, requestId, ...(details !== undefined ? { details } : {}) },
    { status, headers: { "x-request-id": requestId } },
  );
}

/** Map known Prisma error codes to stable API errors; anything else is a
 *  logged 500. Returns null when the error is not a Prisma error. */
export function prismaErrorResponse(e: unknown, context: string): NextResponse | null {
  const code = (e as { code?: string } | null)?.code;
  if (typeof code !== "string" || !code.startsWith("P")) return null;
  const requestId = randomUUID();
  console.error(`[api:${context}] requestId=${requestId} prisma=${code}`, e instanceof Error ? e.message : e);
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

/** Wrap a route handler so uncaught errors become contract responses
 *  instead of opaque framework 500s. */
export function withApiErrors<T extends unknown[]>(
  context: string,
  handler: (...args: T) => Promise<NextResponse>,
): (...args: T) => Promise<NextResponse> {
  return async (...args: T) => {
    try {
      return await handler(...args);
    } catch (e) {
      const mapped = prismaErrorResponse(e, context);
      if (mapped) return mapped;
      const requestId = randomUUID();
      console.error(`[api:${context}] requestId=${requestId}`, e instanceof Error ? e.message : e);
      return NextResponse.json(
        { error: "internal_error", requestId },
        { status: 500, headers: { "x-request-id": requestId } },
      );
    }
  };
}
