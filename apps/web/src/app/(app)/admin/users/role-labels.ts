// Friendly display labels for organization roles (the owner's
// vocabulary). Display-only — API payloads and enum values are
// unchanged. Kept local to the platform-admin pages so this feature
// does not depend on the members page's copy.
export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "Super admin",
  TEAM_ADMIN: "Manager",
  TEAM_MEMBER: "Simple user",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}
