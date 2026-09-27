"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

import { Icon, inputCls } from "@/components/app/kit";
import { upiIntentUrl } from "@/lib/ledger/commands";
import { formatMoney } from "@/lib/money";
import { useRealUpiAllowed } from "./paymentConfig";

/**
 * A real UPI payment request: the upi://pay link as a QR (scan it with any UPI
 * app) and as a button (opens the UPI app on a phone). The money moves in the
 * payer's own UPI app — GroupTrip never touches it. Afterwards the payer
 * confirms here (optionally with the UTR) and the payment is recorded.
 * It moves real money bank to bank (no Razorpay), and says so on screen.
 */
export function UpiPayPanel({
  vpa,
  name,
  amountPaise,
  note,
  busy,
  confirmLabel,
  onConfirm,
}: {
  vpa: string;
  name: string;
  amountPaise: number;
  note: string;
  busy?: boolean;
  confirmLabel: string;
  onConfirm: (utr: string | undefined) => void;
}) {
  const allowed = useRealUpiAllowed();
  const url = upiIntentUrl({ vpa, name, amountPaise, note });
  const [img, setImg] = useState<string | null>(null);
  const [utr, setUtr] = useState("");
  const [paid, setPaid] = useState(false);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, { width: 360, margin: 1, errorCorrectionLevel: "M", color: { dark: "#0e1e1b", light: "#ffffff" } })
      .then((d) => alive && setImg(d))
      .catch(() => alive && setImg(null));
    return () => {
      alive = false;
    };
  }, [url]);
  const utrOk = !utr || /^\d{12}$/.test(utr.trim());
  if (!allowed) return null;

  return (
    <div className="flex flex-col items-center gap-space-md">
      <p className="flex w-full items-start gap-1.5 rounded-xl bg-secondary-fixed/60 px-space-md py-space-sm font-label-md text-label-md text-on-secondary-fixed">
        <Icon name="info" className="mt-0.5 text-[16px]" /> Real payment: the money leaves your bank through your own UPI app.
      </p>
      <div className="rounded-2xl bg-surface-container-lowest p-3 shadow-sm ring-1 ring-outline-variant/40">
        {img ? <img src={img} alt={`UPI QR to pay ${name}`} className="h-56 w-56" /> : <div className="flex h-56 w-56 items-center justify-center text-on-surface-variant">Generating QR…</div>}
      </div>
      <div className="text-center">
        <p className="font-headline-sm text-headline-sm text-on-surface">{formatMoney(amountPaise)}</p>
        <p className="font-body-md text-body-md text-on-surface-variant">
          to {name} · <span className="font-mono">{vpa}</span>
        </p>
      </div>
      <a href={url} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-secondary-container font-title-md text-title-md text-on-secondary-container">
        <Icon name="open_in_new" /> Open UPI app · real payment
      </a>
      <p className="-mt-2 text-center font-label-sm text-label-sm text-on-surface-variant">Scan with GPay / PhonePe / Paytm, or tap “Open UPI app” on your phone. The money moves in your UPI app — not through GroupTrip.</p>

      {!paid ? (
        <button onClick={() => setPaid(true)} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary">
          <Icon name="task_alt" /> I&apos;ve paid
        </button>
      ) : (
        <div className="flex w-full flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="font-label-md text-label-md text-on-surface-variant">UPI reference / UTR (optional, 12 digits)</span>
            <input className={inputCls} value={utr} onChange={(e) => setUtr(e.target.value.replace(/\D/g, "").slice(0, 12))} inputMode="numeric" placeholder="e.g. 427110998231" />
          </label>
          {!utrOk ? <p className="font-label-sm text-label-sm text-error">A UTR is 12 digits — or leave it empty.</p> : null}
          <button
            disabled={busy || !utrOk}
            onClick={() => onConfirm(utr.trim() || undefined)}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary disabled:opacity-40"
          >
            <Icon name="check" /> {busy ? "Recording…" : confirmLabel}
          </button>
        </div>
      )}
    </div>
  );
}
