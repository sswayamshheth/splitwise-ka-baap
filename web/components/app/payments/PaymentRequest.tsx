"use client";

import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";

import { Chip, cx, Icon, Sheet, useFeedback } from "@/components/app/kit";
import { api } from "@/lib/client/api";
import { errorText, useTrip } from "@/lib/client/trip";
import { formatMoney, parseAmount } from "@/lib/money";

/**
 * Money requests through Razorpay Payment Links. The payer opens the link (or
 * scans its QR) and pays on Razorpay's page with UPI, card or netbanking; the
 * app asks Razorpay every few seconds and records the payment by itself —
 * into the pool, or as a settled transfer. Nobody marks anything as paid.
 */

type Req = { contributionId: string; from: string; purpose: "pool" | "settle" | string; amountPaise: number; status: string; url: string | null; createdAt: number };

/** Polls the trip's open requests; refreshes the ledger when one gets paid. */
export function usePaymentRequests(enabled = true) {
  const trip = useTrip();
  const { toast } = useFeedback();
  const [requests, setRequests] = useState<Req[]>([]);
  const seen = useRef<Map<string, string>>(new Map());
  const load = useCallback(async () => {
    try {
      const { requests: list } = await api<{ requests: Req[] }>(`/api/trips/${trip.tripId}/requests`);
      let newlyPaid: Req | null = null;
      for (const r of list) {
        const before = seen.current.get(r.contributionId);
        if (before === "PENDING" && r.status === "VERIFIED") newlyPaid = r;
        seen.current.set(r.contributionId, r.status);
      }
      setRequests(list);
      if (newlyPaid) {
        await trip.refresh();
        toast(`${trip.short(newlyPaid.from)} paid ${formatMoney(newlyPaid.amountPaise)} via Razorpay · recorded automatically`);
      }
    } catch {
      /* keep the last list */
    }
  }, [trip, toast]);
  const anyPending = requests.some((r) => r.status === "PENDING");
  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);
  useEffect(() => {
    if (!enabled || !anyPending) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [enabled, anyPending, load]);
  return { requests, reload: load };
}

function LinkCard({ url, amountPaise, who, paid }: { url: string; amountPaise: number; who: string; paid: boolean }) {
  const [img, setImg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void QRCode.toDataURL(url, { width: 320, margin: 1, errorCorrectionLevel: "M", color: { dark: "#0e1e1b", light: "#ffffff" } }).then(setImg);
  }, [url]);
  const text = `Pay ${formatMoney(amountPaise)} for our trip: ${url}`;
  if (paid) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl bg-primary-fixed/50 p-space-lg text-center">
        <Icon name="verified" className="text-[40px] text-primary" />
        <p className="font-title-lg text-title-lg text-on-surface">{who} paid {formatMoney(amountPaise)}</p>
        <p className="font-body-md text-body-md text-on-surface-variant">Razorpay confirmed it — recorded in the ledger automatically.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-space-sm">
      <div className="rounded-2xl bg-white p-2 shadow-sm">{img ? <img src={img} alt="Payment link QR" className="h-52 w-52" /> : <div className="flex h-52 w-52 items-center justify-center text-on-surface-variant">Making QR…</div>}</div>
      <p className="text-center font-body-md text-body-md text-on-surface-variant">
        {who} scans this or opens the link, and pays {formatMoney(amountPaise)} with UPI, card or netbanking on Razorpay.
      </p>
      <p className="break-all rounded-lg bg-surface-container-low px-3 py-1.5 font-mono text-[12px] text-on-surface">{url}</p>
      <div className="flex w-full gap-2">
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(url);
            setCopied(true);
          }}
          className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-surface-container font-label-md text-label-md text-on-surface"
        >
          <Icon name="content_copy" className="text-[18px]" /> {copied ? "Copied" : "Copy link"}
        </button>
        <a href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer" className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary-container font-label-md text-label-md text-on-primary">
          <Icon name="share" className="text-[18px]" /> WhatsApp
        </a>
        <a href={url} target="_blank" rel="noreferrer" className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-surface-container font-label-md text-label-md text-on-surface">
          <Icon name="open_in_new" className="text-[18px]" /> Open
        </a>
      </div>
      <p className="flex items-center gap-1.5 font-label-md text-label-md text-on-surface-variant">
        <Icon name="sync" className="animate-spin text-[16px]" /> Waiting for payment — checking with Razorpay every 5 s
      </p>
    </div>
  );
}

/**
 * Request money: a settle-up (fixed payer + amount, owed to me) or a pool
 * share (pick the member and amount). Test mode: Razorpay's page takes test
 * payments only.
 */
