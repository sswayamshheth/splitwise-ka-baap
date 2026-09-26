"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";

import { Icon, useFeedback } from "@/components/app/kit";
import { api, ApiError } from "@/lib/client/api";
import { errorText, useTrip } from "@/lib/client/trip";
import { formatMoney } from "@/lib/money";

/**
 * The ONE checkout path for every payment in the app (pool contributions and
 * vendor payments). The server creates the order, then:
 *  - Razorpay test/live keys configured → Razorpay Checkout opens;
 *  - no keys (mode "demo") → an in-app demo checkout, clearly labelled as
 *    simulated, completes the order through POST /api/payments/demo.
 * Either way the browser only relays the signed response to /api/payments/verify;
 * the server decides whether money was received. Toasts reflect the server's answer.
 */

export type CheckoutRequest = {
  purpose: "pool" | "vendor" | "settle";
  amountPaise: number;
  /** For settle-ups: the member being paid. */
  toId?: string;
  /** Shown on the checkout: who the money goes to. */
  payee: string;
  description: string;
  itemId?: string;
  /** Card or account name used (for vendor payments / the optimiser). */
  methodLabel?: string;
};

export type CheckoutResult = { status: "VERIFIED" | "FAILED" | "PENDING" | "CANCELLED" | "ERROR" };

type Order = { contributionId: string; orderId: string; amountPaise: number; currency: string; keyId: string; mode: "test" | "live" | "demo"; name: string };
type Signed = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };

type RazorpayInstance = { open: () => void; on: (event: string, cb: (res: { error?: { description?: string } }) => void) => void };
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

function loadCheckoutScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("No browser"));
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const src = "https://checkout.razorpay.com/v1/checkout.js";
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    const s = existing ?? document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't load Razorpay Checkout — check your connection"));
    if (!existing) document.body.appendChild(s);
  });
}

type DemoState = { order: Order; req: CheckoutRequest; resolve: (s: Signed | null) => void; busy: boolean };

