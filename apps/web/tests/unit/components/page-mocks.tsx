// Shared vi.mock setup for server-page tests (tests/unit/components/pages-*.test.tsx).
//
// IMPORTANT: import this module FIRST in a page test file, before the page
// under test. Its vi.mock calls register before the page module is
// imported, so the page's dependencies resolve to these mocks.
//
// This module must NOT be imported by non-page tests: it replaces
// @metricflock/auth, @metricflock/db, next/navigation, next/link and the
// portfolio/insights/health loaders for the importing test file only.
//
// Mock state lives in page-state.ts (plain module, no vi.mock calls);
// this file only registers the mocks against that state.
import { vi } from "vitest";
import { navMocks, pageMocks } from "./page-state";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navMocks.push, refresh: navMocks.refresh, replace: navMocks.replace }),
  usePathname: () => navMocks.pathname,
  useSearchParams: () => navMocks.searchParams,
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  // A-FE-12: the root layout reads the `theme` cookie server-side.
  cookies: async () => ({ get: () => undefined }),
}));

// A-FE-12: jsdom has no matchMedia; ThemeToggle's mount effect queries
// prefers-color-scheme. Default to light.
window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return {
    ...actual,
    getSessionUser: pageMocks.getSessionUser,
    isPlatformAdmin: pageMocks.isPlatformAdmin,
    listAccessibleWebsiteIds: pageMocks.listAccessibleWebsiteIds,
    assertWebsiteAccess: pageMocks.assertWebsiteAccess,
    auth: {
      ...actual.auth,
      api: {
        ...actual.auth.api,
        getSession: pageMocks.getSession,
        listSessions: pageMocks.listSessions,
      },
    },
  };
});

vi.mock("@metricflock/db", () => ({
  prisma: {
    website: {
      count: pageMocks.websiteCount,
      findMany: pageMocks.websiteFindMany,
      findUnique: pageMocks.websiteFindUnique,
    },
    team: { count: pageMocks.teamCount, findMany: pageMocks.teamFindMany },
    user: { count: pageMocks.userCount, findMany: pageMocks.userFindMany },
    googleConnection: { count: pageMocks.googleConnectionCount, findMany: pageMocks.googleConnectionFindMany },
    websiteIntegration: { groupBy: pageMocks.websiteIntegrationGroupBy },
    analyticsSyncJob: {
      groupBy: pageMocks.analyticsSyncJobGroupBy,
      findMany: pageMocks.analyticsSyncJobFindMany,
      findFirst: pageMocks.analyticsSyncJobFindFirst,
    },
    websiteTransfer: { findMany: pageMocks.websiteTransferFindMany },
    teamMember: { findMany: pageMocks.teamMemberFindMany },
    organizationInvite: {
      findMany: pageMocks.organizationInviteFindMany,
      findFirst: pageMocks.organizationInviteFindFirst,
    },
    organization: { findUnique: pageMocks.organizationFindUnique },
    auditLog: { findMany: pageMocks.auditLogFindMany },
    reportSchedule: { findUnique: pageMocks.reportScheduleFindUnique },
    account: { findFirst: pageMocks.accountFindFirst },
    apiKey: { findMany: pageMocks.apiKeyFindMany },
  },
}));

vi.mock("@/lib/portfolio", () => ({ loadPortfolio: pageMocks.loadPortfolio }));
vi.mock("@/lib/insights", () => ({ loadInsights: pageMocks.loadInsights }));
vi.mock("@/lib/health", () => ({ loadHealthOverview: pageMocks.loadHealthOverview }));
vi.mock("@metricflock/google/oauth", () => ({ providersMissingScopes: pageMocks.providersMissingScopes }));
vi.mock("@metricflock/google/ad-manager", () => ({ adManagerEnabled: pageMocks.adManagerEnabled }));

// WebsiteAnalytics pulls react-query + recharts + live fetches; page tests
// cover the page shell, the component has its own test file.
vi.mock("@/components/WebsiteAnalytics", () => ({
  default: () => <div data-testid="website-analytics-stub">analytics</div>,
}));
