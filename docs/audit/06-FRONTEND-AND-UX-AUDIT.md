# Phase 6 — Frontend & UX Functional Audit

**Repo:** `~/workspace/metricflock/` · **HEAD:** `6e6d2b21` · **Date:** 2026-11-23
**Auditor:** independent production-readiness audit (Phase 6 of 9)
**Scope:** all 20 `page.tsx` files under `apps/web/src/app` (14 app pages,
login / forgot-password / reset-password / invite / root), plus
`apps/web/src/components` (`Sidebar`, `MobileNav`, `ui.tsx`,
`WebsiteAnalytics`, `DateRangePicker`, `ThemeToggle`, `QueryProvider`),
the co-located client components (`WebsiteForms`, `WebsiteActions`,
`ConnectionActions`, `MemberForms`, `OrgAdminForms`, `TeamForms`,
`TransferActions`, `RequeueButton`, `ApiKeyManager`,
`ReportScheduleForm`, `SecurityActions`, `LoginForm`,
`ForgotPasswordForm`, `ResetPasswordForm`, `AcceptInviteButton`),
`apps/web/src/app/(app)/layout.tsx`, `apps/web/src/app/layout.tsx`,
`not-found.tsx`, `(app)/loading.tsx`, `(app)/error.tsx`,
`apps/web/tests/e2e/*.spec.ts`, and the API routes each control calls
(read to verify the control performs its action).

## Method & limits — read first

- **No prior audit doc was trusted.** Every claim was re-checked against
  current source at HEAD `6e6d2b21` (file:line cited). "A control works"
  was verified by reading the client component **and** the API route it
  calls, not by the existence of either alone.
- **No browser was run in this audit.** All visual, responsive,
  hydration and runtime-behaviour checks that need a browser are marked
  **NOT RUN**. What _was_ verified statically: labels/associations,
  `role="alert"` placement, busy-state handling, empty states, link/image
  targets present in the repo, colour-contrast ratios computed from the
  Tailwind palette with the WCAG formula (Node), and the Playwright specs'
  coverage (read, not executed — e2e runs in CI only).
- **What WAS executed here:** full unit suite `pnpm vitest run` —
  **196 passed / 196** (2026-11-23); `pnpm --filter @metricflock/worker
typecheck` — exit 0. Neither covers browser behaviour.
- **E2E count (recounted from the specs, not the brief):** `journeys.spec.ts`
  5 tests + `accessibility.spec.ts` 5 (2 axe loop + 3 named) +
  `app-accessibility.spec.ts` 13 (12 axe loop + skip-link) = **23 tests**.
  The brief said 24; I count 23 in the files at HEAD.
- **Severity:** P0 critical · P1 high · P2 medium · P3 low.
  **Verification:** CONFIRMED = traced in current source; POTENTIAL =
  follows from the code but needs a browser run to observe.

## Findings

### A-FE-01 — P1 — CONFIRMED — Duplicate-submission guard is missing almost everywhere: `busy` only changes the label, the button stays live

- **Where:** `apps/web/src/components/ui.tsx:34-58` (`Button` — no
  `disabled` prop at all); every form except the two noted below.
- **Evidence:** the shared `Button` accepts `type`, `variant`, `onClick`,
  `className` — **no `disabled`**. Every submit handler sets a `busy`
  label ("Adding…", "Saving…", "Queueing…") but never disables the
  button and never early-returns on `busy`. Grep over `src/app` +
  `src/components`: the only `disabled={` uses in the whole app are the
  native `<select disabled={busy}>` in `RoleSelect`
  (`members/MemberForms.tsx:183`) and the Sidebar sign-out button
  (`Sidebar.tsx:88`). The only `if (busy) return` guards are in
  `ApiKeyManager.tsx:30,42` (`create`/`revoke`) and
  `ReportScheduleForm.tsx:34,52` (`save`/`sendTest`). Everything else —
  `AddWebsiteForm`, `EditWebsiteForm`, `DeleteWebsiteButton`,
  `SyncNowForm`, `AssignForm`, `TransferForm`, `CreateTeamForm`,
  `TeamAdminControls` (rename/add/remove/toggle-admin),
  `InviteForm`, `RevokeInviteButton`, `DeleteMemberButton`,
  `DisconnectButton`, `DiscoverButton`, `MapPropertyForm`,
  `RequeueButton`, `TransferActions`, `SessionActions`,
  `TwoFactorActions`, `LoginForm`, `ForgotPasswordForm`,
  `ResetPasswordForm`, `AcceptInviteButton`, `OrgAdminActions` — is a
  double-click / double-Enter away from a second POST. Server-side
  idempotency for these POSTs was **not** verified in this phase (no
  idempotency keys were seen in the routes read), so the client is the
  only guard and it is absent.
- **Reproduction (NOT RUN in browser):** double-click "Add website"
  (or press Enter twice) with a slow network; observe two `POST
/api/websites` and two websites. Same for "Create team", "Send invite",
  "Accept" on a transfer, "Requeue".
- **Impact:** duplicate websites, teams, invites, transfers and API keys;
  double transfer-accepts; double requeues. The most damaging cases are
  the destructive/irreversible ones (delete, transfer accept) and the
  ones whose duplicates are hard to spot (a second website row).
- **Correction:** add `disabled` to the shared `Button` (pass-through to
  the native button, with `disabled:opacity-50`), wire
  `disabled={busy}` on every submit/action button, and add an
  `if (busy) return` guard at the top of every handler. Preferably also
  add server-side idempotency (or a unique constraint where one exists)
  for create operations.
- **Regression test:** Playwright journey test double-clicking "Add
  website" / "Create team" and asserting a single row is created; unit
  test that `Button` forwards `disabled`.

### A-FE-02 — P1 — CONFIRMED — Websites list silently caps at 100 rows with no pagination and no count

- **Where:** `apps/web/src/app/(app)/websites/page.tsx:31-40`
  (`take: 100`, no `count`, no pagination UI).
- **Evidence:** the query takes the first 100 websites (ordered by
  creation, desc) and renders them; there is no total, no "showing 100 of
  N", and no next-page control. The dashboard — the comparable list —
  _does_ paginate at 50 with a total (`dashboard/page.tsx:52, 230-261`).
  The filter form (`q`/`status`) is server-side, so search can still find
  a site past row 100, but plain browsing silently hides it. For a
  product whose premise is 100+ website portfolios, the cap is hit by
  design, not by accident.
- **Reproduction (NOT RUN live — needs >100 sites + DB):** create 101
  websites; the 101st never appears in the list.
- **Impact:** users cannot see or open their oldest websites from the
  Websites page; support-visible data loss (the sites exist, the UI
  hides them).
- **Correction:** paginate like the dashboard (50/page with total), or at
  minimum render the total count and a "showing first 100" notice.
- **Regression test:** e2e/unit test with a >100-site fixture asserting
  pagination controls appear and every site is reachable.