export function useCheckout() {
  const trip = useTrip();
  const { toast } = useFeedback();
  const [demo, setDemo] = useState<DemoState | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const verify = useCallback(
    async (order: Order, signed: Signed, req: CheckoutRequest): Promise<CheckoutResult> => {
      try {
        const out = await api<{ status: "VERIFIED" | "FAILED" | "PENDING" }>("/api/payments/verify", { body: { contributionId: order.contributionId, ...signed } });
        await trip.refresh();
        if (out.status === "VERIFIED") {
          toast(
            req.purpose === "vendor"
              ? `Payment verified by the server · ${formatMoney(order.amountPaise)} to ${req.payee} recorded`
              : req.purpose === "settle"
                ? `Paid ${formatMoney(order.amountPaise)} to ${req.payee} · settled automatically`
                : `Contribution verified by the server · ${formatMoney(order.amountPaise)} added to the pool`,
          );
        } else if (out.status === "FAILED") toast("The payment failed — nothing was recorded. You can try again.", "error");
        else toast(order.mode === "demo" ? "Payment pending — the pool updates once it's confirmed" : "Payment received — waiting for confirmation from Razorpay");
        return { status: out.status };
      } catch (e) {
        toast(e instanceof ApiError ? e.message : "We couldn't verify that payment — nothing was recorded", "error");
        return { status: "ERROR" };
      }
    },
    [toast, trip],
  );

  const pay = useCallback(
    async (req: CheckoutRequest): Promise<CheckoutResult> => {
      if (busyRef.current) return { status: "CANCELLED" };
      busyRef.current = true;
      setBusy(true);
      try {
        const order = await api<Order>("/api/payments/orders", {
          body: { tripId: trip.tripId, memberId: trip.meId, amountPaise: req.amountPaise, currency: "INR", purpose: req.purpose, itemId: req.itemId, toId: req.toId, methodLabel: req.methodLabel },
        });

        if (order.mode === "demo") {
          const signed = await new Promise<Signed | null>((resolve) => setDemo({ order, req, resolve, busy: false }));
          setDemo(null);
          if (!signed) {
            toast("Checkout closed — nothing was collected");
            return { status: "CANCELLED" };
          }
          return await verify(order, signed, req);
        }

        await loadCheckoutScript();
        if (!window.Razorpay) throw new Error("Razorpay Checkout didn't load");
        return await new Promise<CheckoutResult>((resolve) => {
          const rz = new window.Razorpay!({
            key: order.keyId,
            order_id: order.orderId,
            amount: order.amountPaise,
            currency: order.currency,
            name: "GroupTrip",
            description: `${req.description}${order.mode === "test" ? " (TEST MODE)" : ""}`,
            prefill: { name: order.name },
            notes: { contributionId: order.contributionId },
            theme: { color: "#1e6f64" },
            handler: (res: Signed) => void verify(order, res, req).then(resolve),
            modal: {
              ondismiss: () => {
                toast("Checkout closed — nothing was collected");
                resolve({ status: "CANCELLED" });
              },
            },
          });
          rz.on("payment.failed", (r) => toast(`Payment failed: ${r.error?.description ?? "declined"} — nothing was recorded`, "error"));
          rz.open();
        });
      } catch (e) {
        toast(errorText(e), "error");
        return { status: "ERROR" };
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [toast, trip.meId, trip.tripId, verify],
  );

  async function finishDemo(outcome: "success" | "fail") {
    if (!demo) return;
    setDemo({ ...demo, busy: true });
    try {
      const signed = await api<Signed>("/api/payments/demo", { body: { contributionId: demo.order.contributionId, outcome } });
      demo.resolve(signed);
    } catch (e) {
      toast(errorText(e), "error");
      demo.resolve(null);
    }
  }

  const element: ReactNode = demo ? (
    <DemoCheckout state={demo} onPay={() => void finishDemo("success")} onFail={() => void finishDemo("fail")} onClose={() => demo.resolve(null)} />
  ) : null;

  return { pay, busy, element };
}

function DemoCheckout({ state, onPay, onFail, onClose }: { state: DemoState; onPay: () => void; onFail: () => void; onClose: () => void }) {
  const { order, req, busy } = state;
  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-inverse-surface/60 sm:items-center" role="dialog" aria-modal aria-label="Demo checkout">
      <div className="w-full max-w-[420px] overflow-hidden rounded-t-[28px] bg-surface-container-lowest shadow-2xl sm:rounded-[24px]">
        <div className="flex items-center justify-between bg-inverse-surface px-space-lg py-space-md text-inverse-on-surface">
          <div className="flex items-center gap-2">
            <Icon name="lock" className="text-[18px]" />
            <span className="font-title-md text-title-md">GroupTrip checkout</span>
          </div>
          <button onClick={onClose} disabled={busy} aria-label="Close checkout" className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10 disabled:opacity-40">
            <Icon name="close" />
          </button>
        </div>
        <div className="flex flex-col gap-space-md p-space-lg">
          <div className="flex items-start gap-2 rounded-xl bg-secondary-fixed/60 px-space-md py-space-sm font-label-md text-label-md text-on-secondary-fixed">
            <Icon name="science" className="mt-0.5 text-[16px]" />
            <span>Demo checkout — simulated, no money moves.</span>
          </div>
          <div className="text-center">
            <p className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Paying {req.payee}</p>
            <p className="mt-1 font-display-lg-mobile text-display-lg-mobile text-on-surface">{formatMoney(order.amountPaise)}</p>
            <p className="mt-1 font-body-md text-body-md text-on-surface-variant">{req.description}</p>
          </div>
          <div className="flex flex-col divide-y divide-outline-variant/40 rounded-xl bg-surface-container-low">
            <Row label="From" value={order.name} />
            <Row label="Pay with" value={req.methodLabel ?? "Card / UPI (demo)"} />
            <Row label="Order" value={order.orderId} mono />
          </div>
          <button
            disabled={busy}
            onClick={onPay}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary shadow-sm disabled:opacity-50"
          >
            <Icon name="check_circle" /> {busy ? "Processing…" : `Pay ${formatMoney(order.amountPaise)}`}
          </button>
          <button disabled={busy} onClick={onFail} className="font-label-md text-label-md text-error hover:underline disabled:opacity-40">
            Simulate a failed payment
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-space-sm px-space-md py-2.5">
      <span className="font-label-md text-label-md text-on-surface-variant">{label}</span>
      <span className={mono ? "truncate font-mono text-[12px] text-on-surface" : "truncate font-title-md text-title-md text-on-surface"}>{value}</span>
    </div>
  );
}
