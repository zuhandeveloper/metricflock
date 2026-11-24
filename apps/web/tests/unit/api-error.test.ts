import { describe, it, expect, vi } from "vitest";
import { NextResponse } from "next/server";
import { prismaErrorResponse, withApiErrors, apiError, ApiError } from "@/lib/api-error";

describe("API error contract (API-9)", () => {
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
});
