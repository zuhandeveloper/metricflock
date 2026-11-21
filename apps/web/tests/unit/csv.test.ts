import { describe, it, expect } from "vitest";
import { csvCell, toCsv } from "@/lib/csv";

describe("CSV writer (API-10/DATA-11)", () => {
  it("neutralizes spreadsheet formula injection", () => {
    expect(csvCell("=2+5")).toBe("'=2+5");
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=1")).toBe("'\t=1");
    expect(csvCell("/normal/path")).toBe("/normal/path");
  });
  it("quotes cells with commas, quotes, newlines (RFC 4180)", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(42)).toBe("42");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
  it("writes headers + rows; empty input is empty output", () => {
    expect(toCsv([])).toBe("");
    expect(toCsv([{ page: "/a,b", views: 3 }])).toBe('page,views\n"/a,b",3');
    expect(toCsv([{ page: "=evil", views: 1 }])).toBe("page,views\n'=evil,1");
  });
});
