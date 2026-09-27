"use client";

import { useCallback, useEffect, useState } from "react";

import { cx, Icon, Sheet, useFeedback } from "@/components/app/kit";
import { useOrganiserId } from "@/components/app/money/PoolSheets";
import { Face } from "@/components/app/money/parts";
import { useCheckout } from "./checkout";
import { RequestSheet } from "./PaymentRequest";
import { UpiPayPanel } from "./UpiQr";
import { api } from "@/lib/client/api";
import { errorText, useTrip } from "@/lib/client/trip";
import { depositToPool, setPoolTarget } from "@/lib/ledger/pool";
import { formatMoney, parseAmount } from "@/lib/money";

/**
 * Trip Pool funding through Razorpay TEST MODE, wired into the existing Money
 * screen. Every figure shown comes from GET /api/trips/:id/pool (derived from
 * the ledger on the server); nothing here decides that a payment succeeded —
 * the server verifies it with Razorpay first.
 */

export type PoolState = {
  tripId: string;
  poolId: string;
  currency: "INR";
  targetAmountPaise: number | null;
  collectedAmountPaise: number;
  reservedAmountPaise: number;
  refundedAmountPaise: number;
  availableAmountPaise: number;
  remainingAmountPaise: number | null;
  fundingPercentage: number | null;
  status: "open" | "funded" | "closed";
  contributions: {
    contributionId: string;
    memberId: string;
    memberName: string;
    amountPaise: number;
    refundedPaise: number;
    status: "PENDING" | "VERIFIED" | "FAILED" | "REFUND_PENDING" | "REFUNDED";
    statusLabel: string;
    orderId: string | null;
    paymentId: string | null;
    failureReason: string | null;
    createdAt: number;
  }[];
};

export type Config = { enabled: boolean; keyId: string | null; mode: "test" | "live" | "demo" | null; webhooks: boolean; missing?: string[] };

export function usePool() {
  const trip = useTrip();
  const [pool, setPool] = useState<PoolState | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const reload = useCallback(async () => {
    const [p, c] = await Promise.all([api<PoolState>(`/api/trips/${trip.tripId}/pool`), api<Config>("/api/payments/config")]);
    setPool(p);
    setConfig(c);
  }, [trip.tripId]);
  // Re-read whenever the ledger changes (a contribution, refund or vendor payment).
  const seq = trip.events.length;
  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload, seq]);
  return { pool, config, reload };
}

// ------------------------------------------------------------------ funding bar (goes inside the pool hero)