### A-FE-03 — P2 — CONFIRMED — Integrations page loads everything unbounded (connections × properties × websites) · FIXED 2026-11-24

- **Where:** `apps/web/src/app/(app)/integrations/page.tsx:19-45`.
- **Evidence:** three unbounded `findMany`s — all connections with nested
  includes (`health` take 3, but `properties` /
  `searchConsoleProps` / `adsenseAccounts` / `adManagerNetworks` each with
  their integrations and websites), **all** teams, **all** websites — no
  `take`, no pagination. This is the page Phase 5's bounding work
  (dashboard 50/page, health 50/page, insights 50 sites) did not reach.
  At 100+ sites/connections it is the heaviest server-component render in
  the app, and it also renders one "Connect website: …" link per website,
  so the connect card itself grows without bound.
- **Impact:** slow page loads and large HTML payloads at portfolio scale;
  the page degrades exactly as the portfolio grows.
- **Correction:** paginate connections (e.g. 20/page) and cap the
  connect-link lists (searchable select instead of one link per website),
  or lazy-load properties per connection behind an expand control.
- **Regression test:** benchmark the page's query set at 1k sites (see
  Phase 5 doc A-WRK-12) with a time budget.
- **Verification (2026-11-24):** paginated connections (20/page, count +
  skip/take, pager preserving the search) and capped the team/website
  option lists at 20, narrowed by a page-level search — the connect card
  is now two GET forms with selects instead of one link per team/website,
  and the map forms receive the same capped list (a native select is
  keyboard-searchable; a search with no matches says so instead of
  claiming no website exists). Owner names are fetched only for the
  connections on the page (by id, bounded by the page size). Small orgs
  behave as before: all connections on page 1, Discover/Disconnect and
  the connect flow intact. Tests in
  `pages-insights-integrations.test.tsx` (6 new; all 6 fail without the
  fix). The 1k-site benchmark the finding asks for is pending the
  A-WRK-12 real-DB run (owner approval).

### A-FE-04 — P2 — CONFIRMED (static ratios) — Dark-mode text contrast fails 4.5:1 for links, muted text, and error/success/warning text · FIXED 2026-11-24

- **Where:** throughout — `text-blue-600` links (e.g.
  `dashboard/page.tsx`, `websites/page.tsx:111`,
  `WebsiteAnalytics.tsx:73,298`, auth forms), `text-zinc-500` small text
  (dozens of sites), `text-red-700` / `text-emerald-700` /
  `text-amber-700` status text (27 `role="alert"` sites and success
  notes), none with a `dark:` variant.
- **Evidence — ratios computed with the WCAG formula (Node) from the
  Tailwind palette:**
  | Text                                                                    | on white (light) | on zinc-900 `#18181b` (dark card) | on zinc-950 `#09090b` (dark page) |
  | ----------------------------------------------------------------------- | ---------------- | --------------------------------- | --------------------------------- |
  | blue-600 `#2563eb` (links)                                              | **5.17 ✓**       | **3.43 ✗**                        | 3.85 ✗                            |
  | zinc-500 `#71717a` (muted, text-xs/sm)                                  | **4.83 ✓**       | **3.67 ✗**                        | 4.12 ✗                            |
  | red-700 `#b91c1c` (errors)                                              | **6.47 ✓**       | **2.74 ✗**                        | 3.07 ✗                            |
  | emerald-700 `#047857` (success)                                         | **5.48 ✓**       | **3.23 ✗**                        | 3.63 ✗                            |
  | amber-700 `#b45309` (warnings)                                          | **5.02 ✓**       | **3.53 ✗**                        | 3.96 ✗                            |
  | Light mode passes everywhere (the Phase 8 `-600 → -700` sweep did its   |
  | job there). Dark mode fails everywhere the colour has no `dark:`        |
  | variant. Note the `Badge` tones _do_ carry dark variants                |
  | (`ui.tsx:20-23`, e.g. `dark:text-emerald-300`) — the error/success      |
  | spans and links were simply not swept. Dark mode is a manual            |
  | class-toggle (`ThemeToggle.tsx`, no persistence — see A-FE-12), and the |
  | axe e2e specs run in light mode by default, so this is uncaught by the  |
  | current gate.                                                           |
- **Reproduction (NOT RUN in browser):** toggle Dark, open the dashboard
  and any error state; observe muted/link/error text below 4.5:1.
  (Ratios above are computed, not screenshotted.)
- **Impact:** dark-mode users get unreadable links, errors and muted
  text — an accessibility failure in the theme the app itself offers.
- **Correction:** add `dark:` variants (`dark:text-blue-400`,
  `dark:text-zinc-400`, `dark:text-red-400`, `dark:text-emerald-400`,
  `dark:text-amber-400` — all ≥ 4.5:1 on zinc-900) or run the axe suite
  once in dark mode.
- **Regression test:** Playwright axe run with the `dark` class forced on
  (or `colorScheme: dark`), asserting zero critical/serious violations.
- **Verification (2026-11-24):** swept all five colours — 162 `dark:`
  variants added across 37 files (`dark:text-blue-400`,
  `dark:text-zinc-400`, `dark:text-red-400`, `dark:text-emerald-400`,
  `dark:text-amber-400`). Ratios recomputed with the WCAG formula: the
  replacements pass 4.5:1 on every dark background the app uses
  (zinc-900: 6.97 / 6.91 / 6.40 / 9.22 / 10.61; zinc-950: 7.83 / 7.76 /
  7.19 / 10.35 / 11.92; zinc-800 and amber-950 also pass). The `Badge`
  tones already carried `dark:text-*-300` and were left alone. 22 uses in
  the two A-FE-03 files (`integrations/page.tsx`, `ConnectionActions.tsx`)
  could not be touched (A-FE-03 file freeze) and are allowlisted in the
  regression test with a stale-allowlist guard. Regression test
  `dark-mode-contrast.test.ts` (3 tests: replacement ratios, original
  colours failing on zinc-900, and a source scan requiring a passing dark
  variant for every use; fail-without-fix verified by stripping one
  variant). The dark-mode axe run the finding asks for is still a CI
  follow-up (e2e, not run locally).

### A-FE-05 — P2 — CONFIRMED — Login collapses every failure into "Invalid email or password" — FIXED 2026-11-24

- **Verification (2026-11-24):** fixed in `LoginForm.tsx` — new `authErrorMessage` helper maps status + the API's error code: 429 or `too_many_requests`/`rate_limited` → "Too many attempts. Try again in a few minutes.", ≥500 or `internal_error`/`server_error` → "Something went wrong on our side. Try again in a moment.", 401 → the current "Invalid email or password." (the real login route returns `too_many_requests` on 429, `invalid_credentials` on 401). Same mapping on the 2FA verify path (fallback stays "That code didn't work…") and on `google()` via `socialErrorMessage` (better-auth error `status`/`code`; a status-less error keeps the existing "Google sign-in is not available right now…" message). Raw server error strings are never surfaced. The 2FA branch (`two_factor_required` → code form) is unchanged. No `Retry-After` handling — the login route sends no such header, so the message uses a fixed "few minutes" wording (route change needed first). Regression tests in `LoginForm.test.tsx` (6 new, all fail without the fix: 429/500 on login, `rate_limited` code with a 400 status, 429/500 on 2FA verify, 429 on Google sign-in). The A-FE-04 `dark:` variants in `LoginForm.tsx` are preserved byte-for-byte (5 variants intact, `dark-mode-contrast.test.ts` passes).

