// A-PERF-01 — controlled HTTP load test for the MetricFlock web app.
//
// Tooling half of the finding only. The run itself needs a STAGING deploy
// and the owner's explicit approval — this script NEVER runs against
// production, and it refuses to:
//   - run without LOAD_TEST_CONFIRM=1, and
//   - run against any production host (metricflock.bond and the three
//     production Vercel aliases from the live project object).
//
// Usage (from the repo root):
//   LOAD_TEST_CONFIRM=1 node apps/web/scripts/load-test.mjs --url <staging-url> [--seconds 30] [--json] [--out results.json]
//   node apps/web/scripts/load-test.mjs --url <staging-url> --dry-run   # prints the plan, sends no traffic
//
// What it does: ramps 10 -> 50 -> 100 concurrent users, each stage lasting
// --seconds (default 30), looping over the endpoint list round-robin, and
// records p50/p95/p99 latency + error rate per endpoint. Only GETs, no
// writes, no DB access. Public read paths always run; the authenticated
// paths run only when LOAD_TEST_COOKIE is set (see below).
//
// Authenticated paths (optional): sign in to the STAGING deploy in a
// browser, copy the session cookie from devtools, and export it —
//   LOAD_TEST_COOKIE="<name>=<value>; ..." \
//   LOAD_TEST_WEBSITE_ID="<a staging website id>" \
//   LOAD_TEST_CONFIRM=1 node apps/web/scripts/load-test.mjs --url <staging-url>
// The cookie is read from the environment only (never a CLI flag, so it
// does not land in shell history), never logged, and never committed.
// Without it, only the public paths are exercised.
//
// Pass/fail bar (PROPOSAL for the owner to confirm — not a committed SLO):
// overall error rate <= --max-error-rate (default 1%) and p95 < 2000 ms
// per endpoint. The script exits 1 when the bar is missed.

import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

export const PRODUCTION_HOSTS = new Set([
  "metricflock.bond",
  "metricflock.vercel.app",
  "metricflock-zuhan4.vercel.app",
  "metricflock-git-main-zuhan4.vercel.app",
]);

export const STAGES = [10, 50, 100];
export const DEFAULT_SECONDS_PER_STAGE = 30;
export const DEFAULT_MAX_ERROR_RATE_PERCENT = 1;
export const REQUEST_TIMEOUT_MS = 10_000;
export const COOLDOWN_MS = 5_000;

export const PUBLIC_ENDPOINTS = [
  { label: "health", path: "/api/health" },
  { label: "health-ready", path: "/api/health/ready" },
  { label: "login-page", path: "/login" },
  { label: "root", path: "/" },
];

export const AUTHENTICATED_ENDPOINTS = [
  { label: "dashboard", path: "/dashboard" },
  { label: "websites-api", path: "/api/websites" },
  // websiteId is filled in by buildPlan when LOAD_TEST_WEBSITE_ID is set.
  { label: "analytics-overview", path: "/api/analytics/overview?websiteId={websiteId}" },
];

/** Nearest-rank percentiles over an array of millisecond latencies. */
export function computePercentiles(latenciesMs) {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return { count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null };
  }
  const sum = sorted.reduce((a, b) => a + b, 0);
  const rank = (p) => sorted[Math.max(0, Math.ceil((p / 100) * n) - 1)];
  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    mean: Math.round((sum / n) * 10) / 10,
    p50: rank(50),
    p95: rank(95),
    p99: rank(99),
  };
}

export function isProductionHost(hostname) {
  return PRODUCTION_HOSTS.has(hostname.toLowerCase());
}

