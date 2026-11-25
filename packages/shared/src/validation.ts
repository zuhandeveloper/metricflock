import { z } from "zod";

/** Strict YYYY-MM-DD calendar-date validation (parseAdManagerDate-style):
 *  format + a real calendar date. A plain `^\d{4}-\d{2}-\d{2}$` regex
 *  admits "2026-02-30" and "2026-13-45", and slicing admits "2026-1-5"
 *  (month NaN); those used to reach Google and fail as confusing provider
 *  502s (A-GGL-08). The UTC round-trip rejects impossible dates. */
export function parseStrictDate(d: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new Error("INVALID_DATE");
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new Error("INVALID_DATE");
  }
  return { year, month, day };
}

export function isValidCalendarDate(d: string): boolean {
  try {
    parseStrictDate(d);
    return true;
  } catch {
    return false;
  }
}

// A-GGL-08: field-level refine (not an object-level one) so dateRangeSchema
// stays a plain ZodObject and analyticsQuerySchema's `.extend` keeps
// working. The cross-field startDate <= endDate check is attached to
// analyticsQuerySchema itself (A-GGL-22); resolveRange repeats it as
// defense-in-depth for callers that pass a raw range string.
const strictDateString = z.string().refine(isValidCalendarDate, {
  message: "must be a real calendar date (YYYY-MM-DD)",
});
export const dateRangeSchema = z.object({
  startDate: strictDateString.optional(),
  endDate: strictDateString.optional(),
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
export const analyticsQuerySchema = dateRangeSchema
  .extend({
    websiteId: z.string().optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  // A-GGL-22: cross-field order check at the schema level. dateRangeSchema
  // stays a plain ZodObject (A-GGL-08: `.extend` must keep working), so the
  // startDate <= endDate check is attached here, on the extended schema
  // every HTTP analytics path parses. resolveRange keeps its own check as
  // defense-in-depth for callers that pass a raw range string.
  .superRefine((val, ctx) => {
    if (val.startDate && val.endDate && val.startDate > val.endDate) {
      ctx.addIssue({
        code: "custom",
        message: "startDate must be on or before endDate",
        path: ["startDate"],
      });
    }
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
