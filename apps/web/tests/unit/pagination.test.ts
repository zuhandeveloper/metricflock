import { describe, it, expect } from "vitest";
import { parsePagination } from "@/lib/pagination";

function req(params: string) {
  return { nextUrl: { searchParams: new URLSearchParams(params) } } as never;
}

describe("parsePagination (API-12)", () => {
  it("defaults to limit 50, offset 0", () => {
    expect(parsePagination(req(""))).toEqual({ limit: 50, offset: 0 });
  });
  it("parses and clamps values", () => {
    expect(parsePagination(req("limit=10&offset=20"))).toEqual({ limit: 10, offset: 20 });
    expect(parsePagination(req("limit=9999"))).toEqual({ limit: 200, offset: 0 });
    expect(parsePagination(req("limit=0"))).toEqual({ limit: 1, offset: 0 });
    expect(parsePagination(req("offset=-5"))).toEqual({ limit: 50, offset: 0 });
    expect(parsePagination(req("limit=abc&offset=xyz"))).toEqual({ limit: 50, offset: 0 });
  });
});
