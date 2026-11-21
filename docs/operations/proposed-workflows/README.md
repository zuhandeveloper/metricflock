# Proposed CI workflows (Stage 9)

The GitHub App used by the assistant cannot write `.github/workflows/`
(no Workflows permission), so these files live here as reviewed
proposals. To apply them, copy each file into `.github/workflows/`
with the same name (GitHub web UI: Add file → Create new file, or
edit the existing `ci.yml` and replace its contents).

- `ci.yml` — replaces the current CI workflow. Adds: SHA-pinned
  actions, gitleaks secret scan, `pnpm audit --prod` gate,
  `format:check`, coverage thresholds, Playwright + axe e2e step.
  Everything else (services, env, smoke test) is unchanged.
- `codeql.yml` — new workflow: CodeQL `security-extended` analysis
  for javascript-typescript on push/PR + weekly schedule.

Action SHAs were resolved from the upstream tags on 2026-11-21:
actions/checkout v4, pnpm/action-setup v4, actions/setup-node v4,
gitleaks/gitleaks-action v2, github/codeql-action v3. Dependabot
(`.github/dependabot.yml`) will keep them current.
