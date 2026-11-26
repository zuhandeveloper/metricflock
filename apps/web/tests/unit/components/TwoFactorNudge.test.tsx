// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import TwoFactorNudge from "@/components/TwoFactorNudge";

// A-SEC-08: the recommendation banner for non-SUPER_ADMIN users.
// Visibility (role + 2FA state) is decided by the (app) layout via
// shouldNudgeTwoFactor — covered in two-factor-gate.test.ts and
// AppLayoutTwoFactor.test.tsx. This file covers the banner itself.

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("TwoFactorNudge", () => {
  it("recommends enabling 2FA and links to the security settings page", () => {
    render(<TwoFactorNudge />);
    expect(screen.getByText(/Two-factor authentication is off for your account/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /set it up in Settings/ })).toHaveAttribute("href", "/settings/security");
  });

  it("can be dismissed", () => {
    render(<TwoFactorNudge />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss two-factor recommendation" }));
    expect(screen.queryByText(/Two-factor authentication is off for your account/)).not.toBeInTheDocument();
  });
});
