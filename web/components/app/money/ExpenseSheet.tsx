"use client";

import { useMemo, useState } from "react";

import { cx, Field, Icon, inputCls, Notice, Sheet, useFeedback } from "@/components/app/kit";
import { errorText, useTrip } from "@/lib/client/trip";
import { formatDate, todayIso } from "@/lib/dates";
import { addExpense, evenPayers, type ExpenseInput } from "@/lib/ledger/commands";
import { computeExpense } from "@/lib/ledger/engine";
import { optimisePayment } from "@/lib/ledger/offers";
import { payVendorFromPool, poolPayers, poolSummary } from "@/lib/ledger/pool";
import { EXPENSE_CATEGORIES, type ExpenseCategory, type Pricing, type SplitMode } from "@/lib/ledger/types";
import { formatMoney } from "@/lib/money";
import { Face, FacePair, paiseOf } from "./parts";

/**
 * Money going to a vendor (Stitch add_expense → confirm_split). Two sources:
 *  - "pool": paid out of the trip pool; the members whose deposits fund it
 *    are the payers, pro rata to what each still has in the pool.
 *  - "direct": someone paid with their own card/UPI/cash.
 * Either way, shares derive from who is on the booking. The review step shows
 * the exact per-person shares the engine will record.
 */
export function ExpenseSheet({ open, onClose, source }: { open: boolean; onClose: () => void; source: "pool" | "direct" }) {
  const trip = useTrip();
  const { toast } = useFeedback();
  const everyone = trip.state.participants.filter((p) => !p.leftOn).map((p) => p.id);
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [title, setTitle] = useState("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<ExpenseCategory>("Food");
  const [date, setDate] = useState(todayIso());
  const [itemId, setItemId] = useState<string | null>(null);
  const [people, setPeople] = useState<string[]>(everyone);
  const [customize, setCustomize] = useState(false);
  const [split, setSplit] = useState<SplitMode>("equal");
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [pricing, setPricing] = useState<Pricing>("fixed");
  const [refundPct, setRefundPct] = useState("");
  const [payers, setPayers] = useState<string[]>([trip.meId]);
  const [methodId, setMethodId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const paise = paiseOf(amount);
  const planItems = trip.state.itinerary.filter((i) => i.status !== "cancelled" && i.expenseIds.length === 0);
  const pool = poolSummary(trip.state);

  const pickItem = (id: string | null) => {
    setItemId(id);
    const item = id ? trip.state.itinerary.find((i) => i.id === id) : undefined;
    if (!item) return;
    setTitle(item.title);
    setVendor(item.vendor ?? "");
    setAmount(String((item.actualPaise ?? item.estimatedPaise) / 100));
    setCategory(item.category);
    setDate(item.date);
    setPeople(item.participantIds);
    if (item.weights) {
      setSplit("weighted");
      setWeights(Object.fromEntries(item.participantIds.map((pid, i) => [pid, String(item.weights![i])])));
    } else setSplit("equal");
    setPricing(item.category === "Transport" || item.category === "Activity" ? "per-head" : "fixed");
    if (item.cancellationPolicy) setRefundPct(String(item.cancellationPolicy.refundPercent));
  };

  const funding = useMemo(() => {
    if (source !== "pool" || !paise) return null;
    try {
      return { payers: poolPayers(trip.state, paise) };
    } catch (e) {
      return { error: errorText(e) };
    }
  }, [source, paise, trip.state]);

  const optimiser = useMemo(() => {
    if (source !== "direct" || !paise) return null;
    return optimisePayment(trip.state.participants, { amountPaise: paise, category, vendor: vendor || undefined });
  }, [source, paise, category, vendor, trip.state.participants]);

  const input = (): Omit<ExpenseInput, "payers"> | null => {
    if (!paise || !title.trim() || people.length === 0) return null;
    const pct = refundPct.trim() === "" ? undefined : Number(refundPct);
    return {
      title: title.trim(),
      vendor: vendor.trim() || undefined,
      amountPaise: paise,
      date,
      category,
      participants: people.map((pid) => ({ participantId: pid, weight: split === "weighted" ? Math.max(0, Number(weights[pid] ?? "1") || 0) : 1 })),
      splitMode: split,
      pricing,
      itineraryItemId: itemId ?? undefined,
      cancellationPolicy: pct !== undefined && Number.isFinite(pct) ? { refundPercent: pct } : undefined,
    };
  };

  const base = input();
  const payerRows = source === "pool" ? (funding && !("error" in funding) ? funding.payers! : []) : base ? evenPayers(base.amountPaise, payers) : [];
  // Exactly the shares the engine will derive once saved.
  const preview = base ? computeExpense({ ...base, id: "preview", payers: payerRows, status: "active" }, []) : null;

  const save = async () => {
    if (!base) return;
    setBusy(true);
    try {
      if (source === "pool") {
        await trip.run((state, ctx) => payVendorFromPool(state, base, ctx));
        toast(`${formatMoney(base.amountPaise)} paid to ${base.vendor ?? "the vendor"} from the pool`);
      } else {
        await trip.run((state, ctx) => addExpense(state, { ...base, payers: evenPayers(base.amountPaise, payers), paymentMethodId: methodId }, ctx));
        toast(`${base.title} recorded`);
      }
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const ready = !!base && (source === "pool" ? !!funding && !("error" in funding) : payers.length > 0);
  const best = optimiser?.best;
  const heading = source === "pool" ? "Pay from the Pool" : "Add Expense";

  if (step === "review" && base && preview) {
    const shares = Object.entries(preview.shares).filter(([, v]) => v > 0);
    const reconciled = shares.reduce((s, [, v]) => s + v, 0) === base.amountPaise;
    return (
      <Sheet open={open} onClose={onClose} title="Expense Breakdown">
        <div className="flex flex-col gap-space-md">
          <button onClick={() => setStep("edit")} className="flex items-center gap-1 self-start font-label-md text-label-md text-primary">
            <Icon name="arrow_back" className="text-[16px]" /> Edit details
          </button>

          <div className="rounded-2xl bg-surface-container-lowest p-space-lg shadow-sm">
            <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Merchant &amp; category</span>
            <h3 className="mt-1 font-headline-md text-headline-md text-on-surface">{base.vendor ?? base.title}</h3>
            <p className="flex items-center gap-1 font-body-md text-body-md text-on-surface-variant">
              <Icon name="schedule" className="text-[16px]" /> {formatDate(base.date)} · {base.category}
              {base.vendor ? ` · ${base.title}` : ""}
            </p>
            <div className="mt-space-md flex items-end justify-between border-t border-outline-variant/40 pt-space-md">
              <div>
                <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{source === "pool" ? "Funded from the pool by" : "Paid by"}</span>
                <div className="mt-1 flex items-center gap-2">
                  <FacePair names={payerRows.map((p) => trip.fullName(p.participantId))} size={28} />
                  <span className="font-title-md text-title-md text-on-surface">{payerRows.map((p) => trip.short(p.participantId)).join(", ")}</span>
                </div>
              </div>
              <div className="text-right">
                <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Total billed</span>
                <p className="font-display-lg-mobile text-display-lg-mobile text-on-surface">{formatMoney(base.amountPaise)}</p>
              </div>
            </div>
          </div>

          <div className="flex items-end justify-between">
            <div>
              <h4 className="font-headline-sm text-headline-sm text-on-surface">Member Balance Summary</h4>
              <p className="font-label-sm text-label-sm text-on-surface-variant">
                {shares.length} participant{shares.length === 1 ? "" : "s"} · {base.splitMode === "weighted" ? "weighted split" : "equal split"} · {base.pricing === "per-head" ? "per head" : "one price"}
              </p>
            </div>
            <span className={cx("flex items-center gap-1 font-label-md text-label-md", reconciled ? "text-primary" : "text-error")}>
              <Icon name={reconciled ? "verified" : "error"} className="text-[16px]" /> {reconciled ? `Reconciled ${formatMoney(base.amountPaise)}` : "Doesn't add up"}
            </span>
          </div>
          <div className="divide-y divide-outline-variant/40 rounded-2xl bg-surface-container-lowest shadow-sm">
            {shares.map(([pid, share]) => {
              const paid = payerRows.find((p) => p.participantId === pid)?.amountPaise ?? 0;
              return (
                <div key={pid} className="flex items-center gap-space-sm px-space-md py-space-sm">
                  <Face name={trip.fullName(pid)} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1 font-title-md text-title-md text-on-surface">
                      {trip.fullName(pid)}
                      {trip.isMe(pid) ? <span className="rounded bg-surface-container px-1.5 font-label-sm text-[10px] font-bold uppercase text-primary">You</span> : null}
                    </p>
                    <p className="font-label-sm text-label-sm text-on-surface-variant">{paid ? `${source === "pool" ? "Funds" : "Pays"} ${formatMoney(paid)} of the bill` : "Share only"}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-currency-md text-currency-md text-on-surface">{formatMoney(share)}</p>
                    <p className="font-label-sm text-label-sm text-on-surface-variant">share</p>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex gap-space-sm rounded-2xl bg-surface-container p-space-md">
            <Icon name="eco" className="text-[22px] text-primary" />
            <p className="font-body-md text-body-md text-on-surface">
              Shares always add up to the bill to the paisa (largest-remainder allocation). If the booking changes later, everyone&apos;s share is re-derived from who is on it.
            </p>
          </div>

          <button
            disabled={!ready || busy}
            onClick={() => void save()}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-lg text-title-lg text-on-primary shadow-md disabled:opacity-40"
          >
            {busy ? "Saving…" : source === "pool" ? `Pay ${formatMoney(base.amountPaise)} from the pool` : "Save expense"}
            <Icon name="check" className="text-[20px]" />
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title={heading}>
      <div className="flex flex-col gap-space-md">
        <p className="flex items-center gap-1.5 font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">
          <span className="h-1.5 w-1.5 rounded-full bg-secondary-container" />
          {trip.state.trip.name} · {source === "pool" ? `pool · ${formatMoney(pool.availablePaise)} available` : "paid directly"}
        </p>

        {/* Capture modes: only typing exists today */}
        <div className="grid grid-cols-3 gap-1 rounded-full bg-surface-container-high p-1">
          {[
            { k: "snap", icon: "photo_camera", label: "Snap" },
            { k: "say", icon: "mic", label: "Say" },
            { k: "type", icon: "edit_note", label: "Type" },
          ].map((m) => (
            <span
              key={m.k}
              title={m.k === "type" ? undefined : "Coming soon"}
              className={cx(
                "flex items-center justify-center gap-1 rounded-full py-2 font-title-md text-title-md",
                m.k === "type" ? "bg-primary-container text-on-primary shadow-sm" : "cursor-not-allowed text-on-surface-variant/50",
              )}
            >
              <Icon name={m.icon} className="text-[18px]" />
              {m.label}
              {m.k === "type" ? null : <span className="font-label-sm text-[9px] uppercase">soon</span>}
            </span>
          ))}
        </div>

        {/* Big amount */}
        <div className="rounded-2xl bg-surface-container-low p-space-lg text-center">
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Amount</span>
          <div className="flex items-baseline justify-center">
            <span className="font-headline-lg text-headline-lg text-on-surface-variant">₹</span>
            <input
              aria-label="Amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className="w-48 bg-transparent text-center font-display-lg-mobile text-display-lg-mobile text-on-surface outline-none"
            />
          </div>
          <input
            className="mt-space-sm w-full bg-transparent text-center font-headline-sm text-headline-sm italic text-on-surface outline-none placeholder:text-on-surface-variant/50"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What was it for?"
            maxLength={80}
          />
        </div>

        {planItems.length ? (
          <Field label="For a plan item (optional)">
            <div className="flex flex-wrap gap-space-sm">
              {planItems.map((i) => (
                <button
                  key={i.id}
                  onClick={() => pickItem(itemId === i.id ? null : i.id)}
                  className={cx("rounded-full px-space-md py-space-xs font-label-md text-label-md", itemId === i.id ? "bg-primary-container text-on-primary" : "bg-surface-container-low text-on-surface-variant")}
                >
                  {i.title.split(" · ")[0]} · est. {formatMoney(i.estimatedPaise)}
                </button>
              ))}
            </div>
          </Field>
        ) : null}

        <div className="grid grid-cols-2 gap-space-sm">
          <Field label="Vendor">
            <input className={inputCls} value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="optional" />
          </Field>
          <Field label="Date">
            <input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-space-xs">
          {EXPENSE_CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={cx("rounded-full px-space-md py-space-xs font-label-md text-label-md", category === c ? "bg-primary-container text-on-primary" : "bg-surface-container-low text-on-surface-variant")}
            >
              {c}
            </button>
          ))}
        </div>

        {source === "direct" ? (
          <div className="rounded-2xl bg-surface-container-lowest p-space-md shadow-sm">
            <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Who paid{payers.length > 1 ? " (split evenly between payers)" : ""}</span>
            <div className="mt-space-sm flex flex-wrap gap-space-sm">
              {everyone.map((id) => (
                <button
                  key={id}
                  onClick={() => setPayers(payers.includes(id) ? payers.filter((x) => x !== id) : [...payers, id])}
                  className={cx("flex items-center gap-1 rounded-full py-1 pl-1 pr-space-sm font-label-md text-label-md", payers.includes(id) ? "bg-primary-container text-on-primary" : "bg-surface-container-low text-on-surface-variant")}
                >
                  <Face name={trip.fullName(id)} size={22} /> {trip.short(id)}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* Splitting with */}
        <div className="rounded-2xl bg-surface-container-lowest p-space-md shadow-sm">
          <div className="flex items-center gap-space-sm">
            <FacePair names={people.slice(0, 4).map((id) => trip.fullName(id))} size={30} />
            {people.length > 4 ? <span className="font-label-md text-label-md text-on-surface-variant">+{people.length - 4}</span> : null}
            <span className="flex-1 font-title-md text-title-md text-on-surface">
              {people.length === everyone.length ? `Splitting with all ${people.length}` : `Splitting with ${people.length}`}
            </span>
            <button onClick={() => setCustomize(!customize)} className="font-title-md text-title-md text-primary">
              {customize ? "Done" : "Customize"}
            </button>
          </div>
          {customize ? (
            <div className="mt-space-md flex flex-col gap-space-md">
              <div className="flex flex-wrap gap-space-sm">
                <button
                  onClick={() => setPeople(people.length === everyone.length ? [] : everyone)}
                  className={cx("rounded-full px-space-md py-1 font-label-md text-label-md", people.length === everyone.length ? "bg-primary-container text-on-primary" : "bg-surface-container-low text-on-surface-variant")}
                >
                  Everyone
                </button>
                {everyone.map((id) => (
                  <button
                    key={id}
                    onClick={() => setPeople(people.includes(id) ? people.filter((x) => x !== id) : [...people, id])}
                    className={cx("flex items-center gap-1 rounded-full py-1 pl-1 pr-space-sm font-label-md text-label-md", people.includes(id) ? "bg-primary-container text-on-primary" : "bg-surface-container-low text-on-surface-variant")}
                  >
                    <Face name={trip.fullName(id)} size={22} /> {trip.short(id)}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-container-high p-1">
                {(["equal", "weighted"] as const).map((m) => (
                  <button key={m} onClick={() => setSplit(m)} className={cx("rounded-lg py-2 font-label-md text-label-md", split === m ? "bg-surface-container-lowest text-primary shadow-sm" : "text-on-surface-variant")}>
                    {m === "equal" ? "Equal" : "Weighted (rooms, beds…)"}
                  </button>
                ))}
              </div>
              {split === "weighted"
                ? people.map((pid) => (
                    <div key={pid} className="flex items-center gap-space-sm">
                      <Face name={trip.fullName(pid)} size={28} />
                      <span className="flex-1 font-body-md text-on-surface">{trip.short(pid)}</span>
                      <input
                        className={`${inputCls} h-10 w-20 text-center`}
                        inputMode="numeric"
                        value={weights[pid] ?? "1"}
                        onChange={(e) => setWeights({ ...weights, [pid]: e.target.value.replace(/[^0-9.]/g, "") })}
                        aria-label={`${trip.short(pid)} weight`}
                      />
                    </div>
                  ))
                : null}
              <div className="grid grid-cols-2 gap-space-sm">
                <Field label="Pricing" hint={pricing === "per-head" ? "each person is a seat" : "one price for the group"}>
                  <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-container-high p-1">
                    {(["fixed", "per-head"] as const).map((pr) => (
                      <button key={pr} onClick={() => setPricing(pr)} className={cx("rounded-lg py-2 font-label-md text-label-md", pricing === pr ? "bg-surface-container-lowest text-primary shadow-sm" : "text-on-surface-variant")}>
                        {pr === "fixed" ? "Fixed" : "Per head"}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="Refundable if cancelled" hint="vendor policy, %">
                  <input className={inputCls} inputMode="numeric" value={refundPct} onChange={(e) => setRefundPct(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))} placeholder="none" />
                </Field>
              </div>
            </div>
          ) : null}
        </div>

        {source === "pool" && funding ? (
          "error" in funding ? (
            <Notice tone="coral" icon="block">
              {funding.error}
            </Notice>
          ) : (
            <Notice icon="account_balance">
              Funded from the pool by {funding.payers!.map((p) => `${trip.short(p.participantId)} ${formatMoney(p.amountPaise)}`).join(" · ")} — in proportion to what each still has in it.
            </Notice>
          )
        ) : null}

        {source === "direct" && best && best.discountPaise > 0 ? (
          <div className="flex flex-col gap-1 rounded-2xl bg-secondary-fixed/40 p-space-md">
            <span className="flex items-center gap-1 font-title-md text-title-md text-on-secondary-fixed">
              <Icon name="credit_card" /> Best card: {trip.short(best.participantId)}&apos;s {best.method.label}
            </span>
            <span className="font-body-md text-body-md text-on-secondary-fixed-variant">
              Saves about {formatMoney(best.discountPaise)}
              {best.offer ? ` — ${best.offer.title} (${best.offer.terms})` : ""}. Estimate from a curated offer list, not a live bank feed.
            </span>
            <button
              onClick={() => {
                setPayers([best.participantId]);
                setMethodId(best.method.id);
              }}
              className="mt-1 self-start rounded-full bg-surface-container-lowest px-space-md py-1 font-label-md text-label-md text-on-secondary-fixed"
            >
              Pay with this card
            </button>
          </div>
        ) : null}

        <button
          disabled={!ready}
          onClick={() => setStep("review")}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-lg text-title-lg text-on-primary shadow-md disabled:opacity-40"
        >
          Review split <Icon name="arrow_forward" className="text-[20px]" />
        </button>
        <p className="flex items-center justify-center gap-1 font-label-md text-label-md text-on-surface-variant">
          <Icon name="lock" className="text-[14px]" /> Written to the trip ledger only after you confirm
        </p>
      </div>
    </Sheet>
  );
}
