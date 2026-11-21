// In-process counters (Stage 8). Deliberately tiny: a Map of named
// counters the metrics endpoints snapshot. Counters reset on process
// restart — durable numbers (sync success rate, DLQ depth) are computed
// from the database at read time in the metrics endpoint, so a restart
// never loses the operational picture that matters.
const counters = new Map<string, number>();

export function incr(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function counterSnapshot(): Record<string, number> {
  return Object.fromEntries([...counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Test-only reset. */
export function resetCounters(): void {
  counters.clear();
}
