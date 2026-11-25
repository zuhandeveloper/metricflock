// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReportScheduleForm } from "@/app/(app)/settings/reports/ReportScheduleForm";
import { fetchBody, mockFetch, mockFetchBadJson, mockFetchDelayed } from "./helpers";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const initial = { enabled: true, dayOfWeek: 1, hourUtc: 9, recipients: ["a@example.com"], lastSentAt: null };

describe("ReportScheduleForm", () => {
  it("renders initial values and saves the schedule", async () => {
    const fetchMock = mockFetch(null);
    render(<ReportScheduleForm initial={initial} />);
    expect(screen.getByLabelText("Send the weekly report automatically")).toBeChecked();
    expect(screen.getByLabelText("Day (UTC)")).toHaveValue("1");
    expect(screen.getByLabelText("Hour (UTC, 0–23)")).toHaveValue(9);
    expect(screen.getByLabelText(/Recipients/)).toHaveValue("a@example.com");
    fireEvent.change(screen.getByLabelText("Day (UTC)"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/Recipients/), {
      target: { value: "a@example.com, b@example.com\nc@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(screen.getByText("Schedule saved.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/reports/schedule",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          dayOfWeek: 5,
          hourUtc: 9,
          recipients: ["a@example.com", "b@example.com", "c@example.com"],
        }),
      }),
    );
  });

  it("shows the last-sent time when present", () => {
    render(<ReportScheduleForm initial={{ ...initial, lastSentAt: "2026-11-16T09:00:00.000Z" }} />);
    expect(screen.getByText(/Last sent:/)).toBeInTheDocument();
  });

  it("shows the server error when saving fails", async () => {
    mockFetch({ error: "invalid_recipients" }, false, 400);
    render(<ReportScheduleForm initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("invalid_recipients"));
  });

  it("lists the invalid recipient addresses when the server names them (A-API-07)", async () => {
    mockFetch({ error: "invalid_recipients", details: { invalidRecipients: ["bad", "also-bad@"] } }, false, 400);
    render(<ReportScheduleForm initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Invalid recipient emails: bad, also-bad@"),
    );
  });

  it("sends a test report and shows who it went to", async () => {
    const fetchMock = mockFetch({ ok: true, to: "me@example.com" });
    render(<ReportScheduleForm initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Send test report to me" }));
    await waitFor(() => expect(screen.getByText("Test report sent to me@example.com.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("/api/reports/send-test", expect.objectContaining({ method: "POST" }));
  });

  it("notes when mail is not configured for the test report", async () => {
    mockFetch({ ok: false });
    render(<ReportScheduleForm initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Send test report to me" }));
    await waitFor(() => expect(screen.getByText("Mail is not configured, so nothing was sent.")).toBeInTheDocument());
  });

  it("shows the server error when the test send fails", async () => {
    mockFetch({ error: "send_failed" }, false, 500);
    render(<ReportScheduleForm initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Send test report to me" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("send_failed"));
  });

  it("disables both buttons while busy", async () => {
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({}) } as Response), 200);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ReportScheduleForm initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save schedule" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Send test report to me" })).toBeDisabled();
    });
    await waitFor(() => expect(screen.getByText("Schedule saved.")).toBeInTheDocument());
  });
});

describe("gap closure: json parse failures, busy guards, field changes", () => {
  it("saves with an unparseable error body falling back to request_failed", async () => {
    mockFetchBadJson(false, 500);
    render(<ReportScheduleForm initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("send-test with an unparseable error body falls back to request_failed", async () => {
    mockFetchBadJson(false, 500);
    render(<ReportScheduleForm initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Send test report to me" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("a double save only posts once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    render(<ReportScheduleForm initial={initial} />);
    const btn = screen.getByRole("button", { name: "Save schedule" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText("Schedule saved.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("toggling the checkbox and changing the hour updates the saved values", async () => {
    const fetchMock = mockFetch(null);
    render(<ReportScheduleForm initial={initial} />);
    fireEvent.click(screen.getByLabelText("Send the weekly report automatically"));
    fireEvent.change(screen.getByLabelText("Hour (UTC, 0–23)"), { target: { value: "22" } });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(screen.getByText("Schedule saved.")).toBeInTheDocument());
    expect(JSON.parse(fetchBody(fetchMock))).toEqual({
      enabled: false,
      dayOfWeek: 1,
      hourUtc: 22,
      recipients: ["a@example.com"],
    });
  });
});
