import nodemailer from "nodemailer";
import { createLogger } from "@metricflock/shared";

// Transactional mail for auth flows (email verification, password reset).
//
// Configure with SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM.
// Works with any SMTP provider (Gmail app password, Resend, SES, ...).
//
// F-2.3: message bodies carry credential-equivalent secrets (verification
// and password-reset URLs). They are NEVER written to logs — in any
// environment — unless EMAIL_LOG_PREVIEW=true is set explicitly (a
// development/CI convenience that prints the full message instead of
// sending it). When SMTP is not configured and preview is off, the
// failure is logged loudly (recipient + subject only) so the
// misconfiguration is visible without leaking links into log storage.

type MailInput = { to: string; subject: string; text: string };

const log = createLogger("mailer");

export type MailerMode = "smtp" | "preview" | "unconfigured";

export function mailerMode(): MailerMode {
  if (process.env.SMTP_HOST) return "smtp";
  if (process.env.EMAIL_LOG_PREVIEW === "true") return "preview";
  return "unconfigured";
}

export async function sendMail({ to, subject, text }: MailInput): Promise<void> {
  const mode = mailerMode();
  if (mode === "preview") {
    log.warn("EMAIL_LOG_PREVIEW is on — email not sent, full message follows (dev/CI only)", { to, subject });
    console.warn(`[mailer:preview] to=${to} subject="${subject}"\n${text}`);
    return;
  }
  if (mode === "unconfigured") {
    // Never log the body: it contains auth URLs. Recipient + subject are
    // enough to diagnose the misconfiguration.
    log.error("SMTP not configured — email NOT sent (set SMTP_HOST or EMAIL_LOG_PREVIEW=true for dev)", {
      to,
      subject,
    });
    return;
  }
  const port = Number(process.env.SMTP_PORT ?? 587);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM ?? "MetricFlock <no-reply@localhost>",
    to,
    subject,
    text,
  });
}

export async function sendVerificationEmail(to: string, url: string): Promise<void> {
  await sendMail({
    to,
    subject: "Verify your MetricFlock email",
    text: `Welcome to MetricFlock. Confirm your email address to activate your account:\n\n${url}\n\nIf you did not create this account, you can ignore this email.`,
  });
}

export async function sendPasswordResetEmail(to: string, url: string): Promise<void> {
  await sendMail({
    to,
    subject: "Reset your MetricFlock password",
    text: `A password reset was requested for your MetricFlock account. Use this link to set a new password:\n\n${url}\n\nIf you did not request this, you can ignore this email.`,
  });
}
