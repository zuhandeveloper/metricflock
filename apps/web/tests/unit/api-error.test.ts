import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { counterSnapshot, resetCounters } from "@metricflock/shared";
import { prismaErrorResponse, withApiErrors, apiError, ApiError } from "@/lib/api-error";

describe("API error contract (API-9)", () => {
  beforeEach(() => {
    resetCounters();
  });
  it("maps Prisma codes to stable errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: [string, number, string][] = [
      ["P2002", 409, "conflict"],
      ["P2003", 400, "invalid_reference"],
      ["P2025", 404, "not_found"],
      ["P9999", 500, "internal_error"],
    ];
    for (const [code, status, error] of cases) {
      const res = prismaErrorResponse(Object.assign(new Error("x"), { code }), "test")!;
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body.error).toBe(error);
      expect(body.requestId).toBeTruthy();
      expect(res.headers.get("x-request-id")).toBe(body.requestId);
    }
    expect(prismaErrorResponse(new Error("plain"), "test")).toBeNull();
  });
  it("withApiErrors converts uncaught errors without leaking internals", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = withApiErrors("test", async () => {
      throw new Error("secret internals");
    });
    const res = await handler();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "internal_error", requestId: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain("secret internals");
  });
  it("apiError keeps the stable shape", async () => {
    const res = apiError("invalid_input", 400, [{ path: ["name"] }]);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");
    expect(body.details).toEqual([{ path: ["name"] }]);
  });
  it("withApiErrors maps a thrown ApiError to the contract response (A-API-03)", async () => {
    const handler = withApiErrors("test", async () => {
      throw new ApiError("invalid_range", 400, { message: "range must be one of: 7d, 28d." });
    });
    const res = await handler();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error: "invalid_range",
      details: { message: "range must be one of: 7d, 28d." },
      requestId: expect.any(String),
    });
    expect(res.headers.get("x-request-id")).toBe(body.requestId);
  });
  it("withApiErrors enriches a returned bare error with the requestId (A-API-02)", async () => {
    const handler = withApiErrors("test", async () => NextResponse.json({ error: "team_not_found" }, { status: 404 }));
    const res = await handler();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "team_not_found", requestId: expect.any(String) });
    expect(res.headers.get("x-request-id")).toBe(body.requestId);
  });
  it("withApiErrors leaves success responses and already-stamped errors alone (A-API-02)", async () => {
    const ok = withApiErrors("test", async () => NextResponse.json({ teams: [] }));
    const okRes = await ok();
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ teams: [] });
    expect(okRes.headers.get("x-request-id")).toBeNull();
    const stamped = withApiErrors("test", async () =>
      NextResponse.json({ error: "gone", requestId: "req-1" }, { status: 410 }),
    );
    const stampedRes = await stamped();
    expect(await stampedRes.json()).toEqual({ error: "gone", requestId: "req-1" });
    expect(stampedRes.headers.get("x-request-id")).toBe("req-1");
  });

  // A-COV-11: the unhandled-error branch is the fallback for every
  // route — assert its observability contract (the api.internal_error
  // counter), not just the 500 body, and that the mapped/client-error
  // paths do NOT count as internal errors.
  it("withApiErrors increments api.internal_error exactly once per unhandled error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = withApiErrors("test", async () => {
      throw new Error("boom");
    });
    const res = await handler();
    expect(res.status).toBe(500);
    expect(counterSnapshot()["api.internal_error"]).toBe(1);
    await handler();
    expect(counterSnapshot()["api.internal_error"]).toBe(2);
  });

  it("withApiErrors does not count ApiError or Prisma-mapped errors as internal errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const clientError = withApiErrors("test", async () => {
      throw new ApiError("invalid_range", 400);
    });
    expect((await clientError()).status).toBe(400);
    const prismaError = withApiErrors("test", async () => {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    });
    expect((await prismaError()).status).toBe(409);
    expect(counterSnapshot()["api.internal_error"]).toBeUndefined();
    expect(counterSnapshot()["api.prisma_error"]).toBe(1);
  });

  it("withApiErrors does not count successful responses as internal errors", async () => {
    const handler = withApiErrors("test", async () => NextResponse.json({ ok: true }));
    expect((await handler()).status).toBe(200);
    expect(counterSnapshot()).toEqual({});
  });

  // A-COV-11: the two passthrough branches of the enrichment path —
  // a malformed-JSON error body and a plain (non-NextResponse)
  // Response both pass through untouched (the better-auth mount
  // depends on the latter).
  it("withApiErrors passes a malformed-JSON error body through untouched", async () => {
    const handler = withApiErrors(
      "test",
      async () => new NextResponse("not json", { status: 500, headers: { "content-type": "application/json" } }),
    );
    const res = await handler();
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("not json");
    expect(res.headers.get("x-request-id")).toBeNull();
  });

  it("withApiErrors passes plain Responses through untouched", async () => {
    const plain = new Response("plain-ok", { status: 200 });
    const handler = withApiErrors("test", async () => plain);
    const res = await handler();
    expect(res).toBe(plain);
    expect(await res.text()).toBe("plain-ok");
  });

  it("withApiErrors passes a non-object JSON error body through untouched", async () => {
    // Only object bodies carrying a string `error` get the requestId
    // injected; an array body is not the error contract shape.
    const handler = withApiErrors("test", async () => NextResponse.json(["not", "an", "object"], { status: 500 }));
    const res = await handler();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(["not", "an", "object"]);
    expect(res.headers.get("x-request-id")).toBeNull();
  });
});
