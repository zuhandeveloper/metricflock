// Granular permission system (spec §4). Role defaults; membership can extend later.
export const PERMISSIONS = [
  "analytics.view", "analytics.realtime.view", "analytics.reports.view",
  "search_console.view", "adsense.view", "ad_manager.view",
  "website.view", "website.manage", "website.assign",
  "team.view", "team.manage", "member.manage",
  "google.connection.view", "google.connection.manage",
  "website.transfer", "audit.view", "organization.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type Role = "SUPER_ADMIN" | "TEAM_ADMIN" | "TEAM_MEMBER";
const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: [...PERMISSIONS],
  TEAM_ADMIN: [
    "analytics.view", "analytics.realtime.view", "analytics.reports.view",
    "search_console.view", "adsense.view", "ad_manager.view",
    "website.view", "website.manage", "website.assign",
    "team.view", "team.manage", "member.manage",
    "google.connection.view", "google.connection.manage",
  ],
  TEAM_MEMBER: [
    "analytics.view", "analytics.reports.view", "search_console.view",
    "adsense.view", "website.view",
  ],
};
export function rolePermissions(role: Role): Permission[] { return ROLE_PERMISSIONS[role] ?? []; }
export function hasPermission(role: Role, permission: Permission, extra: Permission[] = []): boolean {
  return rolePermissions(role).includes(permission) || extra.includes(permission);
}
