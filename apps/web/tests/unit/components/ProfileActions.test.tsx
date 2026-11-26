// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChangePasswordForm, NameForm, SetPasswordForm } from "@/app/(app)/settings/profile/ProfileActions";
import { fetchBody, mockFetch } from "./helpers";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh, replace: nav.replace }),
}));

const client = vi.hoisted(() => ({ updateUser: vi.fn(), changePassword: vi.fn() }));
vi.mock("@metricflock/auth/client", () => ({
  authClient: { updateUser: client.updateUser, changePassword: client.changePassword },
}));

beforeEach(() => {
  vi.clearAllMocks();
  client.updateUser.mockResolvedValue({ data: {}, error: null });
  client.changePassword.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NameForm", () => {
  it("saves the trimmed name via authClient.updateUser and refreshes", async () => {
    render(<NameForm initialName="Admin" />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  New Name  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Name saved."));
    expect(client.updateUser).toHaveBeenCalledWith({ name: "New Name" });
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("rejects an empty name without calling the client", async () => {
    render(<NameForm initialName="Admin" />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Name cannot be empty."));
    expect(client.updateUser).not.toHaveBeenCalled();
  });

  it("maps a stale-session error to a sign-in-again message", async () => {
    client.updateUser.mockResolvedValue({ data: null, error: { status: 401, code: "UNAUTHORIZED" } });
    render(<NameForm initialName="Admin" />);
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/sign in again/));
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});

describe("SetPasswordForm", () => {
  it("posts the new password to the set-password route and refreshes on success", async () => {
    const fetchMock = mockFetch({ status: "ok" });
    render(<SetPasswordForm />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "long-enough-password" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "long-enough-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/profile/set-password", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetchBody(fetchMock))).toEqual({ newPassword: "long-enough-password" });
  });

  it("rejects a short password and a mismatched confirmation without posting", async () => {
    const fetchMock = mockFetch({ status: "ok" });
    render(<SetPasswordForm />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("at least 12 characters"));
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "long-enough-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Passwords do not match."));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server's message when the route rejects (e.g. stale session)", async () => {
    mockFetch({ error: "session_not_fresh", details: { message: "Please sign in again to continue." } }, false, 401);
    render(<SetPasswordForm />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "long-enough-password" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "long-enough-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Please sign in again to continue."));
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});

describe("ChangePasswordForm", () => {
  it("changes the password via authClient.changePassword and clears the fields", async () => {
    render(<ChangePasswordForm />);
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old-password-123" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password-456" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "new-password-456" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Password changed."));
    expect(client.changePassword).toHaveBeenCalledWith({
      currentPassword: "old-password-123",
      newPassword: "new-password-456",
    });
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("maps a wrong current password to an honest error", async () => {
    client.changePassword.mockResolvedValue({ data: null, error: { status: 400, code: "INVALID_PASSWORD" } });
    render(<ChangePasswordForm />);
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "wrong-password" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password-456" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "new-password-456" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The current password is incorrect."));
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("rejects a mismatched confirmation without calling the client", async () => {
    render(<ChangePasswordForm />);
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old-password-123" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password-456" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "different-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Passwords do not match."));
    expect(client.changePassword).not.toHaveBeenCalled();
  });
});
