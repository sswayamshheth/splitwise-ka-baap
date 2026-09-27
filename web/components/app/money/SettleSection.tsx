"use client";

import QRCode from "qrcode";
import { useEffect, useState, type ReactNode } from "react";

import { cx, Icon, Sheet, useFeedback } from "@/components/app/kit";
import { UpiPayPanel } from "@/components/app/payments/UpiQr";
import { useCheckout } from "@/components/app/payments/checkout";
import { RequestSheet } from "@/components/app/payments/PaymentRequest";
import { usePaymentConfig, useRealUpiAllowed } from "@/components/app/payments/paymentConfig";
import { errorText, useTrip } from "@/lib/client/trip";
import { formatRelative } from "@/lib/dates";
import { cancelSettlement, confirmSettlement, initiateSettlement, upiIntentUrl } from "@/lib/ledger/commands";
import { MAX_EXACT } from "@/lib/ledger/settlement";
import type { SettlementData } from "@/lib/ledger/types";
import { formatMoney } from "@/lib/money";
import { BalanceBars, Eyebrow, Face, FacePair } from "./parts";

/**
 * Settle up (Stitch "settle" layout), straight from the settlement engine:
 * my position, provisional balances, the pairwise-debt baseline vs the
 * optimised plan with its exact guarantee, and the three-state payment flow
 * (initiated → confirmed; only confirmed payments move balances).
 */
