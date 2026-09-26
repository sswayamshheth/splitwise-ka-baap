"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Button, cx, Field, Icon, inputCls, Notice, Sheet, useFeedback } from "@/components/app/kit";
import { BudgetCard } from "@/components/app/trip/BudgetCard";
import { ChainBadge } from "@/components/app/trip/ChainBadge";
import { EventRow, HeroBadge, PhotoHero, Portrait, ProgressBar } from "@/components/app/trip/common";
import { HarmonyCard } from "@/components/app/trip/HarmonyCard";
import { errorText, useTrip } from "@/lib/client/trip";
import { tripCover } from "@/lib/covers";
import { daysBetween, formatDateRange, todayIso } from "@/lib/dates";
import { findAnomalies, tripHealth } from "@/lib/ledger/checks";
import { addParticipant } from "@/lib/ledger/commands";
import { buildNameLookup, describeEvent } from "@/lib/ledger/describe";
import { poolSummary } from "@/lib/ledger/pool";
import { formatMoney } from "@/lib/money";

/**
 * The trip at a glance, in the design's Trip / Group layout: photo hero,
 * where I stand, harmony and budget, the trip's health, what needs
 * attention, the what-if and ask entry points, the circle of members and
 * invites, and the latest ledger events. Every figure is derived from the
 * event log.
 */
