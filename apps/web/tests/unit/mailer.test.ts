import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendMail, mailerMode } from "@metricflock/auth/mailer";

// Phase 2 (F-2.3): auth email bodies carry credential-equivalent URLs and
// must never reach the logs unless EMAIL_LOG_PREVIEW=true is set explicitly.
const SECRET_URL = "https://metricflock.bond/reset-password?token=super-secret-token";

describe("mailer (F-2.3)", () => {
  const saved = { ...process.env };
  let lines: string[] = [];

  beforeEach(() => {
    lines = [];
    for (const m of ["log", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    delete process.env.SMTP_HOST;
    delete process.env.EMAIL_LOG_PREVIEW;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it("mode is unconfigured without SMTP and without preview", () => {
    expect(mailerMode()).toBe("unconfigured");
  });
  it("mode is preview only when EMAIL_LOG_PREVIEW=true", () => {
    process.env.EMAIL_LOG_PREVIEW = "true";
    expect(mailerMode()).toBe("preview");
    process.env.EMAIL_LOG_PREVIEW = "1";
    expect(mailerMode()).toBe("unconfigured");
  });
  it("mode is smtp when SMTP_HOST is set (preview flag irrelevant)", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_LOG_PREVIEW = "true";
    expect(mailerMode()).toBe("smtp");
  });
  it("unconfigured mode never logs the body or the auth URL", async () => {
    await sendMail({
      to: "user@example.com",
      subject: "Reset your MetricFlock password",
      text: `Reset here:\n${SECRET_URL}`,
    });
    const all = lines.join("\n");
    expect(all).not.toContain(SECRET_URL);
    expect(all).not.toContain("super-secret-token");
    // ...but the failure is visible with recipient + subject.
    expect(all).toContain("user@example.com");
    expect(all).toContain("Reset your MetricFlock password");
  });
  it("preview mode prints the full message (explicit dev opt-in)", async () => {
    process.env.EMAIL_LOG_PREVIEW = "true";
    await sendMail({
      to: "user@example.com",
      subject: "Reset your MetricFlock password",
      text: `Reset here:\n${SECRET_URL}`,
    });
    expect(lines.join("\n")).toContain(SECRET_URL);
  });
});
