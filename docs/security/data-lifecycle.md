# Data lifecycle policy

How MetricFlock deletes data, how long it keeps operational records,
and what an organization export contains. Implemented in Phase 4
(F-4.3) of the production-hardening program.

## Deletion

### Member deletion — `DELETE /api/members/[id]`

- Who: `member.manage` (SUPER_ADMIN / TEAM_ADMIN). Deleting a
  SUPER_ADMIN additionally requires a SUPER_ADMIN actor.
- Guards: you cannot delete yourself (`cannot_delete_self`); the last
  SUPER_ADMIN cannot be deleted (`last_super_admin`).
- Blockers: a user recorded as creator of Google connections or
  initiator of website transfers cannot be deleted
  (`member_has_dependencies`, with counts) — those rows use Restrict
  foreign keys so ownership history is never silently orphaned.
  Reassign or remove those first.
- Effect: the user row is deleted; sessions, credential accounts,
  two-factor records, team memberships, website assignments, OAuth
  flow states and sent invites cascade. Audit-log rows survive with
  the actor reference nulled, so the trail stays readable.
- Audited as `member.deleted` (email + role in details).
- UI: Members page → Delete (confirmation prompt; blocker counts are
  shown when deletion is refused).

### Organization deletion — `DELETE /api/organization`

- Who: `organization.manage` (SUPER_ADMIN only).
- Confirmation: the request body must carry the organization's exact
  slug (`confirmSlug`); anything else is `confirmation_mismatch`.
- Effect: every Google connection's refresh token is revoked at
  Google (best-effort) so no live grants survive; then audit rows and
  the organization are deleted in one transaction — teams, websites,
  connections (including encrypted tokens), integrations, transfers,
  sync jobs and users cascade. Deletion is refused (409
  `export_required`) until a completed export exists — the
  `organization.exported` audit row left by an export is the record.
- Because the audit table is deleted with the organization, the
  deletion itself is recorded in server logs at error level
  (`organization-delete`: actor, slug, member/website/team counts),
  not the audit table.
- UI: Members page → Organization → Delete organization (slug input +
  confirmation prompt; redirects to login afterwards).

### Team / website deletion

Unchanged: teams with websites refuse deletion (`team_has_websites`);
website deletion cascades its integrations, assignments, transfers,
sync jobs and website-level connections.

## Retention

The worker scheduler prunes operational rows every tick:

| Data                        | Retention               | Mechanism                                                                                                                            |
| --------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| AnalyticsSyncJob (finished) | 30 days                 | `updatedAt` older than 30d, status SUCCEEDED/FAILED/PENDING/RETRYING; pruned in 1,000-row batches, max 10 batches per table per tick |
| AnalyticsSyncJob (stuck)    | 6 hours                 | `RUNNING` with `updatedAt` older than 6h → marked FAILED, `lastError: "stale_running"` (removed by the 30-day FAILED prune)          |
| OAuthState                  | ~1 day past expiry      | single-use, 10-minute TTL; rows deleted 1 day after `expiresAt`                                                                      |
| AnalyticsCache              | until `expiresAt`       | expired rows deleted                                                                                                                 |
| AuditLog                    | 365 days (configurable) | `AUDIT_RETENTION_DAYS` env; invalid values fall back to 365                                                                          |

Business data (organizations, teams, websites, connections,
integrations, transfers) is never auto-pruned.

## Export — `GET /api/organization/export`

- Who: `organization.manage` (SUPER_ADMIN only). Audited as
  `organization.exported`.
- Format: JSON download (`metricflock-<slug>-export.json`).
- Contains: organization profile; members (id, name, email, role,
  verification, join date); teams with memberships; websites with
  assignments and integrations (provider, external id, mapping
  status, primary flag, connection email); connection metadata
  (Google account email, granted scopes, status, owner); transfer
  history.
- Never contains: password hashes, encrypted Google tokens, session
  data, or any credential material.
