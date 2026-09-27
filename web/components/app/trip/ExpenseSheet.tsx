"use client";

import { useMemo, useState } from "react";

import { Button, Card, Chip, cx, Field, Icon, inputCls, Label, Money, Notice, Pill, Sheet, useFeedback } from "@/components/app/kit";
import { categoryPhoto } from "@/lib/covers";
import { errorText, useTrip } from "@/lib/client/trip";
import { formatDate, isValidIso, todayIso } from "@/lib/dates";
import { previewCancellation, refundableRemaining, refundRecipient } from "@/lib/ledger/commands";
import { shareFormula } from "@/lib/ledger/explain";
import { describePolicy, describeRefundOn, pricingOf } from "@/lib/ledger/policy";
import { buildChangeEvents, simulate, type Change } from "@/lib/ledger/simulate";
import { formatMoney, parseAmount } from "@/lib/money";
import { Portrait } from "./common";

/**
 * One expense in full: who paid, how each share is derived, refunds and
 * drop-outs, the vendor's policy — plus cancelling under that policy or
 * recording a refund. Both actions are previewed through the simulator (the
 * same engine) before anything is written.
 */
export function ExpenseSheet({ expenseId, onClose }: { expenseId: string; onClose: () => void }) {
  const trip = useTrip();
  const c = trip.ledger.byExpenseId[expenseId];
  const [mode, setMode] = useState<"view" | "cancel" | "refund">("view");
  if (!c) return null;
  const e = c.expense;
  const closed = trip.state.trip.status === "closed";
  const people = Object.keys(c.shares);

  return (
    <Sheet open onClose={onClose} title={mode === "cancel" ? "Cancel booking" : mode === "refund" ? "Record a refund" : "Expense"}>
      {mode === "cancel" ? (
        <CancelFlow expenseId={expenseId} onDone={onClose} />
      ) : mode === "refund" ? (
        <RefundFlow expenseId={expenseId} onDone={onClose} />
      ) : (
        <div className="flex flex-col gap-space-md">
          {/* photo hero (booking_detail) */}
          <div className="relative -mx-space-lg -mt-space-sm h-44 overflow-hidden">
            <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${categoryPhoto(e.category, e.id)}")` }} />
            <div className="absolute inset-0 bg-gradient-to-t from-inverse-surface via-inverse-surface/40 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 p-space-lg">
              <span className="flex items-center gap-1.5 font-label-sm text-label-sm uppercase tracking-wider text-primary-fixed">
                <span className={cx("h-1.5 w-1.5 rounded-full", e.status === "cancelled" ? "bg-error" : "bg-primary-fixed")} />
                {e.status === "cancelled" ? "Cancelled booking" : e.fundedFromPool ? "Paid from the trip pool" : "Confirmed expense"}
              </span>
              <h3 className="font-headline-md text-headline-md leading-tight text-surface-container-lowest">{e.title}</h3>
              <span className="flex items-center gap-1 font-body-md text-body-md text-surface-container-low/90">
                <Icon name="calendar_month" className="text-[16px]" />
                {[formatDate(e.date), e.vendor, e.category].filter(Boolean).join(" · ")}
              </span>
            </div>
          </div>

          {/* total */}
          <div className="flex flex-col gap-space-sm rounded-xl bg-surface-container-lowest p-space-md shadow-sm">
            <div className="flex items-start justify-between">
              <div className="flex flex-col">
                <Label>Total</Label>
                <span className="font-currency-display text-currency-display text-on-surface">{formatMoney(c.effectivePaise)}</span>
                {c.effectivePaise !== e.amountPaise ? <span className="font-label-sm text-label-sm text-on-surface-variant">was {formatMoney(e.amountPaise)} before refunds</span> : null}
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="rounded-full bg-primary-fixed/60 px-2 py-0.5 font-label-sm text-label-sm text-on-primary-fixed-variant">{pricingOf(e) === "per-head" ? "Per head" : "One price"}</span>
                <span className="font-label-sm text-label-sm capitalize text-on-surface-variant">{e.splitMode} split</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-1">
              {e.status === "cancelled" ? <Pill tone="coral">Cancelled</Pill> : null}
              {c.refundedPaise > 0 ? <Pill tone="lavender">{formatMoney(c.refundedPaise)} refunded</Pill> : null}
              {e.fundedFromPool ? (
                <Pill tone="teal" icon="savings">
                  Trip pool · held by the organiser
                </Pill>
              ) : null}
            </div>
            <div className="flex flex-col gap-1 border-t border-outline-variant/40 pt-space-sm">
              <Label>Paid by</Label>
              {e.payers.map((p) => (
                <div key={p.participantId} className="flex items-center justify-between">
                  <span className="flex items-center gap-space-xs font-body-md text-body-md">
                    <Portrait name={trip.fullName(p.participantId)} size={24} /> {trip.short(p.participantId)}
                  </span>
                  <Money paise={p.amountPaise} className="text-[15px]" />
                </div>
              ))}
            </div>
          </div>

          {/* how your share is worked out */}
          {c.shares[trip.meId] ? (
            <div className="flex flex-col gap-space-sm rounded-xl bg-surface-container-low p-space-md">
              <span className="flex items-center gap-1.5 font-label-sm text-label-sm uppercase tracking-wider text-primary">
                <Icon name="calculate" className="text-[16px]" /> How your share is worked out
              </span>
              <div className="rounded-lg bg-surface-container-lowest p-space-md">
                <span className="font-title-md text-title-md text-on-surface">{shareFormula(c, trip.meId)}</span>
              </div>
              <span className="flex items-center gap-1.5 font-body-md text-body-md text-on-surface">
                <Icon name="check_circle" className="text-[18px] text-primary" />
                Your share: <span className="font-title-md">{formatMoney(c.shares[trip.meId])}</span>
              </span>
            </div>
          ) : null}

          {/* split rows */}
          <div className="flex flex-col gap-space-sm">
            <div className="flex items-center justify-between">
              <h4 className="font-headline-sm text-headline-sm text-on-surface">Split</h4>
              <span className="rounded-full bg-surface-container px-2 py-0.5 font-label-sm text-label-sm text-on-surface-variant">
                {people.length} {people.length === 1 ? "person" : "people"}
              </span>
            </div>
            {people.length === 0 ? <span className="font-body-md text-body-md text-on-surface-variant">Nobody bears a share.</span> : null}
            <div className="flex flex-col gap-space-xs rounded-xl bg-surface-container-lowest p-space-sm shadow-sm">
              {people.map((pid) => {
                const out = e.withdrawals?.some((w) => w.participantId === pid);
                return (
                  <div key={pid} className="flex items-center gap-space-sm rounded-lg bg-surface-container-low/60 p-space-sm">
                    <Portrait name={trip.fullName(pid)} size={36} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="font-title-md text-[15px] text-on-surface">
                        {trip.fullName(pid)}
                        {trip.isMe(pid) ? <span className="font-body-md text-on-surface-variant"> (You)</span> : null}
                      </span>
                      <span className="font-label-sm text-label-sm text-on-surface-variant">{shareFormula(c, pid)}</span>
                    </div>
                    <div className="flex flex-col items-end gap-0.5">
                      <Money paise={c.shares[pid] ?? 0} className="text-[15px]" />
                      {(c.grossShares[pid] ?? 0) !== (c.shares[pid] ?? 0) ? <span className="font-label-sm text-label-sm text-on-surface-variant line-through">{formatMoney(c.grossShares[pid] ?? 0)}</span> : null}
                      <span className={cx("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase", out ? "bg-secondary-fixed text-on-secondary-fixed" : "bg-primary-container text-on-primary")}>{out ? "Out" : "In"}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {c.refunds.length ? (
            <div className="flex flex-col gap-space-xs rounded-xl bg-tertiary-fixed/60 p-space-md">
              <span className="flex items-center gap-1.5 font-title-md text-title-md text-on-tertiary-fixed">
                <Icon name="replay" className="text-[18px]" /> Refunds
              </span>
              {c.refunds.map((r) => (
                <span key={r.id} className="font-body-md text-body-md text-on-tertiary-fixed">
                  {formatMoney(r.amountPaise)} to {trip.short(r.receivedBy)} · {formatDate(r.date)}
                  {r.reason ? ` · ${r.reason}` : ""}
                </span>
              ))}
              <span className="font-label-sm text-label-sm text-on-tertiary-fixed-variant">A refund lowers the booking&apos;s cost for everyone who bore it; whoever received the cash owes it on.</span>
            </div>
          ) : null}

          {e.withdrawals?.length ? (
            <div className="flex flex-col gap-space-xs rounded-xl bg-secondary-fixed/40 p-space-md">
              <span className="flex items-center gap-1.5 font-title-md text-title-md text-on-secondary-fixed">
                <Icon name="person_remove" className="text-[18px]" /> Dropped out
              </span>
              {e.withdrawals.map((w) => (
                <span key={w.participantId} className="font-body-md text-body-md text-on-secondary-fixed-variant">
                  {trip.short(w.participantId)} on {formatDate(w.date)} · seat {formatMoney(w.seatPaise)}
                  {w.refundPaise ? ` · ${formatMoney(w.refundPaise)} refunded (${w.refundPercent}%)` : ""} · still bears {formatMoney(w.retainedPaise)}
                </span>
              ))}
            </div>
          ) : null}

          {e.cancellationPolicy ? (
            <div className="flex flex-col gap-space-xs rounded-xl bg-surface-container-lowest p-space-md shadow-sm">
              <span className="flex items-center gap-1.5 font-title-md text-title-md text-primary">
                <Icon name="policy" className="text-[18px]" /> Cancellation &amp; refund policy
              </span>
              <span className="font-body-md text-body-md text-on-surface">
                {describePolicy(e.cancellationPolicy)}
                {e.cancellationPolicy.note ? ` — ${e.cancellationPolicy.note}` : ""}
              </span>
              <span className="font-label-sm text-label-sm text-on-surface-variant">Applied by the ledger on the date you cancel; only the refundable part comes back.</span>
            </div>
          ) : null}
          {e.notes ? <p className="font-body-md text-body-md text-on-surface-variant">{e.notes}</p> : null}

          {e.status === "active" && !closed ? (
            <div className="flex flex-col gap-space-sm">
              <Button full variant="secondary" icon="replay" onClick={() => setMode("refund")}>
                Record a refund
              </Button>
              <Button full variant="ghost" icon="event_busy" onClick={() => setMode("cancel")}>
                Cancel this booking
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}

/** Before → after for everyone whose share or balance moves under a change. */
function Impact({ change }: { change: Change }) {
  const trip = useTrip();
  const sim = useMemo(() => simulate(trip.events, [change], { actor: trip.meId }, (id) => trip.fullName(id).split(" ")[0]), [trip, change]);
  if (!sim.ok) {
    return (
      <Notice tone="coral" icon="block" title="Not possible">
        {sim.error}
      </Notice>
    );
  }
  const moved = sim.diff.people.filter((p) => p.deltaPaise !== 0 || p.shareBefore !== p.shareAfter);
  return (
    <Card tone="soft" className="flex flex-col gap-space-xs">
      {sim.diff.affected.map((b) => (
        <span key={b.expenseId} className="font-body-md text-body-md text-on-surface">
          {b.reason}
        </span>
      ))}
      {moved.map((p) => (
        <div key={p.participantId} className="flex items-center justify-between">
          <span className="font-body-md text-body-md">{trip.short(p.participantId)}</span>
          <span className="font-label-md text-label-md tabular-nums">
            {formatMoney(p.netBefore, { signed: true })} → {formatMoney(p.netAfter, { signed: true })}
          </span>
        </div>
      ))}
      <span className="font-label-sm text-label-sm text-on-surface-variant">
        Balances after: Σ {formatMoney(sim.diff.reconciliationAfter)} · settlement {sim.diff.transfersBefore.length} → {sim.diff.transfersAfter.length} payments
      </span>
    </Card>
  );
}

function CancelFlow({ expenseId, onDone }: { expenseId: string; onDone: () => void }) {
  const trip = useTrip();
  const { toast } = useFeedback();
  const [date, setDate] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const expense = trip.state.expenses.find((x) => x.id === expenseId)!;
  const validDate = isValidIso(date);
  const preview = validDate ? previewCancellation(trip.state, expenseId, undefined, date) : null;
  const change = useMemo<Change>(() => ({ kind: "cancel-booking", expenseId, date }), [expenseId, date]);

  async function apply() {
    setBusy(true);
    try {
      await trip.run((state, ctx) => buildChangeEvents(state, change, ctx));
      toast(`Cancelled · ${formatMoney(preview?.recoverablePaise ?? 0)} back, credited to everyone who bore it`);
      onDone();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-space-md">
      <Notice tone="amber" icon="policy" title="The vendor's terms decide what comes back">
        {describePolicy(expense.cancellationPolicy)}. Only the refundable part comes back; the rest is a real loss and stays shared.
      </Notice>
      <Field label="Cancellation date" hint={validDate ? describeRefundOn(expense.cancellationPolicy, date) : "Pick a date"}>
        <input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      {preview ? (
        <div className="grid grid-cols-2 gap-space-sm">
          <Card tone="soft">
            <Label>Recovered</Label>
            <Money paise={preview.recoverablePaise} className="block text-currency-md text-primary" />
            <span className="font-label-sm text-label-sm text-on-surface-variant">
              {preview.refundPercent}% · to {preview.receivedBy ? trip.short(preview.receivedBy) : "—"}
            </span>
          </Card>
          <Card tone="soft">
            <Label>Lost</Label>
            <Money paise={preview.lossPaise} className="block text-currency-md text-error" />
            <span className="font-label-sm text-label-sm text-on-surface-variant">stays split</span>
          </Card>
        </div>
      ) : null}
      {validDate ? <Impact change={change} /> : null}
      <Button full variant="danger" icon="event_busy" disabled={!validDate || busy} onClick={() => void apply()}>
        {busy ? "Cancelling…" : "Cancel under this policy"}
      </Button>
    </div>
  );
}

function RefundFlow({ expenseId, onDone }: { expenseId: string; onDone: () => void }) {
  const trip = useTrip();
  const { toast } = useFeedback();
  const expense = trip.state.expenses.find((x) => x.id === expenseId)!;
  const remaining = refundableRemaining(trip.state, expenseId);
  const [amount, setAmount] = useState("");
  const [receivedBy, setReceivedBy] = useState<string>(refundRecipient(expense) ?? trip.meId);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const parsed = parseAmount(amount);
  const paise = parsed.paise;
  const change = useMemo<Change | null>(
    () => (paise && paise > 0 ? { kind: "record-refund", input: { expenseId, amountPaise: paise, receivedBy, date: todayIso(), reason: reason || undefined } } : null),
    [paise, receivedBy, reason, expenseId],
  );

  async function apply() {
    if (!change) return;
    setBusy(true);
    try {
      await trip.run((state, ctx) => buildChangeEvents(state, change, ctx));
      toast(`Refund recorded · ${formatMoney(paise ?? 0)} credited to the cost-bearers`);
      onDone();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-space-md">
      <Field label="Amount refunded" hint={`Up to ${formatMoney(remaining)} can still be refunded on this expense`} error={amount && parsed.error ? parsed.error : undefined}>
        <input className={inputCls} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="₹" autoFocus />
      </Field>
      <div className="flex flex-col gap-space-xs">
        <Label>Who received the money</Label>
        <div className="flex flex-wrap gap-space-xs">
          {trip.state.participants.map((p) => (
            <Chip key={p.id} selected={receivedBy === p.id} onClick={() => setReceivedBy(p.id)}>
              {trip.short(p.id)}
            </Chip>
          ))}
        </div>
      </div>
      <Field label="Reason (optional)">
        <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. one flight cancelled for weather" maxLength={120} />
      </Field>
      {change ? <Impact change={change} /> : null}
      <Button full icon="replay" disabled={!change || busy} onClick={() => void apply()}>
        {busy ? "Recording…" : "Record refund"}
      </Button>
      <span className="flex items-center gap-1 font-label-sm text-label-sm text-on-surface-variant">
        <Icon name="info" className="text-[14px]" /> Refunds are recorded, not received by the app.
      </span>
    </div>
  );
}
