"use client";
import { useState } from "react";
import { Button, Input } from "@/components/ui";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Schedule = {
  enabled: boolean;
  dayOfWeek: number;
  hourUtc: number;
  recipients: string[];
  lastSentAt: string | null;
};

export function ReportScheduleForm({ initial }: { initial: Schedule }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [dayOfWeek, setDayOfWeek] = useState(initial.dayOfWeek);
  const [hourUtc, setHourUtc] = useState(initial.hourUtc);
  const [recipients, setRecipients] = useState(initial.recipients.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const list = recipients
      .split(/[\n,]/)
      .map((r) => r.trim())
      .filter(Boolean);
    const res = await fetch("/api/reports/schedule", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, dayOfWeek, hourUtc, recipients: list }),
    });
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    setBusy(false);
    if (!res.ok) return setError(data?.error ?? `request_failed_${res.status}`);
    setNotice("Schedule saved.");
  }

  async function sendTest() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const res = await fetch("/api/reports/send-test", { method: "POST" });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; to?: string; error?: string } | null;
    setBusy(false);
    if (!res.ok) return setError(data?.error ?? `request_failed_${res.status}`);
    setNotice(data?.ok ? `Test report sent to ${data.to}.` : "Mail is not configured, so nothing was sent.");
  }

  const selectClass =
    "mt-1 w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700";

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Send the weekly report automatically
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="report-day" className="block text-xs font-medium text-zinc-500">
            Day (UTC)
          </label>
          <select
            id="report-day"
            className={selectClass}
            value={dayOfWeek}
            onChange={(e) => setDayOfWeek(Number(e.target.value))}
          >
            {DAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="report-hour" className="block text-xs font-medium text-zinc-500">
            Hour (UTC, 0–23)
          </label>
          <Input
            id="report-hour"
            type="number"
            min={0}
            max={23}
            value={hourUtc}
            onChange={(e) => setHourUtc(Number(e.target.value))}
          />
        </div>
      </div>
      <div>
        <label htmlFor="report-recipients" className="block text-xs font-medium text-zinc-500">
          Recipients (one email per line; empty = all Super Admins)
        </label>
        <textarea
          id="report-recipients"
          className={`${selectClass} min-h-24`}
          value={recipients}
          onChange={(e) => setRecipients(e.target.value)}
          placeholder="owner@example.com"
        />
      </div>
      {initial.lastSentAt && (
        <p className="text-xs text-zinc-500">Last sent: {new Date(initial.lastSentAt).toLocaleString()}</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-green-600">{notice}</p>}
      <div className="flex gap-2">
        <Button onClick={save}>Save schedule</Button>
        <Button onClick={sendTest} variant="outline">
          Send test report to me
        </Button>
      </div>
    </div>
  );
}
