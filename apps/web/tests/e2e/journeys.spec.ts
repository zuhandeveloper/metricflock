import { test, expect, request as apiRequest, type APIRequestContext } from "@playwright/test";
import { execSync } from "node:child_process";
import path from "node:path";
import { DEMO_PASSWORD, STORAGE_STATE } from "./constants";

// Core user journeys through the real UI (Phase 8). Names are unique
// per run so the suite is re-runnable against the same database.
test.use({ storageState: STORAGE_STATE });

const stamp = Date.now().toString(36);

test("create a team from the Teams page", async ({ page }) => {
  await page.goto("/teams");
  await page.getByLabel(/team name/i).fill(`E2E Team ${stamp}`);
  await page.getByLabel(/slug/i).fill(`e2e-team-${stamp}`);
  await page.getByRole("button", { name: /create team/i }).click();
  await expect(page.getByText(`E2E Team ${stamp}`)).toBeVisible();
});

test("create a website from the Websites page", async ({ page }) => {
  await page.goto("/websites");
  await page.getByLabel("Website name", { exact: true }).fill(`E2E Site ${stamp}`);
  await page.getByLabel("Domain", { exact: true }).fill(`e2e-${stamp}.example.com`);
  await page.getByRole("button", { name: /add website|create website/i }).click();
  await expect(page.getByText(`e2e-${stamp}.example.com`)).toBeVisible();
});

// A-FE-01: double-clicking "Add website" must create exactly one website —
// the submit button is disabled while the request is in flight.
test("double-clicking Add website creates exactly one website", async ({ page }) => {
  await page.goto("/websites");
  const domain = `e2e-dbl-${stamp}.example.com`;
  await page.getByLabel("Website name", { exact: true }).fill(`E2E Double ${stamp}`);
  await page.getByLabel("Domain", { exact: true }).fill(domain);
  await page.getByRole("button", { name: /add website|create website/i }).dblclick();
  await expect(page.getByText(domain)).toBeVisible();
  await expect(page.getByRole("row", { name: domain })).toHaveCount(1);
});

test("create and revoke an API key", async ({ page }) => {
  await page.goto("/settings/api-keys");
  await page.getByLabel(/key name/i).fill(`E2E key ${stamp}`);
  await page.getByRole("button", { name: /create api key/i }).click();
  // The secret is shown once.
  await expect(page.getByText(/copy this secret now/i)).toBeVisible();
  await expect(page.getByText(`E2E key ${stamp}`)).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  const row = page.getByRole("row", { name: new RegExp(`E2E key ${stamp}`) });
  await row.getByRole("button", { name: /revoke/i }).click();
  await expect(row.getByText(/revoked/i)).toBeVisible();
});

test("save a weekly report schedule", async ({ page }) => {
  await page.goto("/settings/reports");
  await page.getByLabel(/send the weekly report automatically/i).check();
  await page.getByLabel(/day \(utc\)/i).selectOption("3"); // Wednesday
  await page.getByRole("button", { name: /save schedule/i }).click();
  await expect(page.getByText(/schedule saved/i)).toBeVisible();
});

// A-FE-08: starting 2FA setup must show a scannable QR code for the
// totpURI alongside the manual setup key. The setup is left unverified
// on purpose (verifying would turn 2FA on for the demo user).
test("2FA setup shows a QR code to scan", async ({ page }) => {
  await page.goto("/settings/security");
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: /enable two-factor/i }).click();
  await expect(page.getByRole("img", { name: /qr code/i })).toBeVisible();
  await expect(page.getByText(/setup key/i)).toBeVisible();
});

test("mobile navigation opens, navigates, and closes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: /open navigation/i }).click();
  const drawer = page.getByRole("dialog", { name: /navigation/i });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("link", { name: /websites/i }).click();
  await expect(page).toHaveURL(/\/websites/);
  await expect(drawer).toBeHidden();
});

// --- A-COV-13: journeys for the remaining management flows -------------
// Each journey drives the real UI and then asserts the resulting SERVER
// STATE through the app's API (not just visible text): transfer status
// and website team after accept/complete, org + role after invite
// accept, DLQ membership after requeue. Setup goes through the API
// where the UI flow needs preconditions. Two preconditions cannot be
// created through the public API — a verified user (sign-up requires
// email verification; CI has no inbox) and a terminally FAILED sync
// job (no API fails a job) — so those use the repo's own CI fixture
// scripts, exactly as scripts/smoke-test.sh does. DATABASE_URL comes
// from the CI job env; DOTENV_CONFIG_PATH mirrors smoke for local runs
// against apps/web/.env.
function runDbScript(script: string, arg = ""): string {
  const repoRoot = path.resolve(test.info().config.rootDir, "../..");
  return execSync(`pnpm --filter @metricflock/db exec tsx scripts/${script} ${arg}`.trim(), {
    cwd: repoRoot,
    env: { ...process.env, DOTENV_CONFIG_PATH: path.join(repoRoot, "apps/web/.env") },
    encoding: "utf8",
    timeout: 120_000,
  });
}

