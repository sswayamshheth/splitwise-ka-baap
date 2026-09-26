"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Chip, cx, Icon, inputCls, Sheet, useFeedback } from "@/components/app/kit";
import { Face } from "@/components/app/money/parts";
import { api } from "@/lib/client/api";
import { errorText, useTrip } from "@/lib/client/trip";
import { formatDate, todayIso } from "@/lib/dates";
import { isValidUpiId, parseUpiIntent, updateItineraryItem } from "@/lib/ledger/commands";
import { bestOfferForMethod, optimisePayment } from "@/lib/ledger/offers";
import { payVendorFromPool, poolPayers, poolSummary } from "@/lib/ledger/pool";
import { EXPENSE_CATEGORIES, type ExpenseCategory, type ItineraryItem, type PaymentMethod } from "@/lib/ledger/types";
import { formatMoney, parseAmount } from "@/lib/money";
import { useCheckout } from "./checkout";
import type { Config } from "./RazorpayPool";
import { UpiPayPanel } from "./UpiQr";

/**
 * "Pay" on the Money tab. Two ways:
 *  1) Pay a vendor from the itinerary — pick the item, the card optimiser
 *     recommends the best card in the group, then checkout (Razorpay test mode,
 *     or the labelled demo checkout). The verified payment books the item.
 *     …or pay the vendor straight from a UPI app: their UPI (from their QR) becomes
 *     a real upi:// request (QR + "Open UPI app"); once paid, it's recorded
 *     against the trip pool.
 *  2) Pay someone else — QR link / UPI ID / phone → the same UPI request →
 *     recorded against the trip pool (the app itself never moves money).
 */

type Step = { kind: "choose" } | { kind: "vendors" } | { kind: "vendor"; itemId: string } | { kind: "someone" } | { kind: "receipt"; receipt: Receipt };
type Receipt = { amountPaise: number; payee: string; via: string; funders: { name: string; amountPaise: number }[] };

