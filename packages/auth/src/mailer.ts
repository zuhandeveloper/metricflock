import nodemailer from "nodemailer";

// Transactional mail for auth flows (email verification, password reset).
//
// Configure with SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM.
// Works with any SMTP provider (Gmail app password, Resend, SES, ...).
// When SMTP is not configured the link is logged to the server console
// instead of emailed — acceptable for local development, but production
// deployments MUST set the SMTP_* variables or verification/reset emails
// will never reach users. Startup validation warns about this in production
// (see apps/web/src/instrumentation.ts). Never log the link when SMTP is
// configured: it is a credential-equivalent secret.

type MailInput = { to: string; subject: string; text: string };

function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST);
}

export async function sendMail({ to, subject, text }: MailInput): Promise<void> {
  if (!smtpConfigured()) {
    console.warn(`[mailer] SMTP not configured — email to ${to} ("${subject}") was NOT sent. Message:\n${text}`);
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
