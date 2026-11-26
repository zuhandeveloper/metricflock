// Friendly display labels for organization roles (the owner's
// vocabulary). Display-only — API payloads and enum values are
// unchanged. Shared by the members page (server) and MemberForms
// (client), so it lives in its own module rather than in either file.
export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "Super admin",
  TEAM_ADMIN: "Manager",
  TEAM_MEMBER: "Simple user",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}