- **Where:** `apps/web/src/app/login/LoginForm.tsx:38-49` (`submit`),
  also `google()` (line 27-33) and `submitCode`.
- **Evidence:** any non-`ok` response from `/api/auth/login` — wrong
  password, rate-limit 429, server 500, 2FA-service error — sets the same
  `setError("Invalid email or password.")`. The user cannot distinguish
  "I mistyped" from "the server is rate-limiting me / down", so the
  natural response (retry the password, repeatedly) is the wrong one and
  can deepen a lockout. The response body is not even read on failure.
  (The 2FA branch itself is handled well — `two_factor_required`
  switches to the code form.)
- **Impact:** misleading error at the front door; wasted retries and
  support tickets during outages or rate-limit events.
- **Correction:** map status codes — 429 → "Too many attempts, try again
  in a few minutes", 5xx → "Something went wrong on our side, try again",
  401 → the current message. Read the API's error code where present.
- **Regression test:** e2e/unit test stubbing 429 and 500 responses and
  asserting distinct messages.

### A-FE-06 — P3 — POTENTIAL — Wide tables have no horizontal-scroll container (mobile overflow risk) · FIXED 2026-11-25

- **Where:** `dashboard/page.tsx`, `websites/page.tsx`,
  `health/page.tsx`, `sync/page.tsx`, `audit/page.tsx`,
  `transfers/page.tsx`, `members/page.tsx` — `table.w-full` inside
  `Card.p-4` with no `overflow-x-auto` wrapper anywhere in the app.
- **Evidence:** tables have up to 6 columns (Health, Sync) and are
  rendered at `text-sm` with no wrapping container; the parent `Card`
  has no `overflow-hidden`. A 6-column table's minimum content width
  exceeds a 390 px viewport, so the table will overflow its card and
  force page-level horizontal scrolling. The websites filter form
  (`websites/page.tsx:49`, `flex gap-2` with no `flex-wrap`) has the same
  shape of risk, though its input can shrink. The dashboard metric grid
  (`grid-cols-2 … md:grid-cols-4`) and the MobileNav drawer are fine.
- **Reproduction (NOT RUN — needs a 390 px browser viewport):** open
  `/health` and `/sync` at 390 px and check for horizontal overflow.
- **Impact:** mobile tables spill out of their cards; the app's core
  lists are the ones affected.
- **Correction:** wrap tables in `div.overflow-x-auto` (and add
  `flex-wrap` to the filter form).
- **Regression test:** Playwright viewport test at 390 px asserting
  `document.documentElement.scrollWidth <= innerWidth` on the table
  pages (extend `journeys.spec.ts` mobile test).
- **Verification (2026-11-25):** every wide table is now wrapped in a
  `div.overflow-x-auto` scroll container — all 11 tables across the
  dashboard (2), websites, health, sync (2), audit, transfers, and
  members pages named in the finding, plus the insights and API-keys
  tables, which were not named but have the same `table.w-full` in a
  Card shape and the same overflow risk. A 390 px viewport now scrolls
  the table inside its card instead of the page. The websites filter
  form gained `flex-wrap` (`flex flex-wrap gap-2`). Table content,
  columns, and data flow are unchanged; the dashboard metric grid and
  MobileNav needed no change, as the finding said. Regression guard: a
  source-scan unit test (`table-scroll-wrap.test.ts`, A-FE-04
  precedent) asserts every `<table>` in `src/` sits inside an
  `overflow-x-auto` wrapper and the websites filter form wraps — both
  assertions fail on the pre-fix code (11 unwrapped tables). The
  finding's Playwright 390 px viewport test remains a CI follow-up
  (e2e, not run locally).

### A-FE-07 — P2 — CONFIRMED — "Sync now" reports "Queued." even when nothing will run (see A-WRK-01) and shows no progress · FIXED 2026-11-24

- **Verification note (fixed 2026-11-24):** revalidated first — the dedup half was already covered by A-API-06 (route returns typed 200 `already_queued` / `already_completed` with `syncJobId`; the form shows "Already queued for this hour." / "Already synced this hour."). This fix adds the remaining parts: (1) the website detail page now shows the latest sync job — type label, status `Badge` (green SUCCEEDED, blue RUNNING, red FAILED, amber PENDING/RETRYING), updated time and `lastError` when present, or "No syncs yet." — from one bounded `findFirst` (`websiteId`, `updatedAt` desc) in the page's existing `Promise.all`, visible to all viewers (not just managers); a fresh queue calls `router.refresh()` so the new PENDING row appears. (2) `ga4-realtime-sync` and `analytics-cache-refresh` added to the API enum and the form's type list (7 types); the worker already handles both queues and `SYNC_TYPE_BY_QUEUE` maps them, so no worker change was needed. The A-API-06 hour-bucket dedup applies uniformly — the scheduler already refreshes realtime every ~5 min, so a second manual realtime click in the same hour honestly answers `already_queued` / `already_completed`. (3) No literal `deduped: true` flag added — the UI branches on the typed `status` + `syncJobId` A-API-06 already returns; the flag would be dead. A-API-06 behaviour preserved exactly (idempotency, `website.manage`, FAILED retry, P2002 race). Regression tests: 3 new page tests (FAILED job with error, never-synced, viewers see the status) + 2 new form tests (realtime submit + refresh, cache-refresh submit) + 1 new route test (both new types accepted with the right `SyncJobType`); the five-types test updated to seven — all 7 new/updated tests fail without the fix (verified by temporarily restoring the old code, fix restored byte-identical). The e2e test the finding asks for (click Sync now twice in an hour) is CI-only.

- **Where:** `apps/web/src/app/(app)/websites/[id]/WebsiteActions.tsx:336-375`
  (`SyncNowForm`), `apps/web/src/app/api/sync/route.ts:33`.
- **Evidence:** the form posts `{ websiteId, type }`, and on any 2xx
  shows "Queued." It does not distinguish a genuinely queued job from a
  BullMQ-deduped hour-bucket job (A-WRK-01), a `queue_unavailable` 503 is
  the only error surfaced, and after queueing the website page shows no
  job status — the user must navigate to `/sync` (SUPER_ADMIN only) to
  see anything. Also note the type list omits `ga4-realtime-sync` and
  `analytics-cache-refresh`, so there is no manual realtime refresh even
  though the API enum (`api/sync/route.ts`) also omits them — consistent,
  but a gap for the realtime use-case.