/** Parse argv (without the node/script entries). Throws on bad input. */
export function parseArgs(argv) {
  const opts = {
    seconds: DEFAULT_SECONDS_PER_STAGE,
    maxErrorRate: DEFAULT_MAX_ERROR_RATE_PERCENT,
    dryRun: false,
    json: false,
    url: null,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = (name) => {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${name}`);
      return value;
    };
    if (arg === "--url") opts.url = takeValue("--url");
    else if (arg === "--seconds") {
      const n = Number(takeValue("--seconds"));
      if (!Number.isInteger(n) || n <= 0) throw new Error("--seconds must be a positive integer");
      opts.seconds = n;
    } else if (arg === "--max-error-rate") {
      const n = Number(takeValue("--max-error-rate"));
      if (Number.isNaN(n) || n < 0 || n > 100) throw new Error("--max-error-rate must be between 0 and 100");
      opts.maxErrorRate = n;
    } else if (arg === "--out") opts.out = takeValue("--out");
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.help && !opts.url) throw new Error("--url <staging-url> is required (or --help)");
  return opts;
}

/**
 * Guard the target. Throws unless the URL is not a production host.
 * Remote targets must be https; http is allowed only for localhost.
 * The explicit operator confirmation (confirm === "1") is required for a
 * real run; a dry run (requireConfirm === false) sends no traffic, so it
 * only needs the host checks.
 */
export function validateTarget(urlString, confirm, { requireConfirm = true } = {}) {
  if (requireConfirm && confirm !== "1") {
    throw new Error("Refusing to run: set LOAD_TEST_CONFIRM=1 (this sends real traffic to the target).");
  }
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Refusing to run: not a valid URL: ${urlString}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Refusing to run: unsupported protocol ${url.protocol} (use http(s)).`);
  }
  if (isProductionHost(url.hostname)) {
    throw new Error(
      `Refusing to run: ${url.hostname} is a production host. Use a staging/preview deployment URL, never production.`,
    );
  }
  if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Refusing to run: remote targets must use https (http is allowed only for localhost).");
  }
  return url;
}

/**
 * Assemble the run plan: stages, endpoints, and total wall time.
 * @param {{ url: URL, seconds: number, cookie?: string, websiteId?: string }} opts
 */
export function buildPlan({ url, seconds, cookie, websiteId }) {
  const endpoints = [...PUBLIC_ENDPOINTS];
  if (cookie) {
    for (const endpoint of AUTHENTICATED_ENDPOINTS) {
      if (endpoint.label === "analytics-overview" && !websiteId) continue;
      endpoints.push({ ...endpoint, path: endpoint.path.replace("{websiteId}", websiteId ?? "") });
    }
  }
  return {
    baseUrl: url.toString().replace(/\/$/, ""),
    stages: [...STAGES],
    secondsPerStage: seconds,
    endpoints,
    authenticated: Boolean(cookie),
    totalSeconds: STAGES.length * seconds + (STAGES.length - 1) * (COOLDOWN_MS / 1000),
  };
}

function newStats() {
  return { requests: 0, errors: 0, latencies: [] };
}