export function RequestSheet({ open, onClose, purpose, fromId, amountPaise }: { open: boolean; onClose: () => void; purpose: "pool" | "settle"; fromId?: string; amountPaise?: number }) {
  const trip = useTrip();
  const { toast } = useFeedback();
  const others = trip.state.participants.filter((p) => !p.leftOn && p.id !== trip.meId);
  const [who, setWho] = useState<string | undefined>(fromId ?? others[0]?.id);
  const [text, setText] = useState(amountPaise ? String(amountPaise / 100) : "");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ contributionId: string; url: string; amountPaise: number; from: string } | null>(null);
  const { requests } = usePaymentRequests(!!made);
  const status = made ? requests.find((r) => r.contributionId === made.contributionId)?.status : undefined;
  const parsed = parseAmount(text);

  async function create() {
    if (!who || !parsed.paise) return;
    setBusy(true);
    try {
      const r = await api<{ contributionId: string; url: string; amountPaise: number; from: string }>(`/api/trips/${trip.tripId}/requests`, { body: { fromId: who, amountPaise: parsed.paise, purpose } });
      setMade(r);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={purpose === "settle" ? "Request via Razorpay" : "Request a pool share"}>
      {made ? (
        <LinkCard url={made.url} amountPaise={made.amountPaise} who={made.from} paid={status === "VERIFIED"} />
      ) : (
        <div className="flex flex-col gap-space-md">
          {purpose === "pool" ? (
            <>
              <p className="font-label-md text-label-md text-on-surface-variant">Who should pay into the pool?</p>
              <div className="flex flex-wrap gap-2">
                {others.map((p) => (
                  <Chip key={p.id} selected={who === p.id} onClick={() => setWho(p.id)}>
                    {trip.short(p.id)}
                  </Chip>
                ))}
              </div>
            </>
          ) : (
            <p className="font-body-md text-body-md text-on-surface-variant">
              {trip.fullName(who ?? "")} owes you {amountPaise ? formatMoney(amountPaise) : ""}. They&apos;ll get a Razorpay link; when they pay, the transfer settles by itself.
            </p>
          )}
          <div className="flex items-center gap-2 rounded-xl bg-surface-container-low px-space-md">
            <span className="font-headline-md text-headline-md text-on-surface-variant">₹</span>
            <input className="h-14 w-full bg-transparent font-headline-md text-headline-md text-on-surface outline-none" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="0" aria-label="Amount" readOnly={purpose === "settle"} />
          </div>
          <button
            disabled={busy || !who || !parsed.paise}
            onClick={() => void create()}
            className={cx("flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary disabled:opacity-40")}
          >
            <Icon name="link" /> {busy ? "Creating link…" : `Create Razorpay link${parsed.paise ? ` for ${formatMoney(parsed.paise)}` : ""}`}
          </button>
          <p className="text-center font-label-sm text-label-sm text-on-surface-variant">Razorpay test mode: the payer&apos;s page takes test payments only.</p>
        </div>
      )}
    </Sheet>
  );
}

/** Open and recently paid requests, kept in sync with Razorpay while any are open. */
export function PaymentRequests() {
  const trip = useTrip();
  const { requests } = usePaymentRequests(true);
  if (requests.length === 0) return null;
  return (
    <section className="px-margin pb-space-sm pt-space-md">
      <div className="mb-space-sm flex items-center justify-between">
        <h3 className="font-headline-sm text-headline-sm text-on-surface">Payment requests</h3>
        <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Auto-updating</span>
      </div>
      <div className="flex flex-col gap-2">
        {requests.map((r) => (
          <div key={r.contributionId} className="flex items-center justify-between gap-space-sm rounded-xl bg-surface-container-lowest p-space-md shadow-sm">
            <div className="min-w-0">
              <p className="font-title-md text-title-md text-on-surface">
                {trip.short(r.from)} · {formatMoney(r.amountPaise)}
              </p>
              <p className="truncate font-label-sm text-label-sm text-on-surface-variant">
                {r.purpose === "settle" ? "Settle-up" : "Pool share"} ·{" "}
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noreferrer" className="text-primary underline">
                    {r.url.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  "Razorpay link"
                )}
              </p>
            </div>
            <span
              className={cx(
                "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 font-label-sm text-label-sm",
                r.status === "VERIFIED" ? "bg-primary-fixed/60 text-on-primary-fixed-variant" : r.status === "FAILED" ? "bg-error-container text-on-error-container" : "bg-secondary-fixed text-on-secondary-fixed-variant",
              )}
            >
              <Icon name={r.status === "VERIFIED" ? "verified" : r.status === "FAILED" ? "block" : "hourglass_top"} className="text-[14px]" />
              {r.status === "VERIFIED" ? "Paid · recorded" : r.status === "FAILED" ? "Expired" : "Waiting"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