- **Impact:** false confirmation; users re-click (feeding A-FE-01) and
  cannot tell whether a sync is running, failed, or never started.
- **Correction:** return the job/row id and a `deduped: true` flag from
  the API when an identical live job already exists; show "Already queued
  (started …)" instead of "Queued."; surface the latest job status for
  the website on its own page.
- **Regression test:** e2e test clicking Sync now twice in an hour
  asserting the second click reports "already queued", not "Queued."

### A-FE-08 — P3 — CONFIRMED — 2FA setup shows the secret as text only; no QR code · FIXED 2026-11-25

- **Where:** `apps/web/src/app/(app)/settings/security/SecurityActions.tsx:142-163`
  (setup view).
- **Evidence:** after `enable`, the UI renders the TOTP secret as a
  monospace string ("Setup key") plus backup codes as text. There is no
  QR code (no `otpauth://` image/QR component), so the user must type a
  long base32 secret into their authenticator app by hand. The rest of
  the flow is solid: password re-entry to enable/disable, code
  verification, backup codes shown, errors via `role="alert"`.
- **Impact:** error-prone setup; a mistyped secret means verification
  fails and the user must restart setup.
- **Correction:** render a QR code for the `totpURI` alongside the
  manual key.
- **Regression test:** e2e test asserting a QR image is present in the
  setup view.
- **Verification (2026-11-25):** the setup view now renders a scannable
  QR code for the `totpURI` (inline SVG, `role="img"` with an aria
  label, white background so it scans in dark mode too) directly above
  the manual "Setup key", which stays as the fallback; backup codes,
  password re-entry, code verification, and `role="alert"` errors are
  unchanged. The repo carries no QR library and no dependency was
  added: `src/lib/qr.ts` is a self-contained byte-mode QR encoder (EC
  level M, versions 1–40, smallest fitting version auto-selected,
  GF(256) Reed–Solomon, mask chosen by the standard penalty rules)
  emitting SVG path data. Regression guards: `qr.test.ts` verifies the
  encoder structurally (finder/timing/alignment patterns, format +
  version BCH) and by full decode round-trip (unmask → deinterleave →
  Reed–Solomon syndromes zero → payload parses back to the input,
  including a realistic otpauth URI and UTF-8 text), and a
  `SecurityActions.test.tsx` case asserts the QR image is present in
  the setup view next to the manual key — both fail on the pre-fix
  code (no QR element; no encoder module). The finding's e2e test was
  added to `journeys.spec.ts` ("2FA setup shows a QR code to scan";
  CI-only, not run locally). A manual scan with a real authenticator
  app remains the real-world confirmation.

### A-FE-09 — P3 — CONFIRMED — Edit-website status select omits two valid statuses · FIXED 2026-11-25

- **Where:** `apps/web/src/app/(app)/websites/[id]/WebsiteActions.tsx:124-130`
  (options: ACTIVE, PENDING_SETUP, DISCONNECTED, ARCHIVED) vs
  `WebsiteStatus` enum (`ACTIVE, PENDING_SETUP, DISCONNECTED,
TRANSFER_PENDING, SOLD, ARCHIVED`) and the filter on
  `websites/page.tsx:65-70`, which lists all six.
- **Evidence:** a website in TRANSFER_PENDING or SOLD cannot be set to
  (or back from) those states from the UI, although the filter and the
  API accept them. Likely intentional for TRANSFER_PENDING (transfer
  flow owns it), but SOLD has no other UI path.
- **Impact:** minor — status cannot be corrected from the UI for sold
  sites.
- **Correction:** add SOLD to the select (and document whether
  TRANSFER_PENDING is intentionally transfer-flow-only).
- **Regression test:** e2e test asserting the status select contains the
  documented set.
- **Verification (2026-11-25):** SOLD is now in the edit-website
  status select (`WebsiteActions.tsx`, between DISCONNECTED and
  ARCHIVED, matching the enum order), and — because revalidation
  showed the write API did **not** accept it (the PATCH route parses
  `websiteCreateSchema.partial()`, whose status enum was the four
  client-settable values; the finding's "the API accept them" holds
  only for the list filter) — SOLD was also added to the
  client-settable enum in `websiteCreateSchema`
  (`packages/shared/src/validation.ts`), so the new option does not
  400 on submit. This partially reverses audit API-11 for SOLD only:
  API-11's premise was a server-side sale flow, but no code path
  writes SOLD anywhere, so the value was unreachable; the
  edit-website select is now its only path. TRANSFER_PENDING is
  documented as intentionally transfer-flow-only (code comments in
  both files): the transfer workflow owns it, the schema still
  rejects it, and the PATCH route already blocks status changes
  during an open transfer (409 `transfer_in_progress`). Regression
  guards: `validation.test.ts` (SOLD accepted, TRANSFER_PENDING
  still rejected) and a `WebsiteActions.test.tsx` case asserting the
  select lists exactly the documented set — both fail on the pre-fix
  code (schema rejects SOLD; option absent). The finding's e2e test
  was added as `website-status.spec.ts` (creates a website, opens
  its detail page, asserts the select options; CI-only, not run
  locally) and `playwright.config.ts`'s app-project `testMatch` was
  extended to include it.

### A-FE-10 — P3 — CONFIRMED — Session revoke ignores the API response, so a failed revoke looks successful · FIXED 2026-11-25

- **Where:** `apps/web/src/app/(app)/settings/security/SecurityActions.tsx:26-44`
  (`SessionActions.revoke` / `revokeOthers`).
- **Evidence:** `revoke` awaits `postJson` but discards the result —
  no `ok` check, no error state (there is no error UI in
  `SessionActions` at all) — then calls `router.refresh()`. If the
  revoke endpoint fails, the session stays live and the UI gives no
  indication. Contrast with every other action component, which renders
  an error span. There is also no confirmation before revoking a session
  or signing out all other devices.
- **Impact:** user believes an unrecognised device was signed out when it
  was not.
- **Correction:** check `ok`, render an error on failure, and add a
  confirm step for "Sign out all other devices".
- **Regression test:** e2e test stubbing a failed revoke asserting an
  error is shown and the session row remains.