async function runStage(plan, concurrency, seconds, headers) {
  const stats = new Map(plan.endpoints.map((e) => [e.label, newStats()]));
  const deadline = Date.now() + seconds * 1000;
  let next = 0;
  async function worker() {
    while (Date.now() < deadline) {
      const endpoint = plan.endpoints[next++ % plan.endpoints.length];
      const s = stats.get(endpoint.label);
      const started = Date.now();
      try {
        const res = await fetch(`${plan.baseUrl}${endpoint.path}`, {
          headers,
          redirect: "follow",
          // globalThis: the lint config allowlists only ES builtins +
          // fetch/URL, so the bare AbortSignal global would fail lint.
          signal: globalThis.AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        s.latencies.push(Date.now() - started);
        s.requests++;
        if (res.status >= 400) s.errors++;
      } catch {
        s.latencies.push(Date.now() - started);
        s.requests++;
        s.errors++;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return stats;
}

function summarize(allStageStats, plan, maxErrorRate) {
  const endpoints = {};
  let totalRequests = 0;
  let totalErrors = 0;
  for (const endpoint of plan.endpoints) {
    const latencies = allStageStats.flatMap((stage) => stage.get(endpoint.label).latencies);
    const requests = latencies.length;
    const errors = allStageStats.reduce((sum, stage) => sum + stage.get(endpoint.label).errors, 0);
    totalRequests += requests;
    totalErrors += errors;
    endpoints[endpoint.label] = {
      path: endpoint.path,
      ...computePercentiles(latencies),
      errors,
      errorRatePercent: requests === 0 ? null : Math.round((errors / requests) * 1000) / 10,
    };
  }
  const errorRatePercent = totalRequests === 0 ? null : Math.round((totalErrors / totalRequests) * 1000) / 10;
  const worstP95 = Math.max(0, ...Object.values(endpoints).map((e) => e.p95 ?? 0));
  return {
    baseUrl: plan.baseUrl,
    stages: plan.stages,
    secondsPerStage: plan.secondsPerStage,
    authenticated: plan.authenticated,
    endpoints,
    totalRequests,
    totalErrors,
    errorRatePercent,
    worstP95Ms: worstP95,
    // Proposed bar (owner to confirm): error rate within budget AND p95 < 2s.
    passed: errorRatePercent !== null && errorRatePercent <= maxErrorRate && worstP95 < 2000,
    maxErrorRatePercent: maxErrorRate,
    p95BudgetMs: 2000,
  };
}

function printHuman(summary) {
  console.log(
    `\nLoad test: ${summary.baseUrl} (stages ${summary.stages.join("/")} users, ${summary.secondsPerStage}s each)`,
  );
  console.log("endpoint            reqs  errs  err%   p50   p95   p99  mean");
  for (const [label, e] of Object.entries(summary.endpoints)) {
    const pad = (v, w) => String(v ?? "-").padStart(w);
    console.log(
      `${label.padEnd(19)} ${pad(e.count, 5)} ${pad(e.errors, 5)} ${pad(e.errorRatePercent, 5)} ${pad(e.p50, 5)} ${pad(e.p95, 5)} ${pad(e.p99, 5)} ${pad(e.mean, 5)}`,
    );
  }
  console.log(
    `TOTAL ${summary.totalRequests} requests, ${summary.totalErrors} errors (${summary.errorRatePercent}%); worst p95 ${summary.worstP95Ms} ms — ${summary.passed ? "PASS" : "FAIL"} (bar: error rate <= ${summary.maxErrorRatePercent}%, p95 < ${summary.p95BudgetMs} ms)`,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(
      "Usage: LOAD_TEST_CONFIRM=1 node apps/web/scripts/load-test.mjs --url <staging-url> [--seconds 30] [--max-error-rate 1] [--json] [--out results.json] [--dry-run]\n" +
        "Env: LOAD_TEST_COOKIE (optional session cookie for authenticated paths), LOAD_TEST_WEBSITE_ID (optional, enables /api/analytics/overview).",
    );
    return 0;
  }
  const url = validateTarget(opts.url, env.LOAD_TEST_CONFIRM, { requireConfirm: !opts.dryRun });
  const plan = buildPlan({
    url,
    seconds: opts.seconds,
    cookie: env.LOAD_TEST_COOKIE,
    websiteId: env.LOAD_TEST_WEBSITE_ID,
  });
  if (opts.dryRun) {
    console.log("DRY RUN — no traffic sent.");
    console.log(`Target: ${plan.baseUrl}`);
    console.log(
      `Stages: ${plan.stages.join(" -> ")} concurrent users, ${plan.secondsPerStage}s each (total ~${plan.totalSeconds}s)`,
    );
    console.log(
      `Endpoints (${plan.endpoints.length}): ${plan.endpoints.map((e) => `${e.label} ${e.path}`).join(", ")}`,
    );
    console.log(
      `Authenticated paths: ${plan.authenticated ? "enabled (LOAD_TEST_COOKIE set)" : "skipped (LOAD_TEST_COOKIE not set)"}`,
    );
    return 0;
  }
  const headers = env.LOAD_TEST_COOKIE ? { cookie: env.LOAD_TEST_COOKIE } : {};
  const allStageStats = [];
  for (let i = 0; i < plan.stages.length; i++) {
    const concurrency = plan.stages[i];
    console.log(`Stage ${i + 1}/${plan.stages.length}: ${concurrency} concurrent users for ${plan.secondsPerStage}s…`);
    allStageStats.push(await runStage(plan, concurrency, plan.secondsPerStage, headers));
    if (i < plan.stages.length - 1) await sleep(COOLDOWN_MS);
  }
  const summary = summarize(allStageStats, plan, opts.maxErrorRate);
  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  else printHuman(summary);
  if (opts.out) writeFileSync(opts.out, JSON.stringify(summary, null, 2));
  return summary.passed ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
