import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { sendMail } from "@metricflock/auth/mailer";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { hashToken, inviteCreateSchema, rateLimit, clientIpFromHeaders } from "@metricflock/shared";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function post(req: NextRequest) {
  const auth = await requireApiAuth("member.manage", { req });
  if ("error" in auth) return auth.error;
  // Invite creation sends email + mints credentials-equivalent links:
  // rate-limit per inviter, fail-closed (F-3.1).
  if (!(await rateLimit(`invite:${auth.user.id}`, 20, 60_000, { failClosed: true })).allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const body = inviteCreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });
  const email = body.data.email.trim().toLowerCase();

  const existingUser = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, organizationId: true },
  });
  if (existingUser?.organizationId === auth.user.organizationId) {
    return NextResponse.json({ error: "already_member" }, { status: 409 });
  }

  // Replace any still-pending invite for this email in this org so only
  // the newest link works.
  await prisma.organizationInvite.deleteMany({
    where: {
      organizationId: auth.user.organizationId,
      email: { equals: email, mode: "insensitive" },
      acceptedAt: null,
    },
  });

  const token = randomBytes(32).toString("hex");
  const invite = await prisma.organizationInvite.create({
    data: {
      organizationId: auth.user.organizationId,
      email,
      role: body.data.role,
      tokenHash: hashToken(token),
      invitedById: auth.user.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const inviteUrl = `${baseUrl}/invite/${token}`;
  const org = await prisma.organization.findUnique({
    where: { id: auth.user.organizationId },
    select: { name: true },
  });
  await sendMail({
    to: email,
    subject: `You've been invited to join ${org?.name ?? "MetricFlock"}`,
    text: [
      `${auth.user.email} invited you to join ${org?.name ?? "their organization"} on MetricFlock as ${invite.role}.`,
      "",
      `Open this link to accept: ${inviteUrl}`,
      "",
      "If you don't have an account yet, sign up with this email address and you will join automatically.",
      "This invite expires in 7 days.",
    ].join("\n"),
  }).catch(() => undefined);

  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "member.invited",
    entityType: "OrganizationInvite",
    entityId: invite.id,
    details: { email, role: invite.role },
  }).catch(() => undefined); // A-API-04: audit failure must not turn a sent invite into a 500.

  // The invite URL is returned to the inviting admin so it can be shared
  // manually when SMTP is not configured (the mailer logs instead of
  // sending in that case).
  return NextResponse.json(
    { invite: { id: invite.id, email, role: invite.role, expiresAt: invite.expiresAt }, inviteUrl },
    { status: 201 },
  );
}

export const POST = withApiErrors("members/invite", post);