- **Verification (2026-11-25):** `revoke` and `revokeOthers` in
  `SecurityActions.tsx` now check the `postJson` result's `ok`:
  on failure they render the component's existing `role="alert"`
  error ("Couldn't revoke that session. Try again." / "Couldn't
  sign out other devices. Try again.") and do not call
  `router.refresh()`; the refresh happens only on success.
  (Revalidation note: the error UI did exist in `SessionActions`,
  but it was wired only to `revokeAll` — `revoke`/`revokeOthers`
  never set it.) "Sign out all other devices" also gained a
  `window.confirm` step, matching the app's other destructive
  actions. Three new component tests cover the failed revoke, the
  failed revoke-others, and the dismissed confirm (26/26 in
  `SecurityActions.test.tsx`, the new tests fail without the fix);
  the finding's e2e regression test is
  `tests/e2e/session-revoke.spec.ts` (stubs a 500 from
  `/api/auth/revoke-session`, asserts the alert and that the row
  remains, then revokes for real — CI-only).

### A-FE-11 — P3 — CONFIRMED — DateRangePicker does not expose the active range to assistive tech · FIXED 2026-11-25

- **Where:** `apps/web/src/components/DateRangePicker.tsx:14-34`.
- **Evidence:** the active range is shown only by visual styling
  (`bg-zinc-900 text-white` vs bordered). The buttons carry no
  `aria-pressed`, `aria-current`, or group labelling (`role="group"` /
  `aria-label`). A keyboard/screen-reader user cannot tell which range
  is selected. The control itself works (router push with preserved
  params) and is used on both the dashboard and website pages.
- **Correction:** add `aria-pressed={current === value}` (or
  `aria-current="true"`) and wrap in a `role="group"
aria-label="Date range"`.
- **Regression test:** axe run on the dashboard already covers the page;
  add an assertion that the active range button has `aria-pressed=true`.
- **Verification (2026-11-25):** each range button now carries
  `aria-pressed={current === value}` and the buttons sit in a
  `role="group"` container labelled "Date range", so assistive tech
  announces which range is selected; the visual styling, the
  router-push behavior, and the preserved params are unchanged.
  Regression guards: two new tests in `NavComponents.test.tsx` assert
  the active button has `aria-pressed=true` (and the others `false`,
  including the default 28d) and that the group label exists — both
  fail on the pre-fix code (no `aria-pressed` attribute). The axe run
  on the dashboard already covered the page and still passes.

### A-FE-12 — P3 — CONFIRMED — Theme toggle is not persisted and has no accessible state · FIXED 2026-11-25

- **Where:** `apps/web/src/components/ThemeToggle.tsx:3-11`.
- **Evidence:** the toggle only flips `document.documentElement.classList`
  — no `localStorage`, no cookie, no `prefers-color-scheme` detection —
  so the choice resets on every reload/navigation that re-renders the
  document. The button has no `aria-label` or `aria-pressed`; its only
  label is the visible text "Dark / Light".
- **Impact:** dark-mode users re-toggle constantly; screen-reader users
  get no state announcement.
- **Correction:** persist the choice (localStorage + class on load, or a
  cookie so the server renders the right theme and avoids a flash), and
  add `aria-pressed` + `aria-label`.
- **Regression test:** e2e test toggling dark, reloading, and asserting
  the class persists.
- **Verification (2026-11-25):** the choice is persisted in a `theme`
  cookie; the root layout reads it server-side and renders the `dark`
  class on `<html>`, so reloads and navigation keep the theme with no
  flash and no inline script (the nonce-based CSP would block one). The
  button carries `aria-pressed` + `aria-label="Toggle dark mode"`; a
  first visit with no cookie follows `prefers-color-scheme` once and
  persists it. Regression guards: four new tests in
  `NavComponents.test.tsx` (pressed state, cookie write, restore on
  mount, OS preference) — all fail on the pre-fix code — plus the
  finding's e2e test `theme-toggle.spec.ts` (toggle dark, reload, class
  persists; CI-only).

### A-FE-13 — P3 — CONFIRMED — Reset-password form has no confirm-password field · FIXED 2026-11-25

- **Where:** `apps/web/src/app/reset-password/[token]/ResetPasswordForm.tsx:17-40`.
- **Evidence:** a single password input with a client-side minimum of 12
  characters. A typo in the new password is undetectable until the next
  sign-in fails, at which point the user must request a new reset link
  (the token is single-use). The success state is otherwise good
  ("all existing sessions were signed out").
- **Correction:** add a "Confirm new password" field with a mismatch
  error before submitting.
- **Regression test:** e2e test asserting mismatched passwords block
  submission with an error.
- **Verification 2026-11-25:** the form now has a "Confirm new password"
  field (same label/autoComplete="new-password" pattern); when the two
  fields differ, submit shows a role="alert" "Passwords do not match."
  error and never calls the API — the 12-character minimum and the
  success state are unchanged. Regression guards: one new unit test in
  `AuthForms.test.tsx` (fails without the fix — pre-fix there was no
  confirm field to mismatch against) + a new CI-only e2e spec
  `reset-password.spec.ts` (signed-out project, dummy token) asserting
  the alert shows and no POST reaches `/api/auth/reset-password`.

### A-FE-14 — P3 — CONFIRMED — Transfers page: dead INITIATED branch + stale "via POST API" hint · FIXED 2026-11-25

- **Where:** `apps/web/src/app/(app)/transfers/TransferActions.tsx:21-23`
  (`open` includes `"INITIATED"`, but no action button renders for it —
  only `PENDING_ACCEPTANCE` and `PENDING_CONNECTION` render buttons),
  `apps/web/src/app/(app)/transfers/page.tsx:66-69` (empty-state hint:
  "Super Admins initiate transfers via POST /api/websites/[id]/transfer").
- **Evidence:** the create route sets status `PENDING_ACCEPTANCE`
  directly (`apps/web/src/app/api/websites/[id]/transfer/route.ts:42`),
  so `INITIATED` is unreachable from creation and the branch is dead
  code. Separately, the empty-state hint describes the API route even
  though a `TransferForm` UI exists on the website page — a user reading
  the hint would conclude transfers are API-only.
- **Impact:** cosmetic/confusing; no action is lost for real transfers,
  but the hint misdirects users.
- **Correction:** drop `INITIATED` from the `open` list (or document the
  status machine) and reword the hint to point at the website page's
  Transfer form.
- **Regression test:** none needed beyond copy review; a status-machine
  test for the transfer routes would prevent recurrence.
- **Verification (2026-11-25):** the INITIATED half was already resolved by
  A-DB-14 (the enum value was dropped and the `TransferActions` `open` list
  already matched `OPEN_TRANSFER_STATUSES` — verified by grep across
  schema/routes/tests); the empty-state hint now reads "To start a transfer,
  open a website's page and use the Transfer ownership form." Regression
  guards: the pages-ops empty-state test (fails without the fix) + an
  all-statuses `TransferActions` test pinning which statuses render actions.

### A-FE-15 — P3 — CONFIRMED — Audit (100), transfers (50) and members/teams lists are uncapped or unpaginated · FIXED 2026-11-25

- **Where:** `audit/page.tsx:16-21` (`take: 100`, no pagination/filter),
  `transfers/page.tsx:11-19` (`take: 50`, no pagination),
  `members/page.tsx:9-21` (all org users + invites, unbounded),
  `teams/page.tsx:12-23` (all teams with members, unbounded),
  `websites/[id]/page.tsx:33-36` (all org users loaded for the assign
  select, unbounded).
- **Evidence:** none of these pages shows a total or a next page. The
  audit log is the sharpest case: 100 rows, no date/action/actor filter,
  so an incident older than 100 entries is unreachable from the UI (the
  data itself is retained 365 days). Members/teams are bounded by org
  size in practice, but the website page's assign select renders every
  org user as an `<option>`.
