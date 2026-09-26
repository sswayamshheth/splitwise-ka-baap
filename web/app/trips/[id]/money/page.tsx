"use client";

import Link from "next/link";
import { useState } from "react";

import { cx, Icon } from "@/components/app/kit";
import { ExpenseSheet } from "@/components/app/money/ExpenseSheet";
import { DepositSheet, useOrganiserId, WithdrawSheet } from "@/components/app/money/PoolSheets";
import { SettleSection } from "@/components/app/money/SettleSection";
import { PaySheet } from "@/components/app/payments/PaySheet";
import { ContributeSheet, PoolFundingBar, PoolPayments, TargetSheet, usePool } from "@/components/app/payments/RazorpayPool";
import { Eyebrow, Face } from "@/components/app/money/parts";
import { useTrip } from "@/lib/client/trip";
import { formatDate } from "@/lib/dates";
import { poolSummary } from "@/lib/ledger/pool";
import { formatMoney } from "@/lib/money";

/**
 * Money, in the Stitch money_pool layout: the trip pool (a simulated escrow
 * tracked by the ledger), my share of it, member holdings, vendor payments
 * made from it, payments people made themselves, and settling up. Every
 * figure is derived from the trip's event log.
 */
export default function MoneyPage() {
  const trip = useTrip();
  const [sheet, setSheet] = useState<null | "deposit" | "withdraw" | "direct" | "contribute" | "target" | "pay">(null);
  const { pool: serverPool, config: payConfig, reload: reloadPool } = usePool();
  const pool = poolSummary(trip.state);
  const organiserId = useOrganiserId();
  const members = Object.values(pool.members)
    .filter((m) => trip.participant(m.participantId))
    .sort((a, b) => (trip.isMe(a.participantId) ? -1 : trip.isMe(b.participantId) ? 1 : b.depositedPaise - a.depositedPaise));
  const me = trip.ledger.balances[trip.meId];
  const mine = pool.members[trip.meId];
  const closed = trip.state.trip.status === "closed";
  const netIn = pool.depositedPaise - pool.withdrawnPaise;
  const myIn = mine ? mine.depositedPaise - mine.withdrawnPaise : 0;
  const myShare = netIn > 0 ? (myIn / netIn) * 100 : 0;
  const myUsed = myIn > 0 ? Math.min(100, ((mine?.spentPaise ?? 0) / myIn) * 100) : 0;
  const balanced = trip.ledger.reconciliationPaise === 0;
  const activeCount = trip.state.participants.filter((p) => !p.leftOn).length;
  const net = me?.netPaise ?? 0;
  const t = trip.state.trip;

  return (
    <main className="mx-auto flex w-full max-w-[520px] flex-1 flex-col pb-32">
      {/* Editorial headline */}
      <section className="px-margin pb-space-sm pt-space-xs">
        <div className="flex items-center justify-between">
          <div>
            <Eyebrow className="mb-0.5">Trip pool · simulated escrow</Eyebrow>
            <h2 className="font-headline-md text-headline-md tracking-tight text-on-surface">Trip Pool</h2>
          </div>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-container-high text-primary">
            <Icon name="lock" className="text-[20px]" />
          </div>
        </div>
        <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
          {t.name} · {t.destination.split(",")[0]} · {activeCount} member{activeCount === 1 ? "" : "s"}
        </p>
      </section>

      {/* Total in the pool */}
      <section className="px-margin py-space-sm">
        <div className="relative overflow-hidden rounded-2xl bg-surface-container-lowest p-space-lg shadow-sm">
          <div className="pointer-events-none absolute -right-8 -top-8 h-36 w-36 rounded-full bg-primary-fixed/20 blur-2xl" />
          <div className="mb-space-sm flex items-center justify-between">
            <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Available in the pool</span>
            <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-label-sm text-label-sm", balanced ? "bg-surface-container text-primary" : "bg-error-container text-on-error-container")}>
              <Icon name={balanced ? "verified" : "error"} className="text-[14px]" />
              {balanced ? "Ledger balanced ✓" : "Ledger out of balance"}
            </span>
          </div>
          <div className="my-2 flex items-baseline gap-1.5">
            <span className="font-headline-lg text-headline-lg tracking-tight text-on-surface">{formatMoney(pool.availablePaise)}</span>
            <span className="font-label-sm text-label-sm font-medium text-on-surface-variant">INR</span>
          </div>
          <div className="grid grid-cols-2 gap-2 font-label-md text-label-md text-on-surface-variant">
            <span>Put in: {formatMoney(netIn)}</span>
            <span className="text-right">Paid to vendors: {formatMoney(pool.spentPaise)}</span>
          </div>
          <div className="mt-4 flex items-center justify-between gap-space-sm rounded-xl bg-surface-container-low px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <Icon name="shield" className="text-[18px] text-primary" />
              <span className="font-label-md text-label-md text-on-surface">Held by {organiserId ? trip.short(organiserId) : "the organiser"}</span>
            </div>
            <span className="text-right font-label-sm text-label-sm text-on-surface-variant">Prototype · no bank holds it</span>
          </div>
          <PoolFundingBar pool={serverPool} onSetTarget={trip.role === "owner" && !closed ? () => setSheet("target") : undefined} />
        </div>
      </section>

      {/* My share of the pool */}
      <section className="px-margin py-space-sm">
        <div className="rounded-2xl bg-surface-container-lowest p-space-md shadow-sm">
          <div className="flex items-center justify-between pb-space-sm">
            <div className="flex items-center gap-space-sm">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Icon name="account_balance_wallet" className="text-[18px]" />
              </div>
              <div>
                <h3 className="font-title-md text-title-md text-on-surface">Your Pool Share</h3>
                <p className="font-label-sm text-label-sm text-on-surface-variant">
                  {trip.fullName(trip.meId)} · {myShare.toFixed(1)}% of deposits
                </p>
              </div>
            </div>

          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 pt-2">
            <div className="flex flex-col justify-between rounded-xl bg-surface-container-low p-3">
              <span className="font-label-sm text-label-sm text-on-surface-variant">Added</span>
              <p className="mt-1 font-title-md text-title-md text-on-surface">{formatMoney(myIn)}</p>
            </div>
            <div className="flex flex-col justify-between rounded-xl bg-surface-container-low p-3">
              <span className="font-label-sm text-label-sm text-on-surface-variant">Committed</span>
              <p className="mt-1 font-title-md text-title-md text-on-surface">{formatMoney(mine?.spentPaise ?? 0)}</p>
            </div>
            <div className="flex flex-col justify-between rounded-xl bg-surface-container p-3">
              <span className="font-label-sm text-label-sm font-semibold text-primary">Available</span>
              <p className="mt-1 font-title-md text-title-md font-bold text-primary">{formatMoney(mine?.availablePaise ?? 0)}</p>
            </div>
          </div>
          <div className="mt-4">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-label-sm text-label-sm text-on-surface-variant">Spent on vendors from your deposits</span>
              <span className="font-label-sm text-label-sm font-medium text-on-surface">{myUsed.toFixed(1)}% utilized</span>
            </div>
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-container">
              <div className="h-full rounded-full bg-primary-container transition-all duration-500" style={{ width: `${myUsed}%` }} />
              {myIn > 0 ? <div className="h-full rounded-full bg-secondary-container transition-all duration-500" style={{ width: `${100 - myUsed}%` }} /> : null}
            </div>
          </div>
          <div className="mt-4 flex items-center justify-end pt-3">
            <button
              disabled={closed || !(mine?.availablePaise ?? 0)}
              onClick={() => setSheet("withdraw")}
              className="inline-flex items-center gap-1 font-label-md text-label-md font-semibold text-primary hover:underline disabled:opacity-40"
            >
              Withdraw unspent
              <Icon name="chevron_right" className="text-[16px]" />
            </button>
          </div>
        </div>
      </section>

      {/* Quick actions */}
      <section className="flex gap-space-sm px-margin py-space-sm">
        <button
          disabled={closed}
          onClick={() => setSheet("pay")}
          className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary shadow-sm transition-transform active:scale-[0.98] disabled:opacity-40"
        >
          <Icon name="payments" className="text-[20px]" />
          Pay
        </button>
        <button
          disabled={closed}
          onClick={() => setSheet("contribute")}
          className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-surface-container font-title-md text-title-md text-on-surface transition-transform active:scale-[0.98] disabled:opacity-40"
        >
          <Icon name="add_circle" className="text-[20px]" />
          Contribute
        </button>
      </section>

      {!closed ? (
        <div className="px-margin">
          <button onClick={() => setSheet("deposit")} className="font-label-md text-label-md text-primary hover:underline">
            Paid in cash or UPI outside the app? Record it manually
          </button>
        </div>
      ) : null}

      <PoolPayments pool={serverPool} onChanged={() => void reloadPool()} />

      {/* Member holdings */}
      <section className="px-margin pb-space-sm pt-space-md">
        <div className="mb-space-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="font-headline-sm text-headline-sm text-on-surface">Member Holdings</h3>
            <span className="rounded-full bg-surface-container-high px-2 py-0.5 font-label-sm text-label-sm text-on-surface-variant">{members.length}</span>
          </div>

        </div>
        <div className="flex flex-col gap-2.5">
          {members.map((m) => {
            const put = m.depositedPaise - m.withdrawnPaise;
            const used = put > 0 ? Math.min(100, (m.spentPaise / put) * 100) : 0;
            const p = trip.participant(m.participantId)!;
            return (
              <div key={m.participantId} className="rounded-xl bg-surface-container-lowest p-space-md shadow-sm">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <Face name={p.name} size={40} />
                      {m.participantId === organiserId ? (
                        <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary font-label-sm text-[9px] font-bold text-on-primary" title="Holds the pool">
                          ★
                        </span>
                      ) : null}
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-title-md text-title-md text-on-surface">{p.name}</span>
                        {trip.isMe(m.participantId) ? <span className="rounded bg-surface-container px-1.5 font-label-sm text-[10px] font-bold uppercase text-primary">You</span> : null}
                        {p.leftOn ? <span className="rounded bg-error-container px-1.5 font-label-sm text-[10px] font-bold uppercase text-on-error-container">Left</span> : null}
                      </div>
                      <p className="font-label-sm text-label-sm text-on-surface-variant">{put > 0 ? `Deposited ${formatMoney(put)}` : "No deposit yet"}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="font-label-sm text-label-sm text-on-surface-variant">Available</span>
                    <p className="font-currency-md text-currency-md text-on-surface">{formatMoney(m.availablePaise)}</p>
                  </div>
                </div>
                <div className="mb-1 flex justify-between font-label-sm text-label-sm text-on-surface-variant">
                  <span>Committed: {formatMoney(m.spentPaise)}</span>
                  <span>Available: {formatMoney(m.availablePaise)}</span>
                </div>
                <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-container">
                  <div className="h-full bg-primary-container" style={{ width: `${used}%` }} />
                  {put > 0 ? <div className="h-full bg-secondary-container" style={{ width: `${100 - used}%` }} /> : null}
                </div>
              </div>
            );
          })}
          {pool.depositedPaise === 0 ? (
            <p className="rounded-xl bg-surface-container-low p-space-md font-body-md text-body-md text-on-surface-variant">
              Nobody has added money yet. Pooling lets the group pay vendors once, from one place.
            </p>
          ) : null}
        </div>
      </section>

      {/* Vendor payments from the pool */}
      {pool.vendorPayments.length ? (
        <section className="px-margin pb-space-sm pt-space-md">
          <div className="mb-space-sm flex items-center justify-between">
            <h3 className="font-headline-sm text-headline-sm text-on-surface">Paid from the Pool</h3>
            <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{pool.vendorPayments.length} payments</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {pool.vendorPayments.map((v) => (
              <Link
                key={v.expenseId}
                href={`/trips/${trip.tripId}/activity?expense=${v.expenseId}`}
                className="flex items-center justify-between gap-space-sm rounded-xl bg-surface-container-lowest p-space-md shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-container text-primary">
                    <Icon name="storefront" className="text-[20px]" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-title-md text-title-md text-on-surface">{v.title}</p>
                    <p className="font-label-sm text-label-sm text-on-surface-variant">
                      {v.vendor ?? "Vendor"} · {formatDate(v.date)}
                    </p>
                  </div>
                </div>
                <div className="flex flex-col items-end">
                  <span className={cx("font-currency-md text-currency-md", v.status === "cancelled" ? "text-outline line-through" : "text-on-surface")}>{formatMoney(v.amountPaise)}</span>
                  {v.status === "cancelled" ? <span className="font-label-sm text-label-sm text-error">cancelled</span> : null}
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* Payments made directly */}
      <section className="px-margin pb-space-sm pt-space-md">
        <div className="rounded-2xl bg-surface-container-lowest p-space-md shadow-sm">
          <div className="flex items-center gap-space-sm pb-space-sm">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary-fixed/60 text-on-secondary-fixed-variant">
              <Icon name="receipt_long" className="text-[18px]" />
            </div>
            <div>
              <h3 className="font-title-md text-title-md text-on-surface">Paid directly</h3>
              <p className="font-label-sm text-label-sm text-on-surface-variant">Someone paid a vendor with their own card, UPI or cash</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 pt-2">
            <div className="flex flex-col rounded-xl bg-surface-container-low p-3">
              <span className="font-label-sm text-label-sm text-on-surface-variant">You paid</span>
              <p className="mt-1 font-title-md text-title-md text-on-surface">{formatMoney((me?.paidPaise ?? 0) - (me?.refundsReceivedPaise ?? 0))}</p>
            </div>
            <div className="flex flex-col rounded-xl bg-surface-container-low p-3">
              <span className="font-label-sm text-label-sm text-on-surface-variant">Your share</span>
              <p className="mt-1 font-title-md text-title-md text-on-surface">{formatMoney(me?.sharePaise ?? 0)}</p>
            </div>
            <div className={cx("flex flex-col rounded-xl p-3", net >= 0 ? "bg-surface-container" : "bg-error-container/70")}>
              <span className={cx("font-label-sm text-label-sm font-semibold", net >= 0 ? "text-primary" : "text-on-error-container")}>{net >= 0 ? "You're owed" : "You owe"}</span>
              <p className={cx("mt-1 font-title-md text-title-md font-bold", net >= 0 ? "text-primary" : "text-on-error-container")}>{formatMoney(Math.abs(net))}</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-space-sm">
            <button
              disabled={closed}
              onClick={() => setSheet("direct")}
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-primary-container px-space-md font-title-md text-title-md text-on-primary shadow-sm disabled:opacity-40"
            >
              <Icon name="add" className="text-[20px]" /> Record a payment
            </button>
            <Link href={`/trips/${trip.tripId}/simulate`} className="flex h-11 items-center justify-center gap-1 rounded-xl bg-surface-container px-space-md font-title-md text-title-md text-on-surface">
              <Icon name="science" className="text-[20px]" /> What if…
            </Link>
          </div>
        </div>
      </section>

      <SettleSection />

      {/* Honest custody note (in place of the design's "escrow backed by a bank" card) */}
      <section className="px-margin pt-space-md">
        <div className="flex gap-space-sm rounded-2xl bg-surface-container-low p-space-md">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-primary">
            <Icon name="account_balance" className="text-[20px]" />
          </div>
          <div>
            <p className="font-title-md text-title-md text-on-surface">Simulated escrow</p>
            <p className="font-body-md text-body-md text-on-surface-variant">
              Prototype: the pool is tracked by the ledger — no bank holds it. Deposits, vendor payments and settlements are records you confirm; UPI links open your own UPI app.
            </p>
          </div>
        </div>
      </section>

      {sheet === "deposit" ? <DepositSheet open onClose={() => setSheet(null)} /> : null}
      {sheet === "contribute" ? <ContributeSheet open onClose={() => setSheet(null)} pool={serverPool} config={payConfig} onDone={() => void reloadPool()} /> : null}
      {sheet === "target" ? <TargetSheet open onClose={() => setSheet(null)} current={serverPool?.targetAmountPaise ?? null} onSaved={() => void reloadPool()} /> : null}
      {sheet === "withdraw" ? <WithdrawSheet open onClose={() => setSheet(null)} /> : null}
      {sheet === "pay" ? <PaySheet open onClose={() => setSheet(null)} onContribute={() => setSheet("contribute")} /> : null}
      {sheet === "direct" ? <ExpenseSheet open source="direct" onClose={() => setSheet(null)} /> : null}
    </main>
  );
}
