// Tenant scoping for AnalyticsSyncJob rows (A-SEC-01).
//
// AnalyticsSyncJob has no organizationId column — the tenant is reached
// through its website. A Prisma relation filter requires the relation to
// exist, so rows with websiteId = null match NO tenant: they are
// global-only and visible to no organization. Requeue uses the same
// scoped lookup, so the row's org is checked in the same query that
// loads it (a website's organizationId never changes, so there is no
// TOCTOU window between load and enqueue).
export function syncJobOrgWhere(organizationId: string) {
  return { website: { organizationId } };
}