- **Impact:** audit history becomes unbrowseable as the org grows;
  transfers past 50 are invisible.
- **Correction:** paginate audit + transfers (50/page with filters for
  audit); cap the assign select with search or pagination.
- **Regression test:** fixture test asserting pagination appears past the
  page size.
- **Verification (2026-11-25):** all five lists now bounded — audit
  paginated 50/page with action/actor/date filters + total (filtered
  relation `_count`; the old `take: 100` is gone, so incidents older
  than 100 entries are reachable again); transfers paginated 50/page
  with a total; members paginated 50/page with a total and pending
  invites capped at the 50 most recent (note shown when capped); teams
  paginated 50/page with a total and the add-member candidate list
  capped at 50 with an email search + note; the website page's assign
  candidates capped at 50 with an email search (`assignQ`) + a
  "Showing X of N" note (existing assignments render from the
  assignments relation, unaffected by the cap). Org scoping and
  permission gates unchanged (gated pages still run no queries).
  Regression guards: 6 new tests in `pages-teams-members.test.tsx`
  (pager + total past the page size, page-2 skip, no pager at ≤50 —
  4 fail without the fix), 2 in `pages-websites.test.tsx` (assign cap
  - search), 4 in `pages-ops.test.tsx` (transfers pager/skip, audit
    pager + server-side filters preserved in pager links). Not covered:
    the [id] page's team selects (Edit/Transfer forms) remain unbounded
    — bounded by org size in practice, same shape as the assign select
    if an org grows large teams.

### A-FE-16 — P3 — POTENTIAL — Top-pages chart has no text alternative; realtime values can render blank · FIXED 2026-11-25

- **Where:** `apps/web/src/components/WebsiteAnalytics.tsx:211-236`
  (bar chart, `<XAxis dataKey="page" hide />`, no table fallback),
  `WebsiteAnalytics.tsx:163-180` (realtime card).
- **Evidence:** the line chart and bar chart carry `role="img"` +
  `aria-label` (good), but the bar chart hides its X axis and provides
  no tabular alternative, so the top-pages data is chart-only for
  screen-reader users. In the realtime card, `rt.data.data.activeUsers`
  and `.eventCount` are rendered unguarded — if the API returns `ok`
  without those fields they render blank rather than "—" (other cards
  use `formatMetric`, which handles null). `fetchJson` correctly treats
  non-2xx as an error state with per-code hints and a Retry button
  (FE-2 fix verified present), and `StatusNote` never prints "undefined".
- **Impact:** chart data inaccessible to assistive tech; occasional blank
  realtime numbers.
- **Correction:** add a visually-hidden (or toggleable) table of the top
  pages; render realtime metrics through `formatMetric`.
- **Regression test:** axe + unit test with a realtime payload missing
  `activeUsers` asserting "—" renders.
- **Verification (2026-11-25):** the top-pages bar chart now has a
  visually-hidden (`sr-only`) table with the same rows (full page paths;
  the chart keeps its `role="img"` + aria-label and its 24-char truncated
  labels), wrapped in `overflow-x-auto` per the A-FE-06 guard; the realtime
  card renders `activeUsers`/`eventCount` through `formatMetric`, so a
  payload missing those fields shows "—" instead of blank. Regression
  guards: two new tests in `WebsiteAnalytics.test.tsx` (both fail without
  the fix).

### A-FE-17 — P3 — CONFIRMED — Forgot-password always shows success, even on network/server failure · FIXED 2026-11-25

