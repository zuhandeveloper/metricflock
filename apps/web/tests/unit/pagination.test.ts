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

  // A-API-09: offset is capped so a deep offset cannot force a huge skip.
  it("caps offset at 10000", () => {
    expect(parsePagination(req("offset=100000"))).toEqual({ limit: 50, offset: 10000 });
    expect(parsePagination(req("offset=10000"))).toEqual({ limit: 50, offset: 10000 });
    expect(parsePagination(req("offset=9999"))).toEqual({ limit: 50, offset: 9999 });
  });

  it("honours defaultLimit/maxLimit options", () => {
    expect(parsePagination(req(""), { defaultLimit: 500, maxLimit: 500 })).toEqual({ limit: 500, offset: 0 });
    expect(parsePagination(req("limit=9999"), { defaultLimit: 500, maxLimit: 500 })).toEqual({
      limit: 500,
      offset: 0,
    });
    expect(parsePagination(req("limit=150"), { defaultLimit: 100 })).toEqual({ limit: 150, offset: 0 });
    expect(parsePagination(req(""), { defaultLimit: 100 })).toEqual({ limit: 100, offset: 0 });
  });
});
