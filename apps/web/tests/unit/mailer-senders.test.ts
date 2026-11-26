import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A-COV-16: the two credential-email senders (sendVerificationEmail /
// sendPasswordResetEmail in packages/auth/src/mailer.ts) were never named
// in tests — mailer.test.ts covers only mailerMode and sendMail's
// log-preview behaviour. These tests pin, per sender and per mailer mode:
// the recipient, the subject, that the body carries the exact URL (token
// included), and that no token reaches the structured logs. In preview
// mode the full message is printed by design (explicit dev opt-in); the
// structured log line still carries recipient + subject only.
//
// nodemailer is a dependency of @metricflock/auth, not of apps/web, and
// vitest.config.ts has no alias for it (unlike googleapis/ioredis/bullmq)
// — so vi.mock("nodemailer") silently misses (verified empirically: the
// real transport attempts a connection). Mocking the package's ESM entry
// file through packages/auth's node_modules resolves to the same module
// instance mailer.ts imports. If a nodemailer alias is ever added to
// vitest.config.ts, this can simplify to vi.mock("nodemailer").
type SentMessage = { from: string; to: string; subject: string; text: string };
const transportSendMail = vi.hoisted(() => vi.fn(async (_msg: SentMessage) => ({ messageId: "test-message-id" })));
const createTransport = vi.hoisted(() => vi.fn(() => ({ sendMail: transportSendMail })));

vi.mock("../../../../packages/auth/node_modules/nodemailer/dist/esm/nodemailer.js", () => ({
  default: { createTransport },
}));

import { sendVerificationEmail, sendPasswordResetEmail } from "@metricflock/auth/mailer";

const VERIFY_TOKEN = "verify-token-abc123";
const RESET_TOKEN = "reset-token-xyz789";
const VERIFY_URL = `https://metricflock.bond/verify-email?token=${VERIFY_TOKEN}`;
const RESET_URL = `https://metricflock.bond/reset-password?token=${RESET_TOKEN}`;

describe("auth email senders (A-COV-16)", () => {
  const saved = { ...process.env };
  let lines: string[] = [];

  const structuredLines = () => lines.filter((l) => l.startsWith("{"));
  const previewLines = () => lines.filter((l) => l.startsWith("[mailer:preview]"));

  beforeEach(() => {
    vi.clearAllMocks();
    lines = [];
    for (const m of ["log", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_FROM;
    delete process.env.EMAIL_LOG_PREVIEW;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  describe("SMTP mode (recording transport)", () => {
    beforeEach(() => {
      process.env.SMTP_HOST = "smtp.example.com";
      process.env.SMTP_PORT = "587";
      process.env.SMTP_USER = "mailer-user";
      process.env.SMTP_PASS = "smtp-pass-fixture";
    });

    it("sendVerificationEmail sends the verification URL to the recipient", async () => {
      await sendVerificationEmail("new-user@example.com", VERIFY_URL);

      expect(createTransport).toHaveBeenCalledTimes(1);
      expect(createTransport).toHaveBeenCalledWith({
        host: "smtp.example.com",
        port: 587,
        secure: false,
        auth: { user: "mailer-user", pass: "smtp-pass-fixture" },
      });
      expect(transportSendMail).toHaveBeenCalledTimes(1);
      const msg = transportSendMail.mock.calls[0][0];
      expect(msg.to).toBe("new-user@example.com");
      expect(msg.subject).toBe("Verify your MetricFlock email");
      expect(msg.from).toBe("MetricFlock <no-reply@localhost>");
      expect(msg.text).toContain(VERIFY_URL);
      expect(msg.text).toContain(VERIFY_TOKEN);
      // No token leaks to any log/console output on the SMTP path.
      expect(lines.join("\n")).not.toContain(VERIFY_TOKEN);
    });

    it("sendPasswordResetEmail sends the reset URL (port 465 → secure, custom from)", async () => {
      process.env.SMTP_PORT = "465";
      process.env.SMTP_FROM = "MetricFlock <noreply@metricflock.bond>";

      await sendPasswordResetEmail("user@example.com", RESET_URL);

      expect(createTransport).toHaveBeenCalledTimes(1);
      expect(createTransport).toHaveBeenCalledWith({
        host: "smtp.example.com",
        port: 465,
        secure: true,
        auth: { user: "mailer-user", pass: "smtp-pass-fixture" },
      });
      expect(transportSendMail).toHaveBeenCalledTimes(1);
      const msg = transportSendMail.mock.calls[0][0];
      expect(msg.to).toBe("user@example.com");
      expect(msg.subject).toBe("Reset your MetricFlock password");
      expect(msg.from).toBe("MetricFlock <noreply@metricflock.bond>");
      expect(msg.text).toContain(RESET_URL);
      expect(msg.text).toContain(RESET_TOKEN);
      expect(lines.join("\n")).not.toContain(RESET_TOKEN);
    });

    it("SMTP without credentials passes auth: undefined and defaults the port", async () => {
      delete process.env.SMTP_PORT;
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;

      await sendVerificationEmail("new-user@example.com", VERIFY_URL);

      expect(createTransport).toHaveBeenCalledWith({
        host: "smtp.example.com",
        port: 587,
        secure: false,
        auth: undefined,
      });
      expect(transportSendMail).toHaveBeenCalledTimes(1);
    });
  });

  describe("preview mode (EMAIL_LOG_PREVIEW=true, no SMTP)", () => {
    beforeEach(() => {
      process.env.EMAIL_LOG_PREVIEW = "true";
    });

    it("sendVerificationEmail prints the full message and never touches the transport", async () => {
      await sendVerificationEmail("new-user@example.com", VERIFY_URL);

      expect(createTransport).not.toHaveBeenCalled();
      expect(transportSendMail).not.toHaveBeenCalled();
      // The preview line is the explicit dev opt-in: full message.
      const preview = previewLines().join("\n");
      expect(preview).toContain("new-user@example.com");
      expect(preview).toContain("Verify your MetricFlock email");
      expect(preview).toContain(VERIFY_URL);
      // The structured log line carries recipient + subject only.
      const structured = structuredLines().join("\n");
      expect(structured).toContain("new-user@example.com");
      expect(structured).not.toContain(VERIFY_TOKEN);
      expect(structured).not.toContain(VERIFY_URL);
    });

    it("sendPasswordResetEmail prints the full message and never touches the transport", async () => {
      await sendPasswordResetEmail("user@example.com", RESET_URL);

      expect(createTransport).not.toHaveBeenCalled();
      expect(transportSendMail).not.toHaveBeenCalled();
      const preview = previewLines().join("\n");
      expect(preview).toContain("user@example.com");
      expect(preview).toContain("Reset your MetricFlock password");
      expect(preview).toContain(RESET_URL);
      const structured = structuredLines().join("\n");
      expect(structured).toContain("user@example.com");
      expect(structured).not.toContain(RESET_TOKEN);
      expect(structured).not.toContain(RESET_URL);
    });
  });

  describe("unconfigured mode (no SMTP, no preview)", () => {
    it("sendVerificationEmail logs recipient + subject only, never the token", async () => {
      await sendVerificationEmail("new-user@example.com", VERIFY_URL);

      expect(createTransport).not.toHaveBeenCalled();
      expect(transportSendMail).not.toHaveBeenCalled();
      const all = lines.join("\n");
      expect(all).toContain("new-user@example.com");
      expect(all).toContain("Verify your MetricFlock email");
      expect(all).not.toContain(VERIFY_TOKEN);
      expect(all).not.toContain(VERIFY_URL);
    });

    it("sendPasswordResetEmail logs recipient + subject only, never the token", async () => {
      await sendPasswordResetEmail("user@example.com", RESET_URL);

      expect(createTransport).not.toHaveBeenCalled();
      expect(transportSendMail).not.toHaveBeenCalled();
      const all = lines.join("\n");
      expect(all).toContain("user@example.com");
      expect(all).toContain("Reset your MetricFlock password");
      expect(all).not.toContain(RESET_TOKEN);
      expect(all).not.toContain(RESET_URL);
    });
  });
});