- **Where:** `apps/web/src/app/forgot-password/ForgotPasswordForm.tsx:11-19`.
- **Evidence:** the fetch has `.catch(() => null)` and `setSent(true)`
  runs unconditionally — the success message ("a password reset link is
  on its way") shows even if the request never reached the server. The
  comment in the file states the intent (always 200, no account
  enumeration), which is correct for the _unknown-email_ case — but it
  also masks a real outage, and the user will wait for an email that is
  never coming. Note: the server side is genuinely enumeration-safe
  (better-auth returns 200); only the client's error swallowing is at
  issue.
- **Impact:** during an outage, users are told to wait for an email that
  will not arrive.
- **Correction:** distinguish transport failure (show "Couldn't reach the
  server — check your connection and try again") from the
  enumeration-safe success.
- **Regression test:** e2e test with the reset endpoint unreachable
  asserting an error, not the success message.
- **Verification (2026-11-25):** transport failure (fetch rejects or
  non-2xx) now shows a `role="alert"` "Couldn't reach the server —
  check your connection and try again." error and keeps the form for
  retry; better-auth's enumeration-safe 200 (including unknown emails)
  still shows the success message unchanged. Regression: new e2e
  `forgot-password.spec.ts` (route abort → error, no success text;
  route 200 → success). One pre-existing unit test in
  `AuthForms.test.tsx` pinned the old always-success behavior and is
  updated alongside this fix to assert the error instead.

### A-FE-18 — P3 — CONFIRMED — New API-key secret has no copy button · FIXED 2026-11-25

- **Where:** `apps/web/src/app/(app)/settings/api-keys/ApiKeyManager.tsx:76-82`.
- **Evidence:** the one-time secret is rendered in a `<code>` block with
  "Copy this secret now — it will not be shown again" but no copy
  affordance; the user must manually select a long token. (The rest of
  the flow is good: secret shown once, prefix-only in the list, revoke
  with confirm, `if (busy)` guards — the only form besides the report
  schedule that has them.)
- **Impact:** friction and copy errors at the one moment the secret is
  available.
- **Correction:** add a Copy button with clipboard API + "Copied"
  feedback.
- **Regression test:** e2e test asserting the copy button writes the
  secret to the clipboard.
- **Verification (2026-11-25):** the one-time secret block gained a
  Copy button (Clipboard API `navigator.clipboard.writeText`) whose
  label flips to "Copied" for 2 s on success; a clipboard failure
  (denied permission / non-secure context) keeps the secret selectable
  in the code block and shows a `role="alert"` manual-copy hint — the
  create/list/revoke flow is unchanged. Regression: new e2e
  `api-key-copy.spec.ts` (clipboard permissions granted, secret read
  back from the clipboard and compared) + 2 unit tests in
  `ApiKeyManager.test.tsx` (both fail without the fix).

### A-FE-19 — P3 — POTENTIAL — Mobile nav drawer does not trap focus · FIXED 2026-11-25

- **Where:** `apps/web/src/components/MobileNav.tsx:11-85`.
- **Evidence:** the drawer is good on the basics — `role="dialog"
aria-modal="true"`, focus moves to the close button on open, focus
  returns to the menu button on close, Escape closes, backdrop click
  closes, it closes on navigation (`useEffect` on `pathname`). What is
  missing is a **focus trap**: Tab can move focus out of the drawer into
  the background page while the drawer is open, which contradicts
  `aria-modal="true"`. The existing e2e test (`journeys.spec.ts:47-56`)
  covers open → navigate → close, but not Tab order.
- **Impact:** keyboard users can tab into obscured background content.
- **Correction:** trap Tab within the drawer (or use a focus-trap
  primitive) while open.
- **Regression test:** Playwright test tabbing through the open drawer
  asserting focus stays inside.
- **Verification (2026-11-25):** the drawer now traps Tab/Shift+Tab while
  open (hand-rolled focus wrap in the existing keydown handler, no new
  dependency; focus found outside the drawer is pulled back in);
  focus-to-close on open, focus return on close, Escape, backdrop and
  close-on-navigation all preserved. Regression guards:
  `MobileNav.test.tsx` (3 of 4 fail without the fix) + e2e
  `mobile-nav.spec.ts` (Tab 25× stays inside, Shift+Tab wraps, Escape
  returns focus to the menu button). Residual: the trap's focusable
  selector does no visibility filtering — correct for this drawer (all
  contents visible when open).

### A-FE-20 — P3 — CONFIRMED — Sign-out proceeds to /login even if the logout request fails · FIXED 2026-11-25

- **Where:** `apps/web/src/components/Sidebar.tsx:45-54`
  (`handleSignOut`).
- **Evidence:** the `fetch("/api/auth/logout")` is in a `try/finally`
  that always runs `router.push("/login"); router.refresh();`. If the
  request fails (network/server), the session is still alive and the
  user is sent to `/login`, which immediately redirects back to
  `/dashboard` for a signed-in user — a confusing bounce with no error
  shown. (The `disabled={signingOut}` guard is one of only two in the
  app — the double-submit handling here is fine; the failure handling
  is the gap.)
- **Impact:** user believes they signed out; on a shared device the
  session remains live.
- **Correction:** only navigate on `res.ok`; on failure, show an error
  and keep the user in the app with the session state visible.
- **Regression test:** e2e test stubbing a failed logout asserting the
  user stays signed in with an error shown.
- **Verification (2026-11-25):** `handleSignOut` now navigates to
  `/login` only on `res.ok`; a non-2xx response or network failure
  shows a `role="alert"` "Couldn't sign out — check your connection and
  try again." error above the button and keeps the user in the app
  (busy guard `disabled={signingOut}` preserved; the button re-enables
  after a failure). Regression guards: new `Sidebar.test.tsx` (2 of 3
  fail without the fix — 500 and network-throw cases) + e2e
  `sign-out.spec.ts` (fulfilled 500 → stays on /dashboard with the
  alert; fulfilled 200 → /login navigation initiated). Residual:
  `NavComponents.test.tsx`'s "still navigates to /login when logout
  fails" test asserted the old buggy behavior and was updated to the
  new contract alongside this fix.

## Workflow verification table

Each workflow was checked by reading the page, its client component(s),
and the API route(s) it calls. "Performs action" means the control's
fetch target exists and the route implements the action (status/permission
checked where read).

| Workflow                                                    | Control performs its action                                                                                                   | Loading / success / failure states                                                            | Empty state                    | Notes                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| Dashboard (metrics, portfolio, websites table, connections) | Yes — server component, bounded queries (50/page)                                                                             | `loading.tsx` skeleton (`role="status"`); error boundary with retry                           | Yes (`EmptyState` ×3)          | Portfolio silently caps at 200 sites (see Phase 5 A-WRK-10)                        |
| Websites CRUD + filter                                      | Yes — add/edit/delete via `/api/websites[/[id]]`; filter is a GET form (labelled search + status select, both with `<label>`) | Busy labels only; errors via `role="alert"`; success = silent refresh (edit shows "Saved.")   | Yes                            | **A-FE-01, A-FE-02, A-FE-09**                                                      |
| Website detail (analytics, sync now, assign, transfer)      | Yes — 5 React Query fetches; sync/assign/transfer POSTs verified                                                              | Per-card loading / `role="alert"` error + Retry / `EmptyState` for not-connected / no-mapping | Yes                            | **A-FE-07, A-FE-16**                                                               |
| Teams (create/rename/add/remove/admin/delete)               | Yes — `/api/teams[/[id][/members]]`                                                                                           | Busy labels; `role="alert"` errors; delete confirm                                            | Yes                            | **A-FE-01**                                                                        |
| My Team (read-only)                                         | Yes — memberships + websites                                                                                                  | None needed (server render)                                                                   | Yes                            | —                                                                                  |
| Members / invites / roles / org admin                       | Yes — invite/revoke/role/delete/export/delete-org routes                                                                      | Busy labels; `role="alert"`; invite URL shown in-page                                         | Yes ("No pending invites.")    | **A-FE-01**; invite URL display is intentional (SMTP may be unconfigured)          |
| Integrations (connect / discover / map / disconnect)        | Yes — OAuth connect links, discover POST (per-provider errors), map POST, disconnect POST + confirm                           | Busy labels; summary + per-provider `role="alert"` hints; success "Mapped."                   | Yes                            | **A-FE-03**; discovery in the web process is synchronous (see note below)          |
| Transfers (accept/reject/complete/cancel)                   | Yes — `/api/transfers/[id]/*`                                                                                                 | Busy labels; `role="alert"`                                                                   | Yes                            | **A-FE-14**                                                                        |
| Health                                                      | Yes — server render from health rows, 50/page                                                                                 | Skeleton; error boundary                                                                      | Yes                            | —                                                                                  |
| Insights                                                    | Yes — snapshot-derived, 50 sites max                                                                                          | Skeleton; error boundary                                                                      | Yes                            | 50-site cap is stated in code, not in UI                                           |
| Reports (schedule + test send)                              | Yes — PUT schedule, POST send-test                                                                                            | Busy guards present (only form with them); success notice; `role="alert"`                     | Last-sent shown when present   | Hour input is a bare number field (min/max 0–23, no validation message)            |
| API keys (create/revoke)                                    | Yes — POST create (secret once), DELETE revoke + confirm                                                                      | Busy guards present; `role="alert"`                                                           | Yes                            | **A-FE-18**                                                                        |
| Settings / security (2FA, sessions)                         | Yes — enable/verify/disable, revoke session(s)                                                                                | Busy labels; `role="alert"`                                                                   | Sessions list renders all rows | **A-FE-08, A-FE-10**                                                               |
| Sync / DLQ (failed list, requeue)                           | Yes — requeue POST; page is SUPER_ADMIN-gated                                                                                 | Busy label; `role="alert"`                                                                    | Yes                            | **Cross-tenant leak — Phase 5 A-WRK-02**; DLQ rows pruned after 30 days (A-WRK-18) |
| Audit log                                                   | Yes — read-only, SUPER_ADMIN-gated, org-scoped                                                                                | Skeleton; error boundary                                                                      | Yes                            | **A-FE-15** (100 rows, no filter/pagination)                                       |
| Login / 2FA / Google sign-in                                | Yes — `/api/auth/login`, TOTP verify, `signIn.social`                                                                         | Busy labels; `role="alert"`                                                                   | N/A                            | **A-FE-05**; Google failure shows a generic message                                |
| Forgot / reset password                                     | Yes — request + reset endpoints                                                                                               | Success states; `role="alert"` on reset errors                                                | N/A                            | **A-FE-13, A-FE-17**                                                               |
| Invite accept                                               | Yes — `/api/invites/accept`                                                                                                   | Busy label; `role="alert"`                                                                    | Invalid/expired state handled  | —                                                                                  |
| Root `/`                                                    | Redirects to `/dashboard` or `/login` (no bounce)                                                                             | N/A                                                                                           | N/A                            | Verified `app/page.tsx`                                                            |

**Cross-cutting note — discovery runs in the web process:** the
"Discover properties" button POSTs to `/api/google/properties/discover`,
which calls Google list APIs **synchronously in the request** (it does
not enqueue the worker's `google-property-discovery` job). A large
account's discovery can therefore hold a web request open for a long
time and is subject to the platform's request timeout. The worker job
exists for the same operation (scheduled discovery). This is a
Phase 5/6 boundary observation, not counted as a FE finding.

## Accessibility & responsive — verified items

- **Skip link:** present in `(app)/layout.tsx`, first focusable element,
  targets `#main-content` (`tabIndex={-1}`); covered by an e2e test
  (`app-accessibility.spec.ts`, Tab → skip link focused → click →
  `#main-content` focused). **PASS.**
- **Landmarks:** `<aside>` nav (`aria-label="Main"`), `<main
id="main-content">`, `<header>`; tables use `<th scope="col">`;
  pagination nav has `aria-label`. **PASS.**
- **Labels:** every input/select audited has an associated `<label>`
  (visible or `sr-only`) — including the websites search/status filter,
  all website/team/member/integration forms, and auth forms. The only
  checkbox labels are the wrapping-label pattern ("Primary", "Team
  admin", "Send the weekly report automatically") — valid. **PASS.**
- **Focus-visible styles:** `focus-visible:ring-2 … outline-none` is
  applied consistently on links, buttons, inputs and selects (including
  the shared `Button`/`Input`); no global `:focus` rule exists in
  `globals.css` because the utilities carry it. **PASS (static).**
- **Error display:** 27 `role="alert"` sites across 15 files; success
  states use `text-emerald-700` text (no live region — a polite
  `role="status"` on success notices would be better, P3, folded into
  A-FE-04's fix). **PASS with note.**
- **Loading states:** `(app)/loading.tsx` skeleton with `role="status"
aria-busy="true"`; `(app)/error.tsx` boundary with retry + digest;
  `not-found.tsx` exists. **PASS.**
- **Images/links:** `/logo.svg` exists in `apps/web/public/` (used in
  Sidebar + auth pages); `og.png`, `favicon-*.png`, `apple-touch-icon.png`,
  `twitter-card.png`, `site.webmanifest` all present in the repo.
  (Memory noted `og.png`/favicon 404ing in production — the files exist
  in the repo, so that is a deployment/serving question, **NOT RUN** here.)
  No broken internal links found by static inspection; every Sidebar
  href matches an existing route. **PASS (static).**
- **Hydration risks:** `suppressHydrationWarning` on `<html>`/`<body>`
  (documented: browser-extension attribute injection); no
  `useSearchParams` outside a dynamic page (all pages are
  `force-dynamic`); `ThemeToggle` mutates `documentElement.classList`
  without SSR coordination — a flash-of-wrong-theme on load is possible
  (NOT RUN). **PASS with note.**
- **Responsive:** sidebar hidden below `md` (`hidden md:block`) with
  `MobileNav` drawer (e2e-covered at 390 px); dashboard grids collapse
  4→2 columns. **FAIL (partial)** — A-FE-06 (tables).
- **Axe coverage:** 12 signed-in pages + `/login` + `/forgot-password`,
  critical/serious only. **Not covered:** `/websites/[id]`, `/team`,
  `/sync`, `/invite/[token]`, `/reset-password/[token]`, `/` (redirect),
  and dark mode (A-FE-04). Journeys cover team create, website create,
  API-key create/revoke, report-schedule save, and mobile nav.
  **PARTIAL.**

## Per-category verdicts

| Category                                            | Verdict            | Basis                                                                                                                   |
| --------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Controls perform their actions                      | **PASS**           | Every workflow's control was traced to a route that implements it                                                       |
| Loading / success / failure states                  | **FAIL**           | A-FE-01 (no submission guard — failure states exist but double-submit is unguarded); A-FE-05, A-FE-07, A-FE-10, A-FE-17 |
| Duplicate-submission guards                         | **FAIL**           | A-FE-01 — systemic; only 2 forms guard, 2 controls disable                                                              |
| Empty states                                        | **PASS**           | Present on every list page (dashboard ×3, websites, teams, members, health, insights, sync, audit, transfers, API keys) |
| Error display (`role="alert"`)                      | **PASS**           | 27 sites across 15 files; success notices lack a live region (minor)                                                    |
| Broken links / images                               | **PASS** (static)  | All Sidebar hrefs resolve; logo/OG/favicon files present in repo; prod serving NOT RUN                                  |
| Console-error / hydration risks                     | **NOT RUN**        | No browser run; static risks noted (theme flash, `suppressHydrationWarning` documented)                                 |
| Responsive (mobile)                                 | **FAIL** (partial) | Sidebar/MobileNav good + e2e-covered; A-FE-06 tables overflow risk                                                      |
| Accessibility — skip link, landmarks, labels, focus | **PASS**           | Verified in source + e2e skip-link test                                                                                 |
| Accessibility — contrast                            | **FAIL**           | A-FE-04 — light mode passes, dark mode fails 4.5:1 across links/muted/error/success/warning text                        |
| Accessibility — axe coverage                        | **PARTIAL**        | 14 pages critical/serious, light mode only; 5 routes + dark mode uncovered                                              |
| Lists & pagination at scale                         | **FAIL**           | A-FE-02 (websites 100-cap), A-FE-03 (integrations unbounded), A-FE-15                                                   |

## NOT RUN (with reason)

- Any browser rendering, clicking, viewport, or visual check (no live
  browser in this audit) — including the 390 px table-overflow check
  (A-FE-06), dark-mode appearance (A-FE-04 ratios are computed, not
  screenshotted), focus-trap behaviour (A-FE-19), and double-submit
  reproduction (A-FE-01).
- The 23 Playwright e2e tests (CI only) — coverage was assessed by
  reading the specs, not by executing them.
- Production asset serving (`og.png`/favicon 404 note from memory) —
  files exist in the repo; live status not checked.
- Server-side idempotency of create POSTs (needed to bound A-FE-01) —
  not verified in this phase.

## Counts

- P0: **0** · P1: **2** (A-FE-01, -02) · P2: **4** (A-FE-03, -04, -05, -07) ·
  P3: **14** (A-FE-06, -08…-20 except -07) · **Total: 20**
