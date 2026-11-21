/** RFC 4180 CSV writer with spreadsheet formula-injection neutralization
 *  (API-10/DATA-11): cells starting with = + - @ (or tab/CR) are prefixed
 *  with a single quote so Excel/Sheets treat them as text, and every cell
 *  is quoted when it contains a comma, quote, or newline. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(","));
  return lines.join("\n");
}
