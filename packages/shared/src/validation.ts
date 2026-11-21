import { z } from "zod";
export const dateRangeSchema = z.object({
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  range: z.enum(["today", "yesterday", "7d", "28d", "90d", "12m", "custom"]).default("28d"),
});
export const websiteCreateSchema = z.object({
  name: z.string().min(1).max(200),
  domain: z.string().min(3).max(253),
  url: z.string().url(),
  description: z.string().max(2000).optional(),
  teamId: z.string().optional(),
  // Client-settable statuses only. TRANSFER_PENDING and SOLD are
  // server-managed (transfer workflow / sale flow) and must not be set
  // directly through create/update (audit API-11).
  status: z.enum(["ACTIVE", "PENDING_SETUP", "DISCONNECTED", "ARCHIVED"]).optional(),
  purchaseDate: z.string().optional(),
  saleDate: z.string().optional(),
  purchasePrice: z.number().nonnegative().optional(),
  salePrice: z.number().nonnegative().optional(),
  notes: z.string().max(5000).optional(),
});
export const teamCreateSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
});
export const transferSchema = z.object({ toTeamId: z.string().min(1), reason: z.string().max(1000).optional() });
export const mapPropertySchema = z.object({
  websiteId: z.string().min(1),
  provider: z.enum(["GA4", "SEARCH_CONSOLE", "ADSENSE", "AD_MANAGER"]),
  externalId: z.string().min(1),
  // Optional: disambiguates when the same property was discovered under
  // more than one connection in the organization.
  connectionId: z.string().min(1).optional(),
  resourceName: z.string().optional(),
  isPrimary: z.boolean().optional(),
});
export const analyticsQuerySchema = dateRangeSchema.extend({
  websiteId: z.string().optional(),
  format: z.enum(["json", "csv"]).optional(),
});
export const inviteCreateSchema = z.object({
  email: z.string().email().max(320),
  // SUPER_ADMIN is never granted by invite — it is promoted afterwards
  // by an existing SUPER_ADMIN via the role-change endpoint.
  role: z.enum(["TEAM_ADMIN", "TEAM_MEMBER"]).default("TEAM_MEMBER"),
});
export const memberRoleSchema = z.object({
  role: z.enum(["SUPER_ADMIN", "TEAM_ADMIN", "TEAM_MEMBER"]),
});