// better-auth rate-limits /sign-in/email and /sign-up/email (3 per 10s
// per IP); the setup project and sibling specs sign in around the same
// time, so wait out a 429 via its Retry-After instead of failing
// (same pattern as session-revoke.spec.ts).
async function authPost(ctx: APIRequestContext, url: string, data: Record<string, unknown>) {
  let res = await ctx.post(url, { data });
  for (let attempt = 0; res.status() === 429 && attempt < 3; attempt++) {
    const retryAfter = Number(res.headers()["retry-after"] ?? 10);
    await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
    res = await ctx.post(url, { data });
  }
  return res;
}

type AuditLog = { action: string; entityId: string | null; details: Record<string, unknown> | null };

async function auditHas(request: APIRequestContext, action: string, match: (log: AuditLog) => boolean) {
  const res = await request.get("/api/audit?limit=100");
  if (!res.ok()) throw new Error(`audit read failed: ${res.status()} ${await res.text()}`);
  const body = (await res.json()) as { logs: AuditLog[] };
  return body.logs.some((log) => log.action === action && match(log));
}

// The two-sided transfer lifecycle through the real UI: initiate via
// API (the website page's transfer form is component-tested), then
// accept and complete from /transfers. Nothing moves at accept; the
// website's team flips only at completion. Completion requires the
// destination team to hold an ACTIVE Google connection — in CI the
// smoke stage-2 fixture gives team-b one; without it the Complete
// click surfaces destination_not_connected and this test fails at the
// COMPLETED badge (diagnosable, by design).
test("transfer accept and complete via the Transfers page", async ({ page }) => {
  const run = `${stamp}-${Date.now().toString(36)}`;
  const name = `E2E Transfer ${run}`;
  const teamsRes = await page.request.get("/api/teams?limit=200");
  expect(teamsRes.ok(), await teamsRes.text()).toBeTruthy();
  const teams = ((await teamsRes.json()) as { teams: { id: string; slug: string }[] }).teams;
  const teamB = teams.find((t) => t.slug === "team-b");
  if (!teamB) throw new Error("seeded team-b not found via GET /api/teams");

  const createRes = await page.request.post("/api/websites", {
    data: { name, domain: `e2e-transfer-${run}.example.com`, url: `https://e2e-transfer-${run}.example.com` },
  });
  expect(createRes.status(), await createRes.text()).toBe(201);
  const website = ((await createRes.json()) as { website: { id: string } }).website;

  const initRes = await page.request.post(`/api/websites/${website.id}/transfer`, {
    data: { toTeamId: teamB.id, reason: "e2e journey" },
  });
  expect(initRes.ok(), await initRes.text()).toBeTruthy();
  const transfer = ((await initRes.json()) as { transfer: { id: string; status: string } }).transfer;
  expect(transfer.status).toBe("PENDING_ACCEPTANCE");

  const websiteTeamId = async () => {
    const res = await page.request.get("/api/websites?limit=200");
    if (!res.ok()) throw new Error(`websites read failed: ${res.status()}`);
    const list = ((await res.json()) as { websites: { id: string; teamId: string | null }[] }).websites;
    return list.find((w) => w.id === website.id)?.teamId;
  };

  await page.goto("/transfers");
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.getByText("PENDING_ACCEPTANCE")).toBeVisible();

  await row.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(row.getByText("PENDING_CONNECTION")).toBeVisible();
  // Server state: accepted, but the website has NOT moved yet.
  expect(await websiteTeamId()).not.toBe(teamB.id);
  await expect
    .poll(() => auditHas(page.request, "website.transfer.accepted", (log) => log.details?.transferId === transfer.id))
    .toBe(true);

  await row.getByRole("button", { name: "Complete transfer", exact: true }).click();
  await expect(row.getByText("COMPLETED")).toBeVisible();
  // Server state: the website now belongs to the destination team.
  await expect.poll(websiteTeamId).toBe(teamB.id);
  await expect
    .poll(() => auditHas(page.request, "website.transfer.completed", (log) => log.details?.transferId === transfer.id))
    .toBe(true);
});

