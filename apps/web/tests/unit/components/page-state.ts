// Shared mock state for server-page tests. Plain module — no vi.mock
// calls here, so the mock fns can be exported and shared freely. The
// vi.mock registrations live in page-mocks.tsx, which imports this file.
import { vi } from "vitest";

export const pageMocks = {
  getSessionUser: vi.fn(),
  listAccessibleWebsiteIds: vi.fn(),
  assertWebsiteAccess: vi.fn(),
  loadPortfolio: vi.fn(),
  loadInsights: vi.fn(),
  loadHealthOverview: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  providersMissingScopes: vi.fn(),
  adManagerEnabled: vi.fn(),
  // prisma
  websiteCount: vi.fn(),
  websiteFindMany: vi.fn(),
  websiteFindUnique: vi.fn(),
  teamCount: vi.fn(),
  teamFindMany: vi.fn(),
  userCount: vi.fn(),
  userFindMany: vi.fn(),
  googleConnectionCount: vi.fn(),
  googleConnectionFindMany: vi.fn(),
  websiteIntegrationGroupBy: vi.fn(),
  analyticsSyncJobGroupBy: vi.fn(),
  analyticsSyncJobFindMany: vi.fn(),
  analyticsSyncJobFindFirst: vi.fn(),
  websiteTransferFindMany: vi.fn(),
  teamMemberFindMany: vi.fn(),
  organizationInviteFindMany: vi.fn(),
  organizationInviteFindFirst: vi.fn(),
  organizationFindUnique: vi.fn(),
  auditLogFindMany: vi.fn(),
  reportScheduleFindUnique: vi.fn(),
  apiKeyFindMany: vi.fn(),
};

export const navMocks = {
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  pathname: "/dashboard",
  searchParams: new URLSearchParams(),
};

/** Reset every shared mock between tests. Call in beforeEach. */
export function resetPageMocks() {
  vi.clearAllMocks();
  navMocks.pathname = "/dashboard";
  navMocks.searchParams = new URLSearchParams();
}

/** The standard signed-in super admin used by most page tests. */
export const superAdminUser = {
  id: "u1",
  organizationId: "org1",
  role: "SUPER_ADMIN",
  email: "admin@example.com",
  name: "Admin",
  twoFactorEnabled: false,
};

/** A signed-in non-admin member. */
export const memberUser = {
  id: "u2",
  organizationId: "org1",
  role: "TEAM_MEMBER",
  email: "member@example.com",
  name: "Member",
  twoFactorEnabled: false,
};
