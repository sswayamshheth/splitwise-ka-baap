"use client";

import { useState } from "react";

import { cx, Icon, inputCls, Sheet, useFeedback } from "@/components/app/kit";
import { useRealUpiAllowed } from "@/components/app/payments/paymentConfig";
import { errorText, useTrip } from "@/lib/client/trip";
import { upiIntentUrl } from "@/lib/ledger/commands";
import { depositToPool, poolSummary, withdrawFromPool } from "@/lib/ledger/pool";
import type { SettlementMethod } from "@/lib/ledger/types";
import { formatMoney } from "@/lib/money";
import { Face, FacePair, paiseOf } from "./parts";

/** Whoever created the trip holds the (simulated) pool for the group. */
export function useOrganiserId(): string | undefined {
  const trip = useTrip();
  const created = trip.events.find((e) => e.type === "TRIP_CREATED");
  const actor = created?.actor;
  return actor && actor !== "system" && trip.participant(actor) ? actor : undefined;
}

export function DepositSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <PoolSheet open={open} onClose={onClose} initial="add" />;
}

export function WithdrawSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <PoolSheet open={open} onClose={onClose} initial="take" />;
}

/**
 * Add to the pool / take unspent money back (Stitch add_or_withdraw). The pool
 * is a simulated escrow: this records the movement in the ledger; any UPI link
 * opens the user's own UPI app.
 */