// Invite accept for an EXISTING account through the real UI: the
// invitee (own empty shell org) opens /invite/<token> signed in and
// clicks Accept; the account moves into the inviting org with the
// invite's role. The invitee is verified via the repo's
// smoke-verify-user fixture (sign-up requires email verification and
// CI has no inbox — same approach as smoke-test.sh's invitee).
test("invite accept moves an existing account into the organization", async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const run = `${stamp}-${Date.now().toString(36)}`;
  const email = `e2e-invitee-${run}@example.com`;
  const password = `E2e-${run}-pass!`;

  // Invitee account in its own shell org (clean jar: no cookies, so
  // better-auth's origin check is skipped for the sign-up POST).
  const inviteeApi = await apiRequest.newContext({
    baseURL: baseURL ?? undefined,
    storageState: { cookies: [], origins: [] },
  });
  const signUp = await authPost(inviteeApi, "/api/auth/sign-up/email", { name: "E2E Invitee", email, password });
  expect(signUp.ok(), `sign-up failed: ${signUp.status()} ${await signUp.text()}`).toBeTruthy();
  await inviteeApi.dispose();
  runDbScript("smoke-verify-user.ts", email);

  // The demo admin invites the existing account.
  const inviteRes = await page.request.post("/api/members/invite", { data: { email, role: "TEAM_MEMBER" } });
  expect(inviteRes.status(), await inviteRes.text()).toBe(201);
  const { inviteUrl } = (await inviteRes.json()) as { inviteUrl: string };
  // inviteUrl carries the build-time NEXT_PUBLIC_APP_URL host; only the
  // path is meaningful against this server.
  const invitePath = new URL(inviteUrl).pathname;

  const adminSession = await page.request.get("/api/auth/get-session");
  expect(adminSession.ok()).toBeTruthy();
  const adminOrgId = ((await adminSession.json()) as { user: { organizationId: string } }).user.organizationId;

  // The invitee signs in (API — cookies land in this context's jar) and
  // accepts through the invite page UI.
  const inviteeContext = await browser.newContext({ baseURL: baseURL ?? undefined });
  const signIn = await authPost(inviteeContext.request, "/api/auth/sign-in/email", { email, password });
  expect(signIn.ok(), `sign-in failed: ${signIn.status()} ${await signIn.text()}`).toBeTruthy();
  const inviteePage = await inviteeContext.newPage();
  await inviteePage.goto(invitePath);
  await expect(inviteePage.getByText(/invited/)).toBeVisible();
  await inviteePage.getByRole("button", { name: "Accept invite" }).click();
  await expect(inviteePage).toHaveURL(/\/dashboard/);

  // Server state: the invitee now belongs to the admin's org as
  // TEAM_MEMBER, and the accept was audited in that org.
  const sessionRes = await inviteeContext.request.get("/api/auth/get-session");
  expect(sessionRes.ok()).toBeTruthy();
  const inviteeUser = ((await sessionRes.json()) as { user: { organizationId: string; role: string } }).user;
  expect(inviteeUser.organizationId).toBe(adminOrgId);
  expect(inviteeUser.role).toBe("TEAM_MEMBER");
  await expect
    .poll(() => auditHas(page.request, "member.invite_accepted", (log) => log.details?.email === email))
    .toBe(true);
  await inviteeContext.close();
});

// Dead-letter requeue through the real UI: a terminally FAILED job
// (fixtured by the repo's smoke-failed-job script — no API can fail a
// job) is requeued from /sync. The failed table is newest-first and
// nothing else creates FAILED rows during e2e, so the fixture is the
// first data row; the API assertions fail loudly if the wrong row was
// clicked.
test("requeue a failed sync job from the Sync jobs page", async ({ page }) => {
  test.setTimeout(120_000);
  const out = runDbScript("smoke-failed-job.ts");
  const jobId = /FAILED_JOB_ID=([A-Za-z0-9_-]+)/.exec(out)?.[1];
  if (!jobId) throw new Error(`failed-job fixture printed no id: ${out}`);

  const failedIds = async () => {
    const res = await page.request.get("/api/sync/failed?limit=200");
    if (!res.ok()) throw new Error(`failed-jobs read failed: ${res.status()}`);
    return ((await res.json()) as { jobs: { id: string }[] }).jobs.map((j) => j.id);
  };
  expect(await failedIds()).toContain(jobId);

  await page.goto("/sync");
  const firstRow = page.getByRole("table").first().getByRole("row").nth(1);
  await expect(firstRow).toBeVisible();
  await firstRow.getByRole("button", { name: "Requeue", exact: true }).click();

  // Server state: the job left the dead-letter list (its row flipped
  // back to PENDING) and the requeue was audited.
  await expect.poll(failedIds).not.toContain(jobId);
  await expect.poll(() => auditHas(page.request, "sync.job.requeued", (log) => log.entityId === jobId)).toBe(true);
});
