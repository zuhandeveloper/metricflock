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

  // A-COV-11: boundary values of the clamp contract every list endpoint
  // relies on — the finding named limit 0 / negative / >max / offset
  // beyond total; limit 0 and >max were already pinned above.
  it("clamps a negative limit to 1 and pins the exact max boundary", () => {
    expect(parsePagination(req("limit=-5"))).toEqual({ limit: 1, offset: 0 });
    expect(parsePagination(req("limit=200"))).toEqual({ limit: 200, offset: 0 });
    expect(parsePagination(req("limit=201"))).toEqual({ limit: 200, offset: 0 });
  });

  it("floors fractional values and treats empty/non-finite input safely", () => {
    expect(parsePagination(req("limit=10.9&offset=10.9"))).toEqual({ limit: 10, offset: 10 });
    // Number("") is 0, so an empty limit clamps to the 1-row minimum
    // rather than falling back to the default.
    expect(parsePagination(req("limit=&offset="))).toEqual({ limit: 1, offset: 0 });
    // Non-finite values fall back to the defaults.
    expect(parsePagination(req("limit=Infinity&offset=Infinity"))).toEqual({ limit: 50, offset: 0 });
  });

  it("passes an under-cap offset through untouched (offset beyond total is the caller's empty page)", () => {
    // parsePagination cannot know the total; the contract is only the
    // 10,000 cap. An offset past the end yields an empty page from the
    // caller, not an error here.
    expect(parsePagination(req("offset=5000"))).toEqual({ limit: 50, offset: 5000 });
  });

  it("clamps a sub-1 defaultLimit option to 1 and a defaultLimit above maxLimit to maxLimit", () => {
    expect(parsePagination(req(""), { defaultLimit: 0 })).toEqual({ limit: 1, offset: 0 });
    expect(parsePagination(req(""), { defaultLimit: 9999 })).toEqual({ limit: 200, offset: 0 });
  });
});