export function PaySheet({ open, onClose, onContribute }: { open: boolean; onClose: () => void; onContribute: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const titles: Record<Step["kind"], string> = { choose: "Pay", vendors: "Pay a vendor", vendor: "Pay a vendor", someone: "Pay someone", receipt: "Paid" };
  return (
    <Sheet open={open} onClose={onClose} title={titles[step.kind]}>
      {step.kind !== "choose" && step.kind !== "receipt" ? (
        <button
          onClick={() => setStep(step.kind === "vendor" ? { kind: "vendors" } : { kind: "choose" })}
          className="-mt-2 mb-space-sm flex items-center gap-1 font-label-md text-label-md text-primary hover:underline"
        >
          <Icon name="arrow_back" className="text-[16px]" /> Back
        </button>
      ) : null}
      {step.kind === "choose" ? <Chooser onVendor={() => setStep({ kind: "vendors" })} onSomeone={() => setStep({ kind: "someone" })} /> : null}
      {step.kind === "vendors" ? <VendorList onPick={(itemId) => setStep({ kind: "vendor", itemId })} /> : null}
      {step.kind === "vendor" ? <VendorPay itemId={step.itemId} onPaid={onClose} onContribute={onContribute} /> : null}
      {step.kind === "someone" ? <PaySomeone onContribute={onContribute} onPaid={(receipt) => setStep({ kind: "receipt", receipt })} /> : null}
      {step.kind === "receipt" ? <ReceiptView receipt={step.receipt} onDone={onClose} /> : null}
    </Sheet>
  );
}

function Chooser({ onVendor, onSomeone }: { onVendor: () => void; onSomeone: () => void }) {
  const Option = ({ icon, title, sub, onClick, tone }: { icon: string; title: string; sub: string; onClick: () => void; tone: string }) => (
    <button onClick={onClick} className="flex w-full items-center gap-space-md rounded-2xl bg-surface-container-lowest p-space-md text-left shadow-sm ring-1 ring-outline-variant/40 transition-shadow hover:shadow-md">
      <span className={cx("flex h-12 w-12 shrink-0 items-center justify-center rounded-full", tone)}>
        <Icon name={icon} className="text-[24px]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-title-lg text-title-lg text-on-surface">{title}</span>
        <span className="font-body-md text-body-md text-on-surface-variant">{sub}</span>
      </span>
      <Icon name="chevron_right" className="text-on-surface-variant" />
    </button>
  );
  return (
    <div className="flex flex-col gap-space-sm">
      <Option icon="storefront" tone="bg-primary-fixed/60 text-primary" title="Pay a vendor from the itinerary" sub="Villa, cab, activity… with the best card in the group" onClick={onVendor} />
      <Option icon="qr_code_2" tone="bg-secondary-fixed text-on-secondary-fixed-variant" title="Pay someone else" sub="QR, UPI ID or phone — paid from the trip pool" onClick={onSomeone} />
    </div>
  );
}

// ------------------------------------------------------------------ vendors from the itinerary

function useDue() {
  const trip = useTrip();
  return (item: ItineraryItem) => {
    const b = trip.ledger.budget.byItemId[item.id];
    const committed = item.actualPaise ?? item.estimatedPaise;
    return Math.max(0, committed - (b?.paidPaise ?? 0));
  };
}

function VendorList({ onPick }: { onPick: (itemId: string) => void }) {
  const trip = useTrip();
  const due = useDue();
  const items = trip.state.itinerary
    .filter((i) => i.status !== "cancelled" && (i.vendor || i.estimatedPaise > 0))
    .map((i) => ({ i, due: due(i) }))
    .sort((a, b) => (a.due > 0 ? 0 : 1) - (b.due > 0 ? 0 : 1) || (a.i.date < b.i.date ? -1 : 1));
  if (!items.length) {
    return (
      <p className="rounded-xl bg-surface-container-low p-space-md font-body-md text-body-md text-on-surface-variant">
        No itinerary items to pay yet. Add items in the Plan tab first.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {items.map(({ i, due: d }) => (
        <div key={i.id} className="flex items-center justify-between gap-space-sm rounded-xl bg-surface-container-lowest p-3.5 shadow-sm">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-container text-primary">
              <Icon name="storefront" className="text-[20px]" />
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-title-md text-title-md text-on-surface">{i.title}</span>
              <span className="truncate font-label-sm text-label-sm text-on-surface-variant">
                {i.vendor ?? "Vendor not set"} · {formatDate(i.date)} · {i.participantIds.length} people
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className="font-title-md text-title-md text-on-surface">{d > 0 ? formatMoney(d) : "Paid"}</span>
            {d > 0 ? (
              <button onClick={() => onPick(i.id)} className="rounded-full bg-primary-container px-3 py-1 font-label-md text-label-md text-on-primary hover:bg-primary">
                Pay
              </button>
            ) : (
              <span className="rounded-full bg-primary-fixed/60 px-2 py-0.5 font-label-sm text-label-sm text-on-primary-fixed-variant">Booked</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function VendorPay({ itemId, onPaid, onContribute }: { itemId: string; onPaid: () => void; onContribute: () => void }) {
  const trip = useTrip();
  const due = useDue();
  const checkout = useCheckout();
  const [mode, setMode] = useState<"card" | "upi">("card");
  // The vendor UPI flow opens a real UPI payment, so it is hidden while payments run in demo mode.
  const [upiAllowed, setUpiAllowed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api<Config>("/api/payments/config")
      .then((c) => !cancelled && setUpiAllowed(c.mode !== "demo"))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const item = trip.state.itinerary.find((i) => i.id === itemId);
  const [text, setText] = useState(item ? String(due(item) / 100) : "");
  const parsed = parseAmount(text);
  const amount = parsed.paise ?? 0;
  const myCards = (trip.participant(trip.meId)?.paymentMethods ?? []).filter((m) => m.kind !== "netbanking");
  const input = item ? { amountPaise: amount, category: item.category, vendor: item.vendor } : null;
  const result = useMemo(() => (input && amount > 0 ? optimisePayment(trip.state.participants.filter((p) => !p.leftOn), input) : null), [trip.state.participants, input?.amountPaise, input?.category, input?.vendor]); // eslint-disable-line react-hooks/exhaustive-deps
  const myBest = result?.options.find((o) => o.participantId === trip.meId);
  const [cardId, setCardId] = useState<string | null>(null);
  const chosen: PaymentMethod | undefined = myCards.find((c) => c.id === cardId) ?? myBest?.method ?? myCards[0];
  const chosenSaving = chosen && input ? bestOfferForMethod(chosen, input) : null;

  if (!item) return <p className="font-body-md text-body-md text-on-surface-variant">That item is no longer on the plan.</p>;
  const best = result?.best;

  async function pay() {
    if (!item || amount <= 0) return;
    const res = await checkout.pay({ purpose: "vendor", itemId: item.id, amountPaise: amount, payee: item.vendor ?? item.title, description: `${item.title} · ${trip.state.trip.name}`, methodLabel: chosen?.label });
    if (res.status === "VERIFIED") onPaid();
  }

  return (
    <div className="flex flex-col gap-space-md">
      <div className="rounded-2xl bg-surface-container-lowest p-space-md shadow-sm">
        <p className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{item.vendor ?? "Vendor"}</p>
        <p className="font-headline-sm text-headline-sm text-on-surface">{item.title}</p>
        <p className="font-body-md text-body-md text-on-surface-variant">
          {formatDate(item.date)} · shared by {item.participantIds.length} · due {formatMoney(due(item))}
        </p>
      </div>

      <div className="flex items-center gap-2 rounded-xl bg-surface-container-low px-space-md">
        <span className="font-headline-md text-headline-md text-on-surface-variant">₹</span>
        <input className="h-14 w-full bg-transparent font-headline-md text-headline-md text-on-surface outline-none" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} aria-label="Amount" />
      </div>
      {parsed.error && text ? <p className="-mt-2 font-label-sm text-label-sm text-error">{parsed.error}</p> : null}

      {upiAllowed ? (
      <div className="flex gap-2">
        {(
          [
            ["card", "credit_card", "Card checkout"],
            ["upi", "qr_code_2", "UPI app (vendor's QR)"],
          ] as const
        ).map(([id, icon, label]) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            className={cx("flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 font-label-md text-label-md transition-colors", mode === id ? "bg-primary-container text-on-primary" : "bg-surface-container-low text-on-surface-variant")}
          >
            <Icon name={icon} className="text-[18px]" /> {label}
          </button>
        ))}
      </div>
      ) : null}

      {mode === "upi" && upiAllowed ? (
        <VendorUpi item={item} amountPaise={amount} onPaid={onPaid} onContribute={onContribute} />
      ) : (
      <>
      {/* Card optimiser */}
      <div className="rounded-2xl bg-secondary-fixed/40 p-space-md">
        <div className="flex items-center gap-2">
          <Icon name="credit_card" className="text-[20px] text-on-secondary-fixed" />
          <span className="font-title-md text-title-md text-on-secondary-fixed">Card optimiser</span>
        </div>
        {best && best.discountPaise > 0 ? (
          <div className="mt-2 flex items-center gap-3">
            <Face name={best.participantName} size={36} />
            <p className="font-body-md text-body-md text-on-secondary-fixed-variant">
              Best in the group: <span className="font-semibold text-on-secondary-fixed">{trip.isMe(best.participantId) ? "your" : `${best.participantName.split(" ")[0]}'s`} {best.method.label}</span> saves{" "}
              <span className="font-semibold text-on-secondary-fixed">{formatMoney(best.discountPaise)}</span>
              {best.offer ? ` — ${best.offer.title}` : ""}.
              {!trip.isMe(best.participantId) ? ` Ask ${best.participantName.split(" ")[0]} to pay this one.` : ""}
            </p>
          </div>
        ) : (
          <p className="mt-2 font-body-md text-body-md text-on-secondary-fixed-variant">
            {result && result.options.length ? "No card in the group has an offer for this booking." : "Nobody in the group has added a card yet."}
          </p>
        )}
        <p className="mt-2 font-label-sm text-label-sm text-on-secondary-fixed-variant">Estimate from a curated offer list — not live bank data.</p>
      </div>

      <div>
        <p className="mb-2 font-label-md text-label-md text-on-surface-variant">Pay with</p>
        {myCards.length ? (
          <div className="flex flex-wrap gap-2">
            {myCards.map((c) => {
              const s = input ? bestOfferForMethod(c, input).discountPaise : 0;
              return (
                <Chip key={c.id} selected={chosen?.id === c.id} onClick={() => setCardId(c.id)} icon="credit_card">
                  {c.label}
                  {s > 0 ? ` · saves ${formatMoney(s)}` : ""}
                </Chip>
              );
            })}
          </div>
        ) : (
          <Link href="/profile#cards" className="inline-flex items-center gap-1 font-label-md text-label-md text-primary hover:underline">
            <Icon name="add_card" className="text-[16px]" /> Add your cards in Profile → Cards & accounts (name only)
          </Link>
        )}
      </div>

      <button
        disabled={checkout.busy || amount <= 0}
        onClick={() => void pay()}
        className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary shadow-sm disabled:opacity-40"
      >
        <Icon name="lock" /> {checkout.busy ? "Opening checkout…" : `Pay ${amount > 0 ? formatMoney(amount) : ""}${chosenSaving?.discountPaise ? ` · est. saving ${formatMoney(chosenSaving.discountPaise)}` : ""}`}
      </button>
      <p className="-mt-2 text-center font-label-sm text-label-sm text-on-surface-variant">
        You pay the vendor through checkout; the booking is recorded as paid by you and split among its {item.participantIds.length} members only after the server verifies the payment.
      </p>
      </>
      )}
      {checkout.element}
    </div>
  );
}

/** An item's current fields as a command input, so saving the vendor's UPI changes nothing else. */
function inputOf(item: ItineraryItem) {
  return {
    title: item.title,
    category: item.category,
    date: item.date,
    endDate: item.endDate,
    time: item.time,
    location: item.location,
    vendor: item.vendor,
    vendorUpi: item.vendorUpi,
    vendorUpiName: item.vendorUpiName,
    estimatedPaise: item.estimatedPaise,
    actualPaise: item.actualPaise,
    participantIds: item.participantIds,
    weights: item.weights,
    notes: item.notes,
    cancellationPolicy: item.cancellationPolicy,
    status: item.status,
  };
}

/** Pay the vendor from a UPI app using their UPI ID (captured from their QR), then record it against the pool. */
function VendorUpi({ item, amountPaise, onPaid, onContribute }: { item: ItineraryItem; amountPaise: number; onPaid: () => void; onContribute: () => void }) {
  const trip = useTrip();
  const { toast } = useFeedback();
  const [raw, setRaw] = useState("");
  const [payeeName, setPayeeName] = useState(item.vendorUpiName ?? item.vendor ?? "");
  const [busy, setBusy] = useState(false);
  const fromQr = raw.trim() ? parseUpiIntent(raw) : null;
  const typedVpa = fromQr?.vpa ?? (isValidUpiId(raw) ? raw.trim() : null);
  const pool = poolSummary(trip.state);
  const short = amountPaise > pool.availablePaise;

  async function saveUpi() {
    if (!typedVpa) return;
    setBusy(true);
    try {
      await trip.run((state, ctx) => {
        const current = state.itinerary.find((i) => i.id === item.id) ?? item;
        return updateItineraryItem(state, item.id, { ...inputOf(current), vendorUpi: typedVpa, vendorUpiName: (payeeName.trim() || fromQr?.name) ?? undefined }, ctx);
      });
      toast("Vendor's UPI saved on this booking");
      setRaw("");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function record(utr: string | undefined) {
    setBusy(true);
    try {
      await trip.run((state, ctx) =>
        payVendorFromPool(
          state,
          {
            title: item.title,
            vendor: item.vendor ?? item.vendorUpiName ?? item.vendorUpi,
            amountPaise,
            date: todayIso(),
            category: item.category,
            participants: item.participantIds.map((participantId, i) => ({ participantId, weight: item.weights?.[i] ?? 1 })),
            splitMode: item.weights ? "weighted" : "equal",
            itineraryItemId: item.id,
            cancellationPolicy: item.cancellationPolicy,
            capture: { kind: "manual", reference: utr ? `UPI UTR ${utr} · ${item.vendorUpi}` : `UPI · ${item.vendorUpi}` },
            notes: "Paid via UPI outside the app; recorded in the trip pool (simulated escrow).",
          },
          ctx,
        ),
      );
      toast(`Recorded · ${formatMoney(amountPaise)} to ${item.vendorUpiName ?? item.vendor ?? item.vendorUpi} from the trip pool`);
      onPaid();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  if (!item.vendorUpi) {
    return (
      <div className="flex flex-col gap-space-sm rounded-2xl bg-surface-container-low p-space-md">
        <p className="font-title-md text-title-md text-on-surface">Add the vendor&apos;s UPI</p>
        <p className="font-body-md text-body-md text-on-surface-variant">Every shop, cab and homestay has a UPI QR. Paste the link from it (upi://pay?…) or type their UPI ID. It&apos;s saved on this booking for everyone.</p>
        <input className={inputCls} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="upi://pay?pa=vendor@okaxis&pn=Vendor  or  vendor@okaxis" autoCapitalize="none" />
        {raw.trim() && !typedVpa ? <p className="font-label-sm text-label-sm text-error">That isn&apos;t a UPI QR link or UPI ID (name@bank).</p> : null}
        {fromQr ? <p className="font-label-md text-label-md text-primary">Found {fromQr.name ?? fromQr.vpa} · {fromQr.vpa}</p> : null}
        <input className={inputCls} value={payeeName} onChange={(e) => setPayeeName(e.target.value)} placeholder="Payee name (as shown in the UPI app)" />
        <button disabled={busy || !typedVpa} onClick={() => void saveUpi()} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary disabled:opacity-40">
          <Icon name="save" /> Save vendor UPI
        </button>
      </div>
    );
  }

  if (amountPaise <= 0) return <p className="font-body-md text-body-md text-on-surface-variant">Enter the amount above.</p>;
  return (
    <div className="flex flex-col gap-space-sm">
      <div className={cx("rounded-xl p-space-md font-body-md text-body-md", short ? "bg-error-container text-on-error-container" : "bg-surface-container-low text-on-surface-variant")}>
        Recorded against the trip pool · available <span className="font-semibold">{formatMoney(pool.availablePaise)}</span>
        {short ? (
          <>
            {" "}
            — not enough.{" "}
            <button onClick={onContribute} className="font-semibold underline">
              Contribute to the pool
            </button>{" "}
            first.
          </>
        ) : null}
      </div>
      {!short ? (
        <UpiPayPanel vpa={item.vendorUpi} name={item.vendorUpiName ?? item.vendor ?? "Vendor"} amountPaise={amountPaise} note={`${item.title}`.slice(0, 50)} busy={busy} confirmLabel="Record payment from trip pool" onConfirm={(utr) => void record(utr)} />
      ) : null}
      <p className="text-center font-label-sm text-label-sm text-on-surface-variant">Paid via UPI outside the app; recorded in the trip pool (simulated escrow). GroupTrip never moves the money itself.</p>
    </div>
  );
}

// ------------------------------------------------------------------ pay someone else (from the pool)

function PaySomeone({ onContribute, onPaid }: { onContribute: () => void; onPaid: (r: Receipt) => void }) {
  const trip = useTrip();
  const { toast } = useFeedback();
  const [tab, setTab] = useState<"qr" | "upi" | "phone">("qr");
  const [qr, setQr] = useState("");
  const [upi, setUpi] = useState("");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [category, setCategory] = useState<ExpenseCategory>("Other");
  const active = trip.state.participants.filter((p) => !p.leftOn).map((p) => p.id);
  const [who, setWho] = useState<string[]>(active);
  const [busy, setBusy] = useState(false);
  const [requesting, setRequesting] = useState(false);

  const parsedQr = qr.trim() ? parseUpiIntent(qr) : null;
  const amountFromQr = parsedQr?.amountPaise;
  const parsed = parseAmount(text || (amountFromQr ? String(amountFromQr / 100) : ""));
  const amount = parsed.paise ?? 0;
  const pool = poolSummary(trip.state);
  const short = amount > pool.availablePaise;

  const payee =
    tab === "qr"
      ? parsedQr
        ? (name.trim() || parsedQr.name || parsedQr.vpa)
        : ""
      : tab === "upi"
        ? isValidUpiId(upi)
          ? name.trim() || upi.trim()
          : ""
        : /^[6-9]\d{9}$/.test(phone.replace(/\D/g, "").slice(-10))
          ? name.trim() || `+91 ${phone.replace(/\D/g, "").slice(-10)}`
          : "";
  const handle = tab === "qr" ? parsedQr?.vpa : tab === "upi" ? upi.trim() : `+91 ${phone.replace(/\D/g, "").slice(-10)}`;
  const vpa = tab === "qr" ? parsedQr?.vpa : tab === "upi" && isValidUpiId(upi) ? upi.trim() : undefined;
  const error =
    tab === "qr" && qr.trim() && !parsedQr ? "That isn't a UPI QR link (it should start with upi://pay)" : tab === "upi" && upi && !isValidUpiId(upi) ? "UPI IDs look like name@bank" : tab === "phone" && phone && !payee ? "Enter a 10-digit Indian mobile number" : null;

  async function pay(utr?: string) {
    if (!payee || amount <= 0 || short || who.length === 0) return;
    setBusy(true);
    try {
      const funders = poolPayers(trip.state, amount).map((f) => ({ name: trip.fullName(f.participantId), amountPaise: f.amountPaise }));
      await trip.run((state, ctx) =>
        payVendorFromPool(
          state,
          {
            title: `Paid to ${payee}`,
            vendor: handle,
            amountPaise: amount,
            date: todayIso(),
            category,
            participants: who.map((participantId) => ({ participantId, weight: 1 })),
            splitMode: "equal",
            capture: { kind: "manual", reference: utr ? `UPI UTR ${utr} · ${handle}` : `UPI · ${handle}` },
            notes: `${note.trim() ? `${note.trim()} · ` : ""}Paid via UPI outside the app (${tab === "qr" ? "QR" : tab === "upi" ? "UPI ID" : "phone number"}); recorded in the trip pool (simulated escrow)`,
          },
          ctx,
        ),
      );
      onPaid({ amountPaise: amount, payee, via: handle ?? "", funders });
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  const Tab = ({ id, icon, label }: { id: "qr" | "upi" | "phone"; icon: string; label: string }) => (
    <button
      onClick={() => setTab(id)}
      className={cx("flex flex-1 flex-col items-center gap-1 rounded-xl py-2.5 font-label-md text-label-md transition-colors", tab === id ? "bg-primary-container text-on-primary" : "bg-surface-container-low text-on-surface-variant")}
    >
      <Icon name={icon} className="text-[22px]" />
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-space-md">
      <div className="flex gap-2">
        <Tab id="qr" icon="qr_code_scanner" label="Scan QR" />
        <Tab id="upi" icon="alternate_email" label="UPI ID" />
        <Tab id="phone" icon="call" label="Phone" />
      </div>

      {tab === "qr" ? (
        <div className="flex flex-col gap-2">
          <div className="relative mx-auto flex h-40 w-40 items-center justify-center rounded-2xl bg-inverse-surface/90">
            {["left-2 top-2 border-l-4 border-t-4", "right-2 top-2 border-r-4 border-t-4", "bottom-2 left-2 border-b-4 border-l-4", "bottom-2 right-2 border-b-4 border-r-4"].map((c) => (
              <span key={c} className={cx("absolute h-7 w-7 rounded-sm border-primary-fixed", c)} />
            ))}
            <Icon name="qr_code_2" className="text-[64px] text-inverse-on-surface/70" />
          </div>
          <p className="text-center font-label-sm text-label-sm text-on-surface-variant">Camera scanning comes with the mobile app. Paste the QR's UPI link here:</p>
          <input className={inputCls} value={qr} onChange={(e) => setQr(e.target.value)} placeholder="upi://pay?pa=shop@okaxis&pn=Shop&am=450" autoCapitalize="none" />
          {parsedQr ? (
            <p className="font-label-md text-label-md text-primary">
              <Icon name="check_circle" className="text-[14px]" /> {parsedQr.name ?? parsedQr.vpa} · {parsedQr.vpa}
              {amountFromQr ? ` · ${formatMoney(amountFromQr)}` : ""}
            </p>
          ) : null}
        </div>
      ) : tab === "upi" ? (
        <input className={inputCls} value={upi} onChange={(e) => setUpi(e.target.value)} placeholder="name@bank" autoCapitalize="none" aria-label="UPI ID" />
      ) : (
        <div className="flex gap-2">
          <span className="flex h-12 items-center rounded-xl bg-surface-container px-space-md font-title-md text-on-surface">+91</span>
          <input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" inputMode="tel" aria-label="Phone number" />
        </div>
      )}
      {error ? <p className="-mt-2 font-label-sm text-label-sm text-error">{error}</p> : null}

      <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Payee name (e.g. Ravi, boat guide)" aria-label="Payee name" />

      <div className="flex items-center gap-2 rounded-xl bg-surface-container-low px-space-md">
        <span className="font-headline-md text-headline-md text-on-surface-variant">₹</span>
        <input className="h-14 w-full bg-transparent font-headline-md text-headline-md text-on-surface outline-none" inputMode="decimal" value={text || (amountFromQr ? String(amountFromQr / 100) : "")} onChange={(e) => setText(e.target.value)} placeholder="0" aria-label="Amount" />
      </div>
      <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" maxLength={80} />

      <div className="flex flex-wrap gap-2">
        {EXPENSE_CATEGORIES.map((c) => (
          <Chip key={c} selected={category === c} onClick={() => setCategory(c)}>
            {c}
          </Chip>
        ))}
      </div>
      <div>
        <p className="mb-2 font-label-md text-label-md text-on-surface-variant">Split among ({who.length})</p>
        <div className="flex flex-wrap gap-2">
          {active.map((id) => (
            <Chip key={id} selected={who.includes(id)} onClick={() => setWho(who.includes(id) ? who.filter((x) => x !== id) : [...who, id])}>
              {trip.short(id)}
            </Chip>
          ))}
        </div>
      </div>

      <div className={cx("rounded-xl p-space-md font-body-md text-body-md", short ? "bg-error-container text-on-error-container" : "bg-surface-container-low text-on-surface-variant")}>
        Trip pool available: <span className="font-semibold">{formatMoney(pool.availablePaise)}</span>
        {short ? (
          <>
            {" "}
            — not enough for {formatMoney(amount)}.{" "}
            <button onClick={onContribute} className="font-semibold underline">
              Contribute to the pool
            </button>{" "}
            first.
          </>
        ) : null}
      </div>

      {requesting && payee && amount > 0 && !short ? (
        vpa ? (
          <UpiPayPanel vpa={vpa} name={payee} amountPaise={amount} note={note.trim() || "GroupTrip"} busy={busy} confirmLabel="Record payment from trip pool" onConfirm={(utr) => void pay(utr)} />
        ) : (
          <div className="flex flex-col gap-2 rounded-xl bg-surface-container-low p-space-md">
            <p className="font-body-md text-body-md text-on-surface">Open your UPI app and pay {formatMoney(amount)} to <span className="font-semibold">{handle}</span> (pay to phone number).</p>
            <button disabled={busy} onClick={() => void pay()} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary disabled:opacity-40">
              <Icon name="task_alt" /> I&apos;ve paid — record it
            </button>
          </div>
        )
      ) : (
        <button
          disabled={busy || !payee || amount <= 0 || short || who.length === 0}
          onClick={() => setRequesting(true)}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary shadow-sm disabled:opacity-40"
        >
          <Icon name="qr_code_2" /> {`Pay ${amount > 0 ? formatMoney(amount) : ""} via UPI`}
        </button>
      )}
      <p className="-mt-2 text-center font-label-sm text-label-sm text-on-surface-variant">You pay in your own UPI app; GroupTrip records it against the trip pool (simulated escrow) and splits it among the people you picked.</p>
    </div>
  );
}

function ReceiptView({ receipt, onDone }: { receipt: Receipt; onDone: () => void }) {
  return (
    <div className="flex flex-col items-center gap-space-md text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-fixed/70 text-primary">
        <Icon name="check" className="text-[36px]" />
      </span>
      <p className="font-display-lg-mobile text-display-lg-mobile text-on-surface">{formatMoney(receipt.amountPaise)}</p>
      <p className="font-body-lg text-body-lg text-on-surface">
        to <span className="font-semibold">{receipt.payee}</span>
      </p>
      <p className="font-label-md text-label-md text-on-surface-variant">{receipt.via} · from the trip pool</p>
      <div className="w-full rounded-xl bg-surface-container-low p-space-md text-left">
        <p className="mb-2 font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Funded by deposits of</p>
        {receipt.funders.map((f) => (
          <div key={f.name} className="flex items-center justify-between py-1">
            <span className="flex items-center gap-2 font-body-md text-body-md text-on-surface">
              <Face name={f.name} size={24} /> {f.name}
            </span>
            <span className="font-title-md text-title-md text-on-surface">{formatMoney(f.amountPaise)}</span>
          </div>
        ))}
      </div>
      <p className="font-label-sm text-label-sm text-on-surface-variant">Paid in your UPI app; recorded against the trip pool (simulated escrow). The ledger and everyone's balances are updated.</p>
      <button onClick={onDone} className="flex h-12 w-full items-center justify-center rounded-xl bg-primary-container font-title-md text-title-md text-on-primary">
        Done
      </button>
    </div>
  );
}
