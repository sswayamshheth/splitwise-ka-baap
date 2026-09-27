"use client";

import { useCallback, useEffect, useState } from "react";

import { cx, Icon } from "@/components/app/kit";

/**
 * Public, read-only status page: the /api/status result in plain words.
 * Opening it also wakes the server before a demo.
 */

type Status = { ok: boolean; store: string; database?: string; auth: string; ai: string; chain: boolean; payments?: string };
type Row = { label: string; value: string; good: boolean };

function rows(s: Status): Row[] {
  return [
    {
      label: "Database",
      value: s.database === "connected" ? "Connected" : s.database === "unreachable" ? "Not answering right now" : "Local file (development only)",
      good: s.database === "connected",
    },
    { label: "Sign-in", value: s.auth === "clerk" ? "Ready" : "Not set up", good: s.auth === "clerk" },
    {
      label: "Assistant",
      value: s.ai === "nugen" ? "NuGen (figures from the ledger engine)" : s.ai === "gemini" ? "Gemini — stand-in while NuGen access is waitlisted (figures from the ledger engine)" : s.ai === "claude" ? "Claude (figures from the ledger engine)" : "Rule-based (offline mode)",
      good: true,
    },
    {
      label: "Payments",
      value: s.payments === "demo" ? "Demo checkout (simulated — no money moves)" : s.payments === "test" ? "Razorpay test mode" : s.payments === "live" ? "Razorpay live" : "Off",
      good: true,
    },
    { label: "Blockchain sealing", value: s.chain ? "On (Ethereum Sepolia testnet)" : "Off", good: true },
  ];
}

export default function StatusPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setStatus((await res.json()) as Status);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setCheckedAt(new Date());
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const list = status ? rows(status) : [];
  const allGood = !failed && list.length > 0 && list.every((r) => r.good);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[520px] flex-col gap-space-md bg-surface px-margin py-space-lg">
      <div className="flex items-center gap-2">
        <Icon name="monitor_heart" className="text-[26px] text-primary" />
        <h1 className="font-headline-md text-headline-md text-on-surface">GroupTrip status</h1>
      </div>

      <div className={cx("flex items-center gap-2 rounded-xl p-space-md", failed ? "bg-error-container text-on-error-container" : allGood ? "bg-primary-fixed/60 text-on-primary-fixed-variant" : "bg-surface-container text-on-surface")}>
        <Icon name={failed ? "error" : allGood ? "check_circle" : "hourglass_top"} className="text-[22px]" />
        <span className="font-title-md text-title-md">
          {failed ? "The app isn't answering right now. Try again in a moment." : !status ? "Checking…" : allGood ? "Everything is up" : "Some parts need attention"}
        </span>
      </div>

      {list.length ? (
        <ul className="flex flex-col divide-y divide-outline-variant/40 rounded-xl bg-surface-container-lowest shadow-sm">
          {list.map((r) => (
            <li key={r.label} className="flex items-center justify-between gap-space-sm p-space-md">
              <span className="font-title-md text-title-md text-on-surface">{r.label}</span>
              <span className="flex items-center gap-1.5 text-right font-body-md text-body-md text-on-surface-variant">
                <span className={cx("h-2.5 w-2.5 shrink-0 rounded-full", r.good ? "bg-primary" : "bg-error")} aria-hidden />
                {r.value}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center justify-between">
        <span className="font-label-md text-label-md text-on-surface-variant">{checkedAt ? `Checked at ${checkedAt.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : ""}</span>
        <button onClick={() => void check()} disabled={busy} className="flex items-center gap-1 rounded-full bg-surface-container px-3 py-1.5 font-label-md text-label-md text-primary disabled:opacity-50">
          <Icon name="refresh" className="text-[18px]" /> {busy ? "Checking…" : "Check again"}
        </button>
      </div>
    </main>
  );
}