export default function TripPage() {
  const trip = useTrip();
  const { state, ledger, meId, tripId } = trip;
  const base = `/trips/${tripId}`;
  const anomalies = useMemo(() => findAnomalies(state, ledger), [state, ledger]);
  const health = useMemo(() => tripHealth(state, ledger, anomalies), [state, ledger, anomalies]);
  const pool = useMemo(() => poolSummary(state), [state]);
  const [showAll, setShowAll] = useState(false);
  const me = ledger.balances[meId];
  const net = me?.netPaise ?? 0;
  const provisional = me?.provisionalNetPaise ?? 0;
  const myTransfers = ledger.transfers.filter((t) => t.from === meId || t.to === meId);
  const names = buildNameLookup(trip.events, meId);
  const settlementsById = new Map(state.settlements.map((s) => [s.id, s]));
  const recent = [...trip.events].reverse().slice(0, 3);
  const members = [...state.participants].sort((a, b) => (a.id === meId ? -1 : b.id === meId ? 1 : (ledger.balances[b.id]?.netPaise ?? 0) - (ledger.balances[a.id]?.netPaise ?? 0)));
  const shownAnomalies = showAll ? anomalies : anomalies.slice(0, 4);
  const spentOfPlan = health.budgetPaise > 0 ? health.spentPaise / health.budgetPaise : 0;

  const t = state.trip;
  const today = todayIso();
  const totalDays = Math.max(1, daysBetween(t.startDate, t.endDate) + 1);
  const when =
    t.status === "closed"
      ? "Trip closed"
      : today < t.startDate
        ? (() => {
            const n = daysBetween(today, t.startDate);
            return n === 1 ? "Tomorrow" : `In ${n} days`;
          })()
        : today > t.endDate
          ? "Trip ended"
          : `Day ${daysBetween(t.startDate, today) + 1} of ${totalDays}`;
  const issues = health.anomalies.critical + health.anomalies.warning;

  return (
    <main className="mx-auto w-full max-w-[520px] flex-1 pb-10">
      {/* hero */}
      <PhotoHero
        image={tripCover(t.destination, tripId)}
        className="h-72 rounded-b-[28px]"
        top={
          <>
            <HeroBadge>
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              {when}
            </HeroBadge>
            {issues ? (
              <HeroBadge tone="amber" icon="info">
                {issues} to check
              </HeroBadge>
            ) : (
              <HeroBadge tone="teal" icon="verified">
                Books balance
              </HeroBadge>
            )}
          </>
        }
      >
        <span className="font-label-sm text-label-sm uppercase tracking-widest text-primary-fixed">{t.status === "closed" ? "Archived trip" : "Active itinerary"}</span>
        <h2 className="font-headline-lg text-headline-lg leading-tight text-surface-container-lowest">{t.name}</h2>
        <p className="flex items-center gap-1 font-body-md text-body-md text-surface-container-low/90">
          <Icon name="location_on" className="text-[18px]" />
          {t.destination} · {formatDateRange(t.startDate, t.endDate)}
        </p>
      </PhotoHero>

      <div className="flex flex-col gap-space-lg px-margin pt-space-md">
        {/* where I stand */}
        <section className="flex flex-col gap-space-md rounded-xl bg-surface-container-lowest p-space-lg shadow-sm">
          <div className="flex items-center justify-between">
            <span className="font-label-sm text-label-sm uppercase tracking-wider text-primary">Your position</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-container px-space-sm py-0.5 font-label-sm text-label-sm text-on-surface-variant">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              {ledger.reconciliationPaise === 0 ? "Books balance" : "Out of balance"}
            </span>
          </div>
          <div>
            <h3 className="font-display-lg-mobile text-display-lg-mobile text-on-surface">
              {net > 0 ? `You're owed ${formatMoney(net)}` : net < 0 ? `You owe ${formatMoney(-net)}` : "You're square"}
            </h3>
            <p className="mt-space-xs font-body-md text-body-md leading-relaxed text-on-surface-variant">
              Paid {formatMoney((me?.paidPaise ?? 0) - (me?.refundsReceivedPaise ?? 0))} · your share {formatMoney(me?.sharePaise ?? 0)}
              {provisional !== net ? ` · ${formatMoney(Math.abs(provisional - net))} in payments awaiting confirmation` : ""}
            </p>
          </div>
          {myTransfers.length ? (
            <div className="flex flex-col gap-1 rounded-lg bg-surface-container-low/60 px-space-md py-space-sm">
              {myTransfers.map((tr, i) => (
                <span key={i} className="flex items-center justify-between font-body-md text-body-md text-on-surface">
                  <span>{tr.from === meId ? `You pay ${trip.short(tr.to)}` : `${trip.short(tr.from)} pays you`}</span>
                  <span className="font-currency-md">{formatMoney(tr.amountPaise)}</span>
                </span>
              ))}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-space-sm">
            <Link href={`${base}/activity`} className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-surface-container font-title-md text-[15px] text-primary hover:bg-surface-container-high">
              <Icon name="history" className="text-[18px]" /> Activity
            </Link>
            <Link href={`${base}/money`} className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-primary-container font-title-md text-[15px] text-on-primary hover:bg-primary">
              <Icon name="swap_horiz" className="text-[18px]" /> Settle up
            </Link>
          </div>
        </section>

        <HarmonyCard />
        <BudgetCard />

        {/* pool + health, like the design's "Collective vault" strip */}
        <section className="flex flex-col gap-space-sm rounded-xl bg-surface-container-low p-space-md">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-label-md text-label-md uppercase tracking-wider text-on-surface">
              <Icon name="account_balance" className="text-[18px] text-primary" /> Spent vs plan
            </span>
            <span className="font-currency-md text-[15px] text-primary">
              {formatMoney(health.spentPaise)} / {formatMoney(health.budgetPaise)}
            </span>
          </div>
          <ProgressBar value={spentOfPlan} tone={spentOfPlan > 1 ? "error" : "primary"} />
          <div className="flex justify-between gap-space-sm font-label-sm text-label-sm text-on-surface-variant">
            <span>
              Committed {formatMoney(health.committedPaise)} · {formatMoney(health.refundedPaise)} refunded
            </span>
            {health.vendorOutstandingPaise ? <span className="text-secondary">{formatMoney(health.vendorOutstandingPaise)} due to vendors</span> : null}
          </div>
          <div className="mt-space-xs flex items-center justify-between">
            <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface">Settled between members</span>
            <span className="font-currency-md text-[15px] text-on-surface">{Math.round(health.settledFraction * 100)}%</span>
          </div>
          <ProgressBar value={health.settledFraction} tone="secondary" />
          <span className="font-label-sm text-label-sm text-on-surface-variant">
            {formatMoney(health.settledPaise)} confirmed · {formatMoney(health.outstandingPaise)} outstanding · {health.transfersToSettle} transfer{health.transfersToSettle === 1 ? "" : "s"} to finish
          </span>
          <div className="mt-space-xs grid grid-cols-4 gap-space-xs">
            <Tile label="Members" value={String(health.members)} sub={health.leftMembers ? `${health.leftMembers} left` : "travelling"} />
            <Tile label="Bookings" value={String(health.bookings)} sub={health.cancelledBookings ? `${health.cancelledBookings} cancelled` : "active"} />
            <Tile label="Pending" value={String(health.pendingSettlements)} sub="payments" warn={health.pendingSettlements > 0} />
            <Tile label="Pool" value={pool.availablePaise ? formatMoney(pool.availablePaise) : "—"} sub="simulated" />
          </div>
        </section>

        {/* needs attention */}
        {anomalies.length ? (
          <section className="flex flex-col gap-space-sm">
            <div className="flex items-center justify-between">
              <h3 className="font-headline-sm text-headline-sm text-on-surface">Needs attention</h3>
              {anomalies.length > 4 ? (
                <button className="font-label-md text-label-md text-primary" onClick={() => setShowAll(!showAll)}>
                  {showAll ? "Show less" : `Show all ${anomalies.length}`}
                </button>
              ) : (
                <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{anomalies.length} found</span>
              )}
            </div>
            {shownAnomalies.map((a) => {
              const tone = a.severity === "info" ? "bg-tertiary-fixed/60 text-on-tertiary-fixed" : "bg-secondary-fixed/40 text-on-secondary-fixed";
              const iconTone = a.severity === "info" ? "bg-tertiary-fixed text-on-tertiary-fixed-variant" : a.severity === "critical" ? "bg-error-container text-on-error-container" : "bg-secondary-container text-on-secondary-container";
              return (
                <Link key={a.id} href={a.expenseId ? `${base}/activity?expense=${a.expenseId}` : `${base}/plan`} className={cx("flex gap-space-sm rounded-xl p-space-md transition-shadow hover:shadow-md", tone)}>
                  <span className={cx("flex h-10 w-10 shrink-0 items-center justify-center rounded-full", iconTone)}>
                    <Icon name={a.severity === "info" ? "info" : "warning"} className="text-[20px]" />
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="font-title-md text-title-md">{a.title}</span>
                    <span className="font-body-md text-body-md opacity-80">{a.detail}</span>
                  </div>
                </Link>
              );
            })}
            <p className="font-label-sm text-label-sm text-on-surface-variant">Found by deterministic checks: plan vs split, seats vs members, payments vs bill, duplicates, refunds.</p>
          </section>
        ) : null}

        {/* what if + ask */}
        <section className="grid grid-cols-2 gap-space-sm">
          <Link href={`${base}/simulate`} className="flex flex-col gap-space-xs rounded-xl bg-surface-container-lowest p-space-md shadow-sm transition-shadow hover:shadow-md">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary-container text-on-primary">
              <Icon name="science" />
            </span>
            <span className="mt-1 font-headline-sm text-headline-sm text-on-surface">What if…?</span>
            <span className="font-body-md text-body-md text-on-surface-variant">Someone leaves, a booking is cancelled, a price changes — see it before it happens.</span>
          </Link>
          <Link href={`${base}/ask`} className="flex flex-col gap-space-xs rounded-xl bg-tertiary-fixed/60 p-space-md shadow-sm transition-shadow hover:shadow-md">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-tertiary text-on-tertiary">
              <Icon name="auto_awesome" />
            </span>
            <span className="mt-1 font-headline-sm text-headline-sm text-on-tertiary-fixed">Ask the ledger</span>
            <span className="font-body-md text-body-md text-on-tertiary-fixed-variant">Answers from the real ledger — every number comes from the engine.</span>
          </Link>
        </section>

        <Link href={`${base}/chain`} className="flex items-center gap-space-sm rounded-xl bg-surface-container-lowest p-space-md shadow-sm transition-shadow hover:shadow-md">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-tertiary-fixed text-on-tertiary-fixed-variant">
            <Icon name="deployed_code" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-headline-sm text-headline-sm text-on-surface">Blockchain proof</span>
            <span className="block font-body-md text-body-md text-on-surface-variant">Every change is a SHA-256 block; the chain is sealed on Ethereum.</span>
            <span className="mt-1 block">
              <ChainBadge />
            </span>
          </span>
          <Icon name="chevron_right" className="text-on-surface-variant" />
        </Link>

        <Members members={members} />

        {/* recent */}
        <section className="flex flex-col gap-space-sm">
          <div className="flex items-center justify-between">
            <h3 className="font-headline-sm text-headline-sm text-on-surface">Latest in the ledger</h3>
            <Link href={`${base}/activity`} className="flex items-center gap-0.5 font-label-md text-label-md text-primary">
              All activity <Icon name="arrow_forward" className="text-[16px]" />
            </Link>
          </div>
          <div className="flex flex-col divide-y divide-outline-variant/40 rounded-xl bg-surface-container-lowest px-space-md shadow-sm">
            {recent.map((e) => (
              <EventRow key={e.id} d={describeEvent(e, names, { settlements: settlementsById })} ts={e.ts} actor={names(e.actor)} />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function Tile({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={cx("flex min-w-0 flex-col rounded-lg p-space-sm", warn ? "bg-secondary-fixed/60" : "bg-surface-container-lowest")}>
      <span className="font-label-sm text-[10px] uppercase tracking-wider text-on-surface-variant">{label}</span>
      <span className="truncate font-currency-md text-[16px] text-on-surface">{value}</span>
      {sub ? <span className="truncate font-label-sm text-[10px] text-on-surface-variant">{sub}</span> : null}
    </div>
  );
}

function Members({ members }: { members: ReturnType<typeof useTrip>["state"]["participants"] }) {
  const trip = useTrip();
  const { toast } = useFeedback();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const link = typeof window !== "undefined" ? `${window.location.origin}/join/${trip.joinCode}` : `/join/${trip.joinCode}`;
  const pool = poolSummary(trip.state);
  const travelling = members.filter((m) => !m.leftOn).length;

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch {
      toast(text);
    }
  }

  async function add() {
    setBusy(true);
    try {
      await trip.run((state, ctx) => addParticipant(state, { name }, ctx));
      toast(`${name.trim()} added — shares re-derive as they join bookings`);
      setName("");
      setOpen(false);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-space-md">
      <div className="flex flex-col gap-space-xs">
        <div className="flex items-center justify-between">
          <span className="font-label-sm text-label-sm uppercase tracking-widest text-secondary">Travel circle</span>
          <span className="rounded-full bg-surface-container-high px-2 py-0.5 font-label-sm text-label-sm text-on-surface-variant">
            {travelling} traveller{travelling === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <h3 className="font-headline-md text-headline-md text-on-surface">The Expedition Circle</h3>

        </div>
      </div>

      {members.map((p) => {
        const b = trip.ledger.balances[p.id];
        const n = b?.netPaise ?? 0;
        const mine = trip.isMe(p.id);
        const funded = pool.members[p.id]?.depositedPaise ?? 0;
        return (
          <div key={p.id} className={cx("rounded-xl bg-surface-container-lowest p-space-md shadow-sm", p.leftOn && "opacity-60")}>
            <div className="flex items-start gap-space-md">
              <div className="relative shrink-0">
                <Portrait name={p.name} size={56} />
                {trip.claimed.has(p.id) ? (
                  <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-on-primary" title="On GroupTrip">
                    <Icon name="verified" className="text-[12px]" />
                  </span>
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <h4 className="truncate font-title-md text-title-md text-on-surface">{p.name}</h4>
                  {mine ? <span className="rounded bg-primary-container px-1.5 py-0.5 text-[10px] font-semibold uppercase text-on-primary-container">You</span> : null}
                  {p.leftOn ? <span className="rounded bg-error-container px-1.5 py-0.5 text-[10px] font-semibold uppercase text-on-error-container">Left</span> : null}
                </div>
                <p className={cx("font-label-sm text-label-sm font-medium", trip.claimed.has(p.id) ? "text-primary" : "text-on-surface-variant")}>
                  {trip.claimed.has(p.id) ? "On GroupTrip" : "Added by name · can claim with the invite code"}
                </p>
                <div
                  className={cx(
                    "mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-label-sm text-label-sm font-medium",
                    n > 0 ? "bg-surface-container-low text-primary" : n < 0 ? "bg-secondary-fixed/60 text-on-secondary-fixed-variant" : "bg-surface-container-low text-on-surface-variant",
                  )}
                >
                  <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", n > 0 ? "bg-primary" : n < 0 ? "bg-secondary" : "bg-outline")} />
                  {n > 0 ? `Owed ${formatMoney(n)}` : n < 0 ? `Owes ${formatMoney(-n)}` : "Settled"}
                </div>
                <p className="mt-2 truncate font-label-sm text-label-sm text-on-surface-variant">
                  Paid {formatMoney((b?.paidPaise ?? 0) - (b?.refundsReceivedPaise ?? 0))} · share {formatMoney(b?.sharePaise ?? 0)}
                  {funded ? ` · ${formatMoney(funded)} into pool` : ""}
                </p>
              </div>
            </div>
          </div>
        );
      })}

      {/* expand the circle */}
      <div className="flex flex-col gap-space-md rounded-xl bg-surface-container-lowest p-space-md shadow-sm">
        <div className="flex items-center gap-space-md">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-container text-primary">
            <Icon name="person_add" />
          </span>
          <div className="flex flex-col">
            <span className="font-title-md text-title-md text-on-surface">Expand the circle</span>
            <span className="font-label-sm text-label-sm text-on-surface-variant">Share the invite code or link</span>
          </div>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-surface-container-low px-space-md py-space-sm">
          <span className="font-currency-display text-[26px] tracking-[0.25em] text-primary">{trip.joinCode}</span>
          <button onClick={() => void copy(trip.joinCode, "Code")} className="flex items-center gap-1 font-label-md text-label-md text-primary">
            <Icon name="content_copy" className="text-[18px]" /> Copy
          </button>
        </div>
        <button onClick={() => void copy(link, "Invite link")} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary transition-colors hover:bg-primary">
          <Icon name="link" /> Invite to {trip.state.trip.name}
        </button>
        {trip.state.trip.status !== "closed" ? (
          <button onClick={() => setOpen(true)} className="flex items-center justify-center gap-1 font-label-md text-label-md text-primary">
            <Icon name="edit_note" className="text-[18px]" /> Add someone by name
          </button>
        ) : null}
      </div>

      <div className="flex gap-space-sm rounded-xl bg-surface-container-low p-space-md">
        <Icon name="balance" className="text-[18px] text-on-surface-variant" />
        <p className="font-label-sm text-label-sm leading-relaxed text-on-surface-variant">
          Every member&apos;s balance is derived from the ledger. Together they reconcile to {formatMoney(trip.ledger.reconciliationPaise)}.
        </p>
      </div>

      <Sheet open={open} onClose={() => setOpen(false)} title="Add a member">
        <div className="flex flex-col gap-space-md">
          <Field label="Name" hint="They can claim this spot later by joining with the invite code.">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kabir Rao" autoFocus maxLength={40} onKeyDown={(e) => e.key === "Enter" && name.trim() && void add()} />
          </Field>
          <Notice icon="info">A new member isn&apos;t part of any booking yet — add them to bookings from the Plan tab and every share re-derives.</Notice>
          <Button full icon="person_add" disabled={!name.trim() || busy} onClick={() => void add()}>
            {busy ? "Adding…" : "Add member"}
          </Button>
        </div>
      </Sheet>
    </section>
  );
}