export function SettleSection() {
  const trip = useTrip();
  const { toast, confirm } = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ from: string; amountPaise: number } | null>(null);
  // Real UPI between members: my QR for someone who owes me, or their QR when I owe them.
  const [upiSheet, setUpiSheet] = useState<{ from: string; to: string; amountPaise: number } | null>(null);
  const checkout = useCheckout();
  // Razorpay settle-ups and payment requests need real Razorpay keys; hidden in demo mode.
  const payConfig = usePaymentConfig();
  const razorpayLive = !!payConfig?.enabled && payConfig.mode !== "demo";
  // "Open UPI app" goes bank to bank without Razorpay, so it's offered with or without Razorpay keys.
  const upiAllowed = useRealUpiAllowed();
  const { ledger, state } = trip;
  const transfers = ledger.transfers;
  const pending = ledger.pendingSettlements;
  const history = state.settlements.filter((s) => s.status !== "initiated").sort((a, b) => (b.confirmedTs ?? b.cancelledTs ?? b.initiatedTs) - (a.confirmedTs ?? a.cancelledTs ?? a.initiatedTs));
  const rows = state.participants
    .map((p) => ({ id: p.id, name: p.name, net: ledger.balances[p.id]?.provisionalNetPaise ?? 0, left: !!p.leftOn }))
    .sort((a, b) => b.net - a.net)
    .map((r) => ({
      id: r.id,
      net: r.net,
      label: (
        <span className="flex items-center gap-1.5">
          <Face name={r.name} size={20} />
          <span className="truncate">
            {trip.short(r.id)}
            {r.left ? " · left" : ""}
          </span>
        </span>
      ),
    }));
  const nonZero = rows.filter((r) => r.net !== 0).length;
  const exact = nonZero <= MAX_EXACT;
  const groups = nonZero - transfers.length;
  const myNet = ledger.balances[trip.meId]?.provisionalNetPaise ?? 0;
  const balanced = ledger.reconciliationPaise === 0;

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      toast(done);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const markPaid = (from: string, to: string, amountPaise: number, reference?: string) =>
    act(`${from}>${to}`, () => trip.run((s, ctx) => initiateSettlement(s, { from, to, amountPaise, method: "upi", reference }, ctx)), `Marked as sent — waiting for ${trip.short(to)} to confirm`);
  /** I'm the one being paid and the money is in my bank: record and confirm in one step. */
  const receivedIt = (from: string, to: string, amountPaise: number) =>
    act(
      `${from}>${to}`,
      () =>
        trip.run((s, ctx) => {
          const sent = initiateSettlement(s, { from, to, amountPaise, method: "upi", reference: "UPI · confirmed by the receiver" }, ctx);
          if (sent.type !== "SETTLEMENT_INITIATED") return [sent];
          const after = { ...s, settlements: [...s.settlements, sent.settlement] };
          return [sent, confirmSettlement(after, sent.settlement.id, { ...ctx, now: (ctx.now ?? Date.now()) + 1 })];
        }),
      `${formatMoney(amountPaise)} from ${trip.short(from)} received · settled`,
    );
  const confirmIt = (s: SettlementData) => act(s.id, () => trip.run((st, ctx) => confirmSettlement(st, s.id, ctx)), `${formatMoney(s.amountPaise)} from ${trip.short(s.from)} confirmed`);
  const cancelIt = async (s: SettlementData) => {
    const ok = await confirm({ title: "Cancel this payment?", message: `${trip.fullName(s.from)} → ${trip.fullName(s.to)} · ${formatMoney(s.amountPaise)}. The balance goes back to unpaid.`, confirm: "Cancel payment", danger: true });
    if (ok) await act(s.id, () => trip.run((st, ctx) => cancelSettlement(st, s.id, ctx, "Cancelled before confirmation")), "Payment cancelled");
  };

  return (
    <section className="flex flex-col px-margin pb-space-sm pt-space-md">
      {/* Settlement hero */}
      <div className="flex flex-col rounded-xl bg-surface-container-lowest p-space-lg shadow-sm">
        <div className="flex items-center justify-between">
          <Eyebrow>Trip settlement</Eyebrow>
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-container px-space-sm py-0.5 font-label-sm text-label-sm text-on-surface-variant">
            <span className={cx("h-1.5 w-1.5 rounded-full", balanced ? "bg-primary" : "bg-error")} />
            {balanced ? "Ledger reconciled" : "Out of balance"}
          </span>
        </div>
        <div className="mt-space-md">
          <h2 className="font-display-lg-mobile text-display-lg-mobile text-on-surface">
            {myNet > 0 ? `You're owed ${formatMoney(myNet)}` : myNet < 0 ? `You owe ${formatMoney(-myNet)}` : "You're settled"}
          </h2>
          <p className="mt-space-xs font-body-md text-body-md leading-relaxed text-on-surface-variant">
            {transfers.length === 0
              ? pending.length
                ? "Nothing more to pay — just confirmations left."
                : "Every balance is at zero. All settled."
              : `${transfers.length} payment${transfers.length === 1 ? "" : "s"} close the trip. Payments already sent count as if they arrived, so nobody pays twice.`}
          </p>
        </div>
        <div className="mt-space-md flex items-center justify-between gap-space-sm rounded-lg bg-surface-container-low/60 px-space-md py-space-sm">
          <div className="flex items-center gap-space-xs font-label-md text-label-md text-primary">
            <Icon name="verified_user" className="text-[18px]" />
            <span>Σ balances = {formatMoney(ledger.reconciliationPaise)}</span>
          </div>
          <span className="text-right font-label-sm text-label-sm text-on-surface-variant">UPI hand-off · no money moves here</span>
        </div>
      </div>

      {/* Smart netting notice */}
      <div className="mt-space-md flex flex-col rounded-xl bg-secondary-fixed/40 p-space-md">
        <div className="flex items-center gap-space-xs">
          <Icon name="auto_mode" className="text-[20px] text-on-secondary-fixed" />
          <span className="font-title-md text-title-md text-on-secondary-fixed">
            {transfers.length} transfer{transfers.length === 1 ? "" : "s"} instead of {ledger.naiveTransferCount}
          </span>
        </div>
        <p className="mt-space-xs font-body-md text-body-md leading-snug text-on-secondary-fixed-variant">
          {nonZero === 0
            ? "Everyone is square."
            : exact
              ? `Without optimisation everyone pays back whoever fronted each bill: ${ledger.naiveTransferCount} pairwise debts. The ${nonZero} people with non-zero balances split into ${groups} independent zero-sum group${groups === 1 ? "" : "s"} (exact search, up to ${MAX_EXACT} people); a group of k needs k − 1 transfers, so ${nonZero} − ${groups} = ${transfers.length} is the minimum possible.`
              : `${nonZero} people have non-zero balances — above ${MAX_EXACT} the planner falls back to largest-debtor → largest-creditor matching, which is not guaranteed minimal.`}
        </p>
      </div>

      {/* Balances */}
      <div className="mt-space-md flex flex-col gap-space-sm rounded-xl bg-surface-container-lowest p-space-md shadow-sm">
        <div className="flex items-center justify-between">
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Current balances</span>
          <span className="font-label-sm text-label-sm text-on-surface-variant">{state.participants.length} members</span>
        </div>
        <BalanceBars rows={rows} />
      </div>

      {/* Awaiting confirmation */}
      {pending.length ? (
        <div className="mt-space-lg flex flex-col">
          <div className="mb-space-sm flex items-center justify-between">
            <h3 className="font-headline-sm text-headline-sm text-on-surface">Awaiting Confirmation</h3>
            <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{pending.length} sent</span>
          </div>
          <div className="flex flex-col gap-space-sm">
            {pending.map((s) => (
              <TransferRow
                key={s.id}
                from={s.from}
                to={s.to}
                amount={s.amountPaise}
                sub={`Marked as paid ${formatRelative(s.initiatedTs)}${s.reference ? ` · ref ${s.reference}` : ""}`}
                footer={
                  <>
                    <span className="flex items-center gap-space-xs font-label-md text-label-md text-secondary">
                      <Icon name="schedule" className="text-[16px]" /> Moves when {trip.short(s.to)} confirms
                    </span>
                    <span className="flex gap-space-sm">
                      <button disabled={busy === s.id} onClick={() => void cancelIt(s)} className="font-label-md text-label-md text-on-surface-variant hover:text-error disabled:opacity-40">
                        Cancel
                      </button>
                      <button
                        disabled={busy === s.id}
                        onClick={() => void confirmIt(s)}
                        className="rounded-full bg-primary-container px-space-md py-1 font-label-md text-label-md text-on-primary disabled:opacity-40"
                      >
                        {trip.isMe(s.to) ? "Confirm received" : `Confirm as ${trip.short(s.to)}`}
                      </button>
                    </span>
                  </>
                }
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* Recommended transfers */}
      <div className="mt-space-lg flex flex-col">
        <div className="mb-space-sm flex items-center justify-between">
          <h3 className="font-headline-sm text-headline-sm text-on-surface">Recommended Transfers</h3>
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{transfers.length} due</span>
        </div>
        {transfers.length === 0 ? (
          <div className="flex items-center gap-space-sm rounded-xl bg-surface-container-low p-space-md font-body-md text-body-md text-on-surface">
            <Icon name="celebration" className="text-primary" /> {pending.length ? "Nothing more to pay — just confirmations left." : "All settled."}
          </div>
        ) : (
          <div className="flex flex-col gap-space-sm">
            {transfers.map((t) => {
              const to = trip.participant(t.to);
              const upi = to?.upiId ? upiIntentUrl({ vpa: to.upiId, name: to.name, amountPaise: t.amountPaise, note: `${trip.state.trip.name} settle-up` }) : null;
              const key = `${t.from}>${t.to}`;
              return (
                <TransferRow
                  key={key}
                  from={t.from}
                  to={t.to}
                  amount={t.amountPaise}
                  sub={to?.upiId ? `Pay to ${to.upiId}` : `${trip.short(t.to)} hasn't added a UPI ID — settle in cash`}
                  footer={
                    <>
                      <span className="flex items-center gap-space-xs font-label-md text-label-md text-error">
                        <Icon name="arrow_forward" className="text-[16px]" /> Due
                      </span>
                      <span className="flex flex-wrap items-center justify-end gap-space-sm">
                        {razorpayLive && trip.isMe(t.from) ? (
                          <button
                            disabled={checkout.busy}
                            onClick={() => void checkout.pay({ purpose: "settle", toId: t.to, amountPaise: t.amountPaise, payee: trip.fullName(t.to), description: `${trip.state.trip.name} · settle up with ${trip.fullName(t.to)}` })}
                            className="flex items-center gap-1 rounded-full bg-primary px-space-md py-1 font-label-md text-label-md text-on-primary disabled:opacity-40"
                          >
                            <Icon name="bolt" className="text-[16px]" /> Pay with Razorpay
                          </button>
                        ) : null}
                        {razorpayLive && trip.isMe(t.to) ? (
                          <button
                            onClick={() => setAsking({ from: t.from, amountPaise: t.amountPaise })}
                            className="flex items-center gap-1 rounded-full bg-primary px-space-md py-1 font-label-md text-label-md text-on-primary"
                          >
                            <Icon name="bolt" className="text-[16px]" /> Request via Razorpay
                          </button>
                        ) : null}
                        {upiAllowed && upi && trip.isMe(t.from) ? (
                          <button
                            onClick={() => setUpiSheet({ from: t.from, to: t.to, amountPaise: t.amountPaise })}
                            className="flex items-center gap-1 rounded-full bg-secondary-fixed px-space-md py-1 font-label-md text-label-md text-on-secondary-fixed"
                          >
                            <Icon name="qr_code_2" className="text-[16px]" /> Pay via UPI QR · real
                          </button>
                        ) : null}
                        {upiAllowed && trip.isMe(t.to) ? (
                          <button
                            onClick={() => setUpiSheet({ from: t.from, to: t.to, amountPaise: t.amountPaise })}
                            className="flex items-center gap-1 rounded-full bg-secondary-fixed px-space-md py-1 font-label-md text-label-md text-on-secondary-fixed"
                          >
                            <Icon name="qr_code_2" className="text-[16px]" /> Show my UPI QR · real
                          </button>
                        ) : null}
                        <button
                          disabled={busy === key}
                          onClick={() => void markPaid(t.from, t.to, t.amountPaise)}
                          className="rounded-full bg-primary-container px-space-md py-1 font-label-md text-label-md text-on-primary disabled:opacity-40"
                        >
                          {trip.isMe(t.from) ? "Paid another way" : `Record ${trip.short(t.from)}'s payment`}
                        </button>
                      </span>
                    </>
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Reconciled transfers (history) */}
      {history.length ? (
        <div className="mt-space-lg flex flex-col">
          <div className="mb-space-sm flex items-center justify-between">
            <h3 className="font-headline-sm text-headline-sm text-on-surface">Reconciled Transfers</h3>
            <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{history.filter((h) => h.status === "confirmed").length} cleared</span>
          </div>
          <div className="flex flex-col gap-space-sm">
            {history.map((s) => (
              <TransferRow
                key={s.id}
                from={s.from}
                to={s.to}
                amount={s.amountPaise}
                muted={s.status === "cancelled"}
                sub={`${s.status === "confirmed" ? "Confirmed" : "Cancelled"} ${formatRelative(s.confirmedTs ?? s.cancelledTs ?? s.initiatedTs)}`}
                footer={
                  <>
                    <span className={cx("flex items-center gap-space-xs font-label-md text-label-md", s.status === "confirmed" ? "text-primary" : "text-outline")}>
                      <Icon name={s.status === "confirmed" ? "check_circle" : "cancel"} className="text-[16px]" />
                      {s.status === "confirmed" ? `Completed via ${s.method === "upi" ? "UPI" : "cash"}` : "Cancelled before confirmation"}
                    </span>
                    {s.reference ? <span className="font-mono text-[11px] text-on-surface-variant">{s.reference}</span> : null}
                  </>
                }
              />
            ))}
          </div>
        </div>
      ) : null}
      {upiSheet ? (
        <Sheet open onClose={() => setUpiSheet(null)} title={trip.isMe(upiSheet.to) ? "Get paid by UPI" : "Pay by UPI"}>
          {trip.isMe(upiSheet.to) ? (
            <ReceiveQr
              vpa={trip.participant(upiSheet.to)?.upiId}
              name={trip.fullName(upiSheet.to)}
              payer={trip.fullName(upiSheet.from)}
              amountPaise={upiSheet.amountPaise}
              note={`${trip.state.trip.name} settle-up`}
              busy={busy === `${upiSheet.from}>${upiSheet.to}`}
              onReceived={async () => {
                await receivedIt(upiSheet.from, upiSheet.to, upiSheet.amountPaise);
                setUpiSheet(null);
              }}
            />
          ) : (
            <UpiPayPanel
              vpa={trip.participant(upiSheet.to)!.upiId!}
              name={trip.fullName(upiSheet.to)}
              amountPaise={upiSheet.amountPaise}
              note={`${trip.state.trip.name} settle-up`.slice(0, 50)}
              busy={busy === `${upiSheet.from}>${upiSheet.to}`}
              confirmLabel="I've paid — mark as sent"
              onConfirm={async (utr) => {
                await markPaid(upiSheet.from, upiSheet.to, upiSheet.amountPaise, utr ? `UPI UTR ${utr}` : "UPI");
                setUpiSheet(null);
              }}
            />
          )}
        </Sheet>
      ) : null}
      {asking ? <RequestSheet open onClose={() => setAsking(null)} purpose="settle" fromId={asking.from} amountPaise={asking.amountPaise} /> : null}
      {checkout.element}
    </section>
  );
}

function TransferRow({ from, to, amount, sub, footer, muted }: { from: string; to: string; amount: number; sub: string; footer: ReactNode; muted?: boolean }) {
  const trip = useTrip();
  return (
    <div className="flex flex-col rounded-xl bg-surface-container-lowest p-space-md shadow-sm transition-all hover:shadow-md">
      <div className="flex items-center justify-between gap-space-sm">
        <div className="flex min-w-0 items-center gap-space-sm">
          <FacePair names={[trip.fullName(from), trip.fullName(to)]} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-title-md text-title-md text-on-surface">
              {trip.short(from)} → {trip.short(to)}
            </span>
            <span className="truncate font-label-sm text-label-sm text-on-surface-variant">{sub}</span>
          </div>
        </div>
        <span className={cx("shrink-0 font-currency-md text-currency-md", muted ? "text-outline line-through" : "text-on-surface")}>{formatMoney(amount)}</span>
      </div>
      <div className="mt-space-sm flex flex-wrap items-center justify-between gap-space-sm">{footer}</div>
    </div>
  );
}

/** My own UPI QR for the exact amount someone owes me — they scan it with any UPI app; real money, bank to bank. */
function ReceiveQr({ vpa, name, payer, amountPaise, note, busy, onReceived }: { vpa?: string; name: string; payer: string; amountPaise: number; note: string; busy: boolean; onReceived: () => void }) {
  // A real payment, bank to bank, like UpiPayPanel.
  const allowed = useRealUpiAllowed();
  const [img, setImg] = useState<string | null>(null);
  const url = vpa ? upiIntentUrl({ vpa, name, amountPaise, note }) : null;
  useEffect(() => {
    if (!url) return;
    let alive = true;
    QRCode.toDataURL(url, { width: 360, margin: 1, errorCorrectionLevel: "M", color: { dark: "#0e1e1b", light: "#ffffff" } })
      .then((d) => alive && setImg(d))
      .catch(() => alive && setImg(null));
    return () => {
      alive = false;
    };
  }, [url]);
  if (!allowed) return null;
  if (!vpa) {
    return <p className="font-body-md text-body-md text-on-surface-variant">Add your UPI ID in Profile first — this QR pays straight into it.</p>;
  }
  return (
    <div className="flex flex-col items-center gap-space-md">
      <p className="flex w-full items-start gap-1.5 rounded-xl bg-secondary-fixed/60 px-space-md py-space-sm font-label-md text-label-md text-on-secondary-fixed">
        <Icon name="info" className="mt-0.5 text-[16px]" /> Real payment: {payer} pays from their own UPI app straight into your bank. GroupTrip never touches the money.
      </p>
      <div className="rounded-2xl bg-surface-container-lowest p-3 shadow-sm ring-1 ring-outline-variant/40">
        {img ? <img src={img} alt={`UPI QR to pay ${name}`} className="h-56 w-56" /> : <div className="flex h-56 w-56 items-center justify-center text-on-surface-variant">Generating QR…</div>}
      </div>
      <div className="text-center">
        <p className="font-headline-md text-headline-md text-on-surface">{formatMoney(amountPaise)}</p>
        <p className="font-label-md text-label-md text-on-surface-variant">
          {payer} → you · {vpa}
        </p>
      </div>
      <p className="text-center font-label-sm text-label-sm text-on-surface-variant">Ask {payer.split(" ")[0]} to scan this with GPay / PhonePe / Paytm. When the money shows up in your bank, tap below — that settles it for everyone.</p>
      <button disabled={busy} onClick={onReceived} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary disabled:opacity-40">
        <Icon name="task_alt" /> {busy ? "Recording…" : `Received ${formatMoney(amountPaise)} — settle it`}
      </button>
    </div>
  );
}