export function PoolFundingBar({ pool, onSetTarget }: { pool: PoolState | null; onSetTarget?: () => void }) {
  if (!pool) return null;
  const target = pool.targetAmountPaise;
  const pct = pool.fundingPercentage ?? 0;
  return (
    <div className="mt-4 rounded-xl bg-surface-container-low px-3.5 py-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-label-md text-label-md text-on-surface">
          {target ? (
            <>
              <span className="font-semibold">{formatMoney(pool.collectedAmountPaise)}</span> / {formatMoney(target)} funded
            </>
          ) : (
            <>Collected {formatMoney(pool.collectedAmountPaise)} · no target set</>
          )}
        </span>
        {onSetTarget ? (
          <button onClick={onSetTarget} className="font-label-sm text-label-sm font-semibold text-primary hover:underline">
            {target ? "Edit target" : "Set target"}
          </button>
        ) : null}
      </div>
      {target ? (
        <>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-container">
            <div className="h-full rounded-full bg-primary-container transition-all duration-500" style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between font-label-sm text-label-sm text-on-surface-variant">
            <span>{pct}% funded</span>
            <span>{pool.status === "funded" ? "Target reached" : `Remaining ${formatMoney(pool.remainingAmountPaise ?? 0)}`}</span>
          </div>
        </>
      ) : null}
      <p className="mt-1.5 font-label-sm text-label-sm text-on-surface-variant">
        Available {formatMoney(pool.availableAmountPaise)} = collected {formatMoney(pool.collectedAmountPaise)} − reserved for vendors {formatMoney(pool.reservedAmountPaise)} − refunded{" "}
        {formatMoney(pool.refundedAmountPaise)}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ set target (organiser)

export function TargetSheet({ open, onClose, current, onSaved }: { open: boolean; onClose: () => void; current: number | null; onSaved: () => void }) {
  const trip = useTrip();
  const { toast } = useFeedback();
  const [text, setText] = useState(current ? String(current / 100) : "");
  const [busy, setBusy] = useState(false);
  const parsed = parseAmount(text);
  async function save() {
    if (parsed.paise === undefined) return;
    setBusy(true);
    try {
      await trip.run((state, ctx) => setPoolTarget(state, parsed.paise, ctx));
      toast(`Pool target set to ${formatMoney(parsed.paise)}`);
      onSaved();
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open={open} onClose={onClose} title="Pool target">
      <p className="mb-space-md font-body-md text-body-md text-on-surface-variant">How much should the group put into the trip pool in total? Recorded in the trip ledger.</p>
      <div className="flex items-center gap-2 rounded-xl bg-surface-container-low px-space-md">
        <span className="font-headline-md text-headline-md text-on-surface-variant">₹</span>
        <input className="h-16 w-full bg-transparent font-headline-lg text-headline-lg text-on-surface outline-none" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="30000" autoFocus />
      </div>
      {parsed.error && text ? <p className="mt-1 font-label-sm text-label-sm text-error">{parsed.error}</p> : null}
      <button
        disabled={busy || parsed.paise === undefined || !parsed.paise}
        onClick={() => void save()}
        className="mt-space-lg flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary disabled:opacity-40"
      >
        <Icon name="flag" /> {busy ? "Saving…" : "Save target"}
      </button>
    </Sheet>
  );
}

// ------------------------------------------------------------------ contribute via Razorpay Checkout

export function ContributeSheet({ open, onClose, pool, config, onDone }: { open: boolean; onClose: () => void; pool: PoolState | null; config: Config | null; onDone: () => void }) {
  const trip = useTrip();
  const checkout = useCheckout();
  const [text, setText] = useState("");
  const parsed = parseAmount(text);
  const remaining = pool?.remainingAmountPaise ?? null;
  const quick = [1_000_00, 5_000_00, ...(remaining && remaining > 0 ? [remaining] : [])];
  const demo = config?.mode === "demo";
  const { toast } = useFeedback();
  // The organiser holds the pool: everyone else can pay their share straight to the organiser's UPI.
  const organiserId = useOrganiserId();
  const organiser = organiserId ? trip.participant(organiserId) : undefined;
  const iHoldThePool = organiserId === trip.meId;
  // Paying the organiser by UPI moves real money, so it's only offered when payments aren't in demo mode;
  // the checkout is the default either way.
  const upiAllowed = !!config && config.mode !== "demo";
  const [via, setVia] = useState<"upi" | "razorpay">("razorpay");
  const [recording, setRecording] = useState(false);
  const [requesting, setRequesting] = useState(false);

  async function recordUpi(utr: string | undefined) {
    if (!parsed.paise) return;
    setRecording(true);
    try {
      await trip.run((state, ctx) =>
        depositToPool(state, { participantId: trip.meId, amountPaise: parsed.paise!, method: "upi", reference: utr ? `UPI UTR ${utr} → ${organiser!.upiId}` : `UPI → ${organiser!.upiId}` }, ctx),
      );
      toast(`Added ${formatMoney(parsed.paise)} to the pool`);
      onDone();
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setRecording(false);
    }
  }

  async function pay() {
    if (parsed.paise === undefined || !parsed.paise) return;
    const res = await checkout.pay({ purpose: "pool", amountPaise: parsed.paise, payee: "the trip pool", description: `${trip.state.trip.name} · trip pool` });
    if (res.status === "VERIFIED") {
      onDone();
      onClose();
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Contribute to the pool">
      {config && !config.enabled ? (
        <div className="mb-space-md rounded-xl bg-secondary-fixed/50 p-space-md font-body-md text-body-md text-on-secondary-fixed">
          Payments are switched off on this server. You can still record a cash/UPI deposit manually.
        </div>
      ) : null}
      <div className="flex items-center gap-2 rounded-xl bg-surface-container-low px-space-md">
        <span className="font-headline-md text-headline-md text-on-surface-variant">₹</span>
        <input className="h-16 w-full bg-transparent font-headline-lg text-headline-lg text-on-surface outline-none" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder="5000" autoFocus />
      </div>
      {parsed.error && text ? <p className="mt-1 font-label-sm text-label-sm text-error">{parsed.error}</p> : null}
      {upiAllowed ? (
      <div className="mt-space-sm flex gap-2">
        {(
          [
            ["razorpay", "credit_card", "Card / netbanking"],
            ["upi", "qr_code_2", "UPI app · real payment"],
          ] as const
        ).map(([id, icon, label]) => (
          <button
            key={id}
            onClick={() => setVia(id)}
            className={cx("flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 font-label-md text-label-md transition-colors", via === id ? "bg-primary-container text-on-primary" : "bg-surface-container-low text-on-surface-variant")}
          >
            <Icon name={icon} className="text-[18px]" /> {label}
          </button>
        ))}
      </div>
      ) : null}
      <div className="mt-space-sm flex flex-wrap gap-2">
        {quick.map((q, i) => (
          <button key={`${q}-${i}`} onClick={() => setText(String(q / 100))} className="rounded-full bg-surface-container px-3 py-1 font-label-md text-label-md text-on-surface-variant hover:bg-surface-variant">
            {i === quick.length - 1 && remaining === q ? `Remaining ${formatMoney(q)}` : formatMoney(q)}
          </button>
        ))}
      </div>
      {via === "upi" && upiAllowed ? (
        <div className="mt-space-md">
          {iHoldThePool ? (
            <p className="rounded-xl bg-surface-container-low p-space-md font-body-md text-body-md text-on-surface-variant">
              You hold the pool{organiser?.upiId ? ` (${organiser.upiId})` : ""}, so there&apos;s nothing to send. Everyone else pays their share to your UPI here; record your own cash with &quot;Record it manually&quot;.
            </p>
          ) : null}
          {iHoldThePool && config?.enabled && !demo ? (
            <button onClick={() => setRequesting(true)} className="mt-space-sm flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary font-title-md text-title-md text-on-primary">
              <Icon name="bolt" /> Request a member&apos;s share via Razorpay
            </button>
          ) : null}
          {iHoldThePool ? null : !organiser?.upiId ? (
            <p className="rounded-xl bg-surface-container-low p-space-md font-body-md text-body-md text-on-surface-variant">
              {organiser ? `${organiser.name} hasn't added a UPI ID yet` : "This trip has no organiser"} — use card / netbanking, or ask them to add it in Profile.
            </p>
          ) : parsed.paise ? (
            <UpiPayPanel
              vpa={organiser.upiId}
              name={organiser.name}
              amountPaise={parsed.paise}
              note={`${trip.state.trip.name} pool`.slice(0, 50)}
              busy={recording}
              confirmLabel="I've paid — add to the pool"
              onConfirm={(utr) => void recordUpi(utr)}
            />
          ) : (
            <p className="font-body-md text-body-md text-on-surface-variant">
              Enter an amount — you&apos;ll pay it to {organiser.name} ({organiser.upiId}), who holds the pool.
            </p>
          )}
        </div>
      ) : null}
      {via === "razorpay" || !upiAllowed ? (
      <button
        disabled={checkout.busy || (config ? !config.enabled : false) || parsed.paise === undefined || !parsed.paise}
        onClick={() => void pay()}
        className="mt-space-lg flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary shadow-sm disabled:opacity-40"
      >
        <Icon name="lock" /> {checkout.busy ? "Opening checkout…" : `Pay ${parsed.paise ? formatMoney(parsed.paise) : ""}${demo ? " (demo checkout)" : " with Razorpay"}`}
      </button>
      ) : null}
      <p className="mt-space-sm text-center font-label-sm text-label-sm text-on-surface-variant">
        {demo ? (
          <>Demo checkout — simulated, no money moves. </>
        ) : (
          <>
            Razorpay <span className="font-semibold">{config?.mode === "live" ? "live" : "test"} mode</span>.{" "}
          </>
        )}
        GroupTrip records the contribution only after the server verifies the payment with Razorpay.
      </p>
      {checkout.element}
      {requesting ? <RequestSheet open onClose={() => setRequesting(false)} purpose="pool" amountPaise={parsed.paise} /> : null}
    </Sheet>
  );
}

// ------------------------------------------------------------------ transaction history

export function PoolPayments({ pool, config, onChanged }: { pool: PoolState | null; config?: Config | null; onChanged: () => void }) {
  const trip = useTrip();
  const { toast, confirm } = useFeedback();
  const [busyId, setBusyId] = useState<string | null>(null);
  const demo = config?.mode === "demo";
  if (!pool || pool.contributions.length === 0) return null;

  async function refund(c: PoolState["contributions"][number]) {
    if (!c.paymentId) return;
    const ok = await confirm({
      title: `Refund ${formatMoney(c.amountPaise)} to ${c.memberName}?`,
      message: demo
        ? "Demo refund — simulated, no money moves. The pool and ledger update once it's processed. Only unspent pool money can be refunded."
        : "Razorpay (test mode) refunds the payment; the pool and ledger update once the refund is processed. Only unspent pool money can be refunded.",
      confirm: "Refund",
      danger: true,
    });
    if (!ok) return;
    setBusyId(c.contributionId);
    try {
      const out = await api<{ refundStatus: string }>(`/api/payments/${c.paymentId}/refund`, { body: {} });
      await trip.refresh();
      onChanged();
      toast(out.refundStatus === "processed" ? "Refund processed · pool and ledger updated" : demo ? "Refund requested — the pool updates once it's confirmed" : "Refund requested — the pool updates when Razorpay confirms it");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusyId(null);
    }
  }

  const tone: Record<string, string> = {
    VERIFIED: "bg-primary-fixed/60 text-on-primary-fixed-variant",
    PENDING: "bg-secondary-fixed text-on-secondary-fixed-variant",
    REFUND_PENDING: "bg-secondary-fixed text-on-secondary-fixed-variant",
    FAILED: "bg-error-container text-on-error-container",
    REFUNDED: "bg-surface-container text-on-surface-variant",
  };
  return (
    <section className="px-margin pb-space-sm pt-space-md">
      <div className="mb-space-sm flex items-center justify-between">
        <h3 className="font-headline-sm text-headline-sm text-on-surface">Pool Payments</h3>
        {config?.mode ? (
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{demo ? "Demo checkout · simulated" : `Razorpay · ${config.mode} mode`}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        {pool.contributions.map((c) => {
          const canRefund = c.status === "VERIFIED" && (trip.role === "owner" || trip.isMe(c.memberId));
          return (
            <div key={c.contributionId} className="flex items-center justify-between gap-space-sm rounded-xl bg-surface-container-lowest p-3.5 shadow-sm">
              <div className="flex min-w-0 items-center gap-3">
                <Face name={c.memberName} size={36} />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-title-md text-title-md text-on-surface">{trip.isMe(c.memberId) ? "You" : c.memberName}</span>
                  <span className="truncate font-label-sm text-label-sm text-on-surface-variant">
                    {new Date(c.createdAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                    {c.paymentId ? ` · ${c.paymentId.startsWith("pay_demo_") ? "Demo payment" : c.paymentId}` : ""}
                    {c.failureReason ? ` · ${c.failureReason}` : ""}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="font-title-md text-title-md text-on-surface">{formatMoney(c.amountPaise)}</span>
                <div className="flex items-center gap-1.5">
                  <span className={cx("rounded-full px-2 py-0.5 font-label-sm text-label-sm", tone[c.status])}>{c.statusLabel}</span>
                  {canRefund ? (
                    <button disabled={busyId === c.contributionId} onClick={() => void refund(c)} className="font-label-sm text-label-sm font-semibold text-primary hover:underline disabled:opacity-40">
                      Refund
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}