function PoolSheet({ open, onClose, initial }: { open: boolean; onClose: () => void; initial: "add" | "take" }) {
  const trip = useTrip();
  const { toast } = useFeedback();
  const organiserId = useOrganiserId();
  const pool = poolSummary(trip.state);
  const withMoney = Object.values(pool.members)
    .filter((m) => m.availablePaise > 0)
    .map((m) => m.participantId);
  const active = trip.state.participants.filter((p) => !p.leftOn).map((p) => p.id);
  const [mode, setMode] = useState<"add" | "take">(initial);
  const [who, setWho] = useState<string>(initial === "take" && !withMoney.includes(trip.meId) && withMoney[0] ? withMoney[0] : trip.meId);
  const [picking, setPicking] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<SettlementMethod>("upi");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);

  const paise = paiseOf(amount);
  const person = trip.participant(who);
  const member = pool.members[who];
  const put = member ? member.depositedPaise - member.withdrawnPaise : 0;
  const available = member?.availablePaise ?? 0;
  const organiser = organiserId ? trip.participant(organiserId) : undefined;
  // The "pay in your UPI app" link is a real payment, so it's hidden in demo mode.
  const upiAllowed = useRealUpiAllowed();
  const upi =
    upiAllowed && mode === "add" && method === "upi" && paise && organiser?.upiId && organiserId !== who
      ? upiIntentUrl({ vpa: organiser.upiId, name: organiser.name, amountPaise: paise, note: `${trip.state.trip.name} pool` })
      : null;
  const choices = mode === "take" ? withMoney : active;
  const tooMuch = mode === "take" && !!paise && paise > available;

  const save = async () => {
    if (!paise) return;
    setBusy(true);
    try {
      if (mode === "add") {
        await trip.run((state, ctx) => depositToPool(state, { participantId: who, amountPaise: paise, method, reference }, ctx));
        toast(`${formatMoney(paise)} added to the trip pool`);
      } else {
        await trip.run((state, ctx) => withdrawFromPool(state, { participantId: who, amountPaise: paise, method: "upi" }, ctx));
        toast(`${formatMoney(paise)} taken back from the pool`);
      }
      setAmount("");
      setReference("");
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Add or Withdraw">
      <div className="flex flex-col gap-space-md">
        <div className="flex items-center justify-between gap-space-sm">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-container px-3 py-1 font-label-md text-label-md text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            {trip.state.trip.name} pool
          </span>
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Simulated escrow</span>
        </div>
        <p className="font-body-lg text-body-lg text-on-surface-variant">
          {mode === "add" ? "Top up the shared pool the group pays vendors from." : "Take back money you put in that hasn't been spent on a vendor yet."}
        </p>

        {/* Mode toggle */}
        <div className="grid grid-cols-2 gap-1 rounded-2xl bg-surface-container-high p-1">
          {(
            [
              { m: "add", icon: "add_circle", title: "Add to pool", sub: "Top-up share" },
              { m: "take", icon: "download", title: "Take back", sub: "Unspent available" },
            ] as const
          ).map((o) => (
            <button
              key={o.m}
              onClick={() => {
                setMode(o.m);
                setAmount("");
                if (o.m === "take" && !withMoney.includes(who) && withMoney[0]) setWho(withMoney[0]);
              }}
              className={cx("flex flex-col items-center rounded-xl px-space-sm py-space-sm transition-all", mode === o.m ? "bg-surface-container-lowest shadow-sm" : "hover:bg-surface-container")}
            >
              <span className={cx("flex items-center gap-1 font-title-lg text-title-lg", mode === o.m ? "text-primary" : "text-on-surface")}>
                <Icon name={o.icon} className="text-[20px]" /> {o.title}
              </span>
              <span className={cx("font-label-md text-label-md", mode === o.m ? "text-primary" : "text-on-surface-variant")}>{o.sub}</span>
            </button>
          ))}
        </div>

        {mode === "take" && withMoney.length === 0 ? (
          <div className="rounded-xl bg-surface-container-low p-space-md font-body-md text-body-md text-on-surface-variant">Nobody has unspent money in the pool.</div>
        ) : (
          <>
            {/* Amount card */}
            <div className="relative overflow-hidden rounded-2xl bg-surface-container-lowest p-space-lg shadow-sm">
              <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-primary-fixed/20" />
              <div className="relative flex flex-col items-center gap-space-xs">
                <span className="inline-flex items-center gap-1 rounded-full bg-surface-container px-3 py-1 font-label-sm text-label-sm text-primary">
                  <Icon name={mode === "add" ? "savings" : "lock_open"} className="text-[14px]" />
                  {mode === "add" ? "Deposit amount" : `${formatMoney(available)} unspent available`}
                </span>
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
                {mode === "take" && available > 0 ? (
                  <button onClick={() => setAmount(String(available / 100))} className="font-label-md text-label-md text-primary underline-offset-2 hover:underline">
                    Take back all {formatMoney(available)}
                  </button>
                ) : null}
                {tooMuch ? <span className="font-label-md text-label-md text-error">More than the {formatMoney(available)} left unspent</span> : null}
              </div>
              <div className="relative mt-space-md flex flex-col gap-space-sm rounded-xl bg-surface-container-low p-space-md">
                <div className="flex justify-between font-body-md text-body-md text-on-surface">
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-outline" /> Total contributed
                  </span>
                  <span className="font-semibold">{formatMoney(put)}</span>
                </div>
                <div className="flex justify-between font-body-md text-body-md text-on-surface">
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-outline" /> Spent on vendors
                  </span>
                  <span className="font-semibold">− {formatMoney(member?.spentPaise ?? 0)}</span>
                </div>
                <div className="flex justify-between border-t border-outline-variant/50 pt-space-sm font-title-md text-title-md text-primary">
                  <span>Unspent holding</span>
                  <span>{formatMoney(available)}</span>
                </div>
              </div>
            </div>

            {/* Member row */}
            <div className="rounded-2xl bg-surface-container-lowest p-space-md shadow-sm">
              <div className="flex items-center gap-space-sm">
                {person ? <Face name={person.name} size={44} /> : null}
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1 truncate font-title-md text-title-md text-on-surface">
                    {person?.name}
                    {trip.isMe(who) ? <span className="rounded bg-surface-container px-1.5 font-label-sm text-[10px] font-bold uppercase text-primary">You</span> : null}
                  </p>
                  <p className="truncate font-label-md text-label-md text-on-surface-variant">{person?.upiId ? `UPI · ${person.upiId}` : "No UPI ID on file"}</p>
                </div>
                {choices.length > 1 ? (
                  <button onClick={() => setPicking(!picking)} className="font-title-md text-title-md text-primary">
                    {picking ? "Done" : "Change"}
                  </button>
                ) : null}
              </div>
              {picking ? (
                <div className="mt-space-sm flex flex-wrap gap-space-sm">
                  {choices.map((id) => (
                    <button
                      key={id}
                      onClick={() => {
                        setWho(id);
                        setPicking(false);
                      }}
                      className={cx("flex items-center gap-1 rounded-full px-space-sm py-1 font-label-md text-label-md", id === who ? "bg-primary-container text-on-primary" : "bg-surface-container-low text-on-surface-variant")}
                    >
                      <Face name={trip.fullName(id)} size={18} /> {trip.short(id)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            {mode === "add" ? (
              <div className="flex flex-col gap-space-sm">
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-container-high p-1">
                  {(["upi", "cash"] as const).map((m) => (
                    <button key={m} onClick={() => setMethod(m)} className={cx("flex items-center justify-center gap-1 rounded-lg py-2 font-label-md text-label-md", method === m ? "bg-surface-container-lowest text-primary shadow-sm" : "text-on-surface-variant")}>
                      <Icon name={m === "upi" ? "qr_code_2" : "payments"} className="text-[16px]" /> {m === "upi" ? "UPI" : "Cash"}
                    </button>
                  ))}
                </div>
                {upi ? (
                  <a href={upi} className="flex items-center gap-space-sm rounded-xl bg-surface-container p-space-md font-body-md text-primary">
                    <Icon name="open_in_new" />
                    Pay {formatMoney(paise!)} to {organiser!.name} ({organiser!.upiId}) in your UPI app · real payment
                  </a>
                ) : null}
                <input className={inputCls} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Reference (optional) — UPI transaction ID or a note" />
              </div>
            ) : null}

            <p className="flex items-start gap-space-sm font-label-md text-label-md text-on-surface-variant">
              <Icon name="shield" className="text-[18px]" />
              Simulated escrow: the ledger records this; no bank holds the money in this prototype.{organiser ? ` ${organiser.name} holds the pool for the group.` : ""}
            </p>

            <button
              disabled={!paise || tooMuch || busy}
              onClick={() => void save()}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-lg text-title-lg text-on-primary shadow-md transition-transform active:scale-[0.99] disabled:opacity-40"
            >
              <Icon name={mode === "add" ? "savings" : "bolt"} className="text-[22px]" />
              {busy ? "Saving…" : !paise ? "Enter an amount" : mode === "add" ? `Record ${formatMoney(paise)} deposit` : `Take back ${formatMoney(paise)}`}
            </button>

            <div className="flex items-center gap-space-sm rounded-xl bg-surface-container-lowest p-space-md shadow-sm">
              <FacePair names={active.slice(0, 3).map((id) => trip.fullName(id))} size={28} />
              <span className="flex-1 font-label-md text-label-md text-on-surface-variant">
                {active.length} tripmate{active.length === 1 ? "" : "s"} will see this in the ledger&apos;s activity
              </span>
              <Icon name="info" className="text-[18px] text-on-surface-variant" />
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
