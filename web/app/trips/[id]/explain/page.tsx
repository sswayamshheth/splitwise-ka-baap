"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";

import { cx, Icon } from "@/components/app/kit";
import { Face } from "@/components/app/money/parts";
import { useTrip } from "@/lib/client/trip";
import { formatDate } from "@/lib/dates";
import { buildNameLookup, describeEvent } from "@/lib/ledger/describe";
import { balanceBreakdown, balanceTimeline, summariseDelta } from "@/lib/ledger/explain";
import { formatMoney, sumPaise } from "@/lib/money";

const symbol = (icon: string) => icon.replace(/-/g, "_");
const dateOf = (ts: number) => {
  const d = new Date(ts);
  return formatDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
};
const timeOf = (ts: number) => new Date(ts).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

/**
 * Explain My Balance (Stitch explain_my_balance): every rupee traced to a
 * booking, and every change traced to the event that caused it. Nothing is
 * written by hand — the breakdown and the chronicle come from the event log.
 */
function Explain() {
  const trip = useTrip();
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get("p");
  const pid = requested && trip.participant(requested) ? requested : trip.meId;
  const person = trip.participant(pid);
  const first = (id: string) => (trip.fullName(id) ?? "").split(" ")[0];

  const breakdown = useMemo(() => balanceBreakdown(trip.state, trip.ledger, pid), [trip.state, trip.ledger, pid]);
  const timeline = useMemo(() => [...balanceTimeline(trip.events, pid, first)].reverse(), [trip.events, pid]); // eslint-disable-line react-hooks/exhaustive-deps
  const names = useMemo(() => buildNameLookup(trip.events, trip.meId), [trip.events, trip.meId]);
  const settlementsById = useMemo(() => new Map(trip.state.settlements.map((s) => [s.id, s])), [trip.state.settlements]);

  const net = breakdown.netPaise;
  const linesTotal = sumPaise(breakdown.lines.map((l) => l.netPaise));
  const adds = linesTotal + breakdown.settledNetPaise === net;
  const reconciled = trip.ledger.reconciliationPaise === 0 && adds;
  const mine = trip.isMe(pid);
  const who = mine ? "You" : first(pid);
  const total = Math.max(1, breakdown.paidPaise + breakdown.sharePaise);
  const paidPct = (breakdown.paidPaise / total) * 100;

  return (
    <main className="mx-auto flex w-full max-w-[520px] flex-1 flex-col pb-32">
      {/* Person switcher */}
      <div className="flex gap-space-sm overflow-x-auto px-margin pt-space-sm">
        {trip.state.participants.map((p) => (
          <button
            key={p.id}
            onClick={() => router.replace(`/trips/${trip.tripId}/explain?p=${p.id}`)}
            className={cx(
              "flex shrink-0 items-center gap-1.5 rounded-full py-1 pl-1 pr-space-md font-label-md text-label-md transition-colors",
              p.id === pid ? "bg-primary-container text-on-primary shadow-sm" : "bg-surface-container-low text-on-surface-variant hover:bg-surface-variant",
            )}
          >
            <Face name={p.name} size={24} />
            {trip.short(p.id)}
          </button>
        ))}
      </div>

      {/* Editorial intro */}
      <div className="px-margin pb-space-lg pt-space-md">
        <div className="mb-space-xs flex items-center gap-space-xs font-label-md text-label-md uppercase tracking-wider text-primary">
          <Icon name="account_balance_wallet" className="text-[16px]" />
          <span>Personal Ledger Breakdown</span>
        </div>
        <h2 className="font-headline-lg text-headline-lg text-on-surface">{mine ? "Your Ledger Balance" : `${first(pid)}'s Ledger Balance`}</h2>
        <p className="mt-space-xs font-body-md text-body-md text-on-surface-variant">Here is the step-by-step arithmetic of every rupee in {mine ? "your" : `${first(pid)}'s`} name.</p>
      </div>

      {/* Net position card */}
      <div className="mb-space-xl px-margin">
        <div className="relative overflow-hidden rounded-xl bg-surface-container-lowest p-space-lg shadow-sm">
          <div className="pointer-events-none absolute -bottom-8 -right-8 flex h-36 w-36 items-center justify-center rounded-full bg-surface-container-low opacity-60">
            <Icon name="lock" className="text-[90px] text-surface-variant/40" />
          </div>
          <div className="relative z-10">
            <div className="mb-space-xs flex items-center justify-between gap-space-sm">
              <span className="font-label-sm text-label-sm uppercase tracking-widest text-on-surface-variant">Net Group Position</span>
              <span className={cx("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-label-sm text-label-sm", reconciled ? "bg-surface-container-high text-primary" : "bg-error-container text-on-error-container")}>
                <span className={cx("h-1.5 w-1.5 rounded-full", reconciled ? "animate-pulse bg-primary" : "bg-error")} />
                {reconciled ? "Reconciled" : "Not reconciled"}
              </span>
            </div>
            <div className="mb-space-xs flex items-baseline gap-space-xs">
              <span className="font-headline-md text-headline-md text-primary">₹</span>
              <span className="font-currency-display text-currency-display tracking-tight text-on-surface">{formatMoney(Math.abs(net), { bare: true })}</span>
            </div>
            <p className={cx("font-title-md text-title-md font-medium", net > 0 ? "text-primary-container" : net < 0 ? "text-error" : "text-on-surface-variant")}>
              {net > 0 ? `${who} ${mine ? "are" : "is"} owed` : net < 0 ? `${who} ${mine ? "owe" : "owes"} the group` : `${who} ${mine ? "are" : "is"} settled`}
            </p>
            {person?.leftOn ? (
              <span className="mt-space-xs inline-flex items-center gap-1 rounded-full bg-secondary-fixed px-space-sm py-0.5 font-label-sm text-label-sm text-on-secondary-fixed-variant">
                <Icon name="logout" className="text-[14px]" /> Left on {formatDate(person.leftOn)} · stays on the books until settled
              </span>
            ) : null}
            <div className="mt-space-md rounded-lg bg-surface-container-low/60 p-space-sm pt-space-md">
              <div className="mb-1.5 flex items-center justify-between font-label-sm text-label-sm text-on-surface-variant">
                <span>Paid {formatMoney(breakdown.paidPaise)} · bore {formatMoney(breakdown.sharePaise)}</span>
                <span className="font-semibold text-on-surface">{formatMoney(net, { signed: true })}</span>
              </div>
              <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high">
                <div className="h-full rounded-full bg-primary transition-all duration-700" style={{ width: `${paidPct}%` }} />
                <div className="h-full flex-1 bg-secondary-fixed-dim transition-all duration-700" />
              </div>
              <div className="mt-2 flex items-center justify-between font-label-sm text-label-sm text-on-surface-variant">
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-primary" /> {formatMoney(breakdown.paidPaise)} paid
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-secondary-fixed-dim" /> {formatMoney(breakdown.sharePaise)} share
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-surface-variant" /> {formatMoney(breakdown.settledNetPaise, { signed: true })} settled
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* How it adds up */}
      <div className="mb-space-xl px-margin">
        <div className="mb-space-md flex items-center justify-between">
          <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">How it adds up</span>
          <span className="font-label-sm text-label-sm font-medium text-primary">{breakdown.lines.length} bookings</span>
        </div>
        <div className="flex flex-col gap-space-sm">
          {breakdown.lines.map((l) => (
            <div key={l.expenseId} className="rounded-xl bg-surface-container-lowest p-space-md shadow-sm">
              <div className="flex items-start justify-between gap-space-xs">
                <div className="min-w-0">
                  <p className="font-label-sm text-label-sm text-on-surface-variant">
                    Paid {formatMoney(l.paidPaise)} · share {formatMoney(l.sharePaise)}
                    {l.status === "cancelled" ? " · cancelled" : ""}
                  </p>
                  <h3 className="mt-0.5 font-title-md text-title-md text-on-surface">{l.title}</h3>
                </div>
                <span className={cx("whitespace-nowrap font-currency-md text-currency-md font-semibold", l.netPaise > 0 ? "text-primary" : l.netPaise < 0 ? "text-on-surface" : "text-on-surface-variant")}>
                  {formatMoney(l.netPaise, { signed: true })}
                </span>
              </div>
              <p className="mt-1.5 font-body-md text-body-md text-on-surface-variant">{l.formula}</p>
            </div>
          ))}
          {breakdown.settlements.map((s, i) => (
            <div key={i} className="rounded-xl bg-surface-container-lowest p-space-md shadow-sm">
              <div className="flex items-start justify-between gap-space-xs">
                <div>
                  <p className="font-label-sm text-label-sm text-on-surface-variant">{s.status === "confirmed" ? "Confirmed settlement" : "Sent — not counted until confirmed"}</p>
                  <h3 className="mt-0.5 font-title-md text-title-md text-on-surface">{s.direction === "sent" ? `Paid ${trip.short(s.counterparty)}` : `Received from ${trip.short(s.counterparty)}`}</h3>
                </div>
                <span className={cx("whitespace-nowrap font-currency-md text-currency-md font-semibold", s.status === "confirmed" ? "text-on-surface" : "text-on-surface-variant")}>
                  {s.status === "confirmed" ? formatMoney(s.direction === "sent" ? s.amountPaise : -s.amountPaise, { signed: true }) : formatMoney(s.amountPaise)}
                </span>
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between gap-space-sm rounded-xl bg-surface-container p-space-md">
            <span className="flex items-center gap-1 font-label-md text-label-md text-on-surface">
              <Icon name="functions" className="text-[18px] text-primary" /> Bookings {formatMoney(linesTotal, { signed: true })} + settlements {formatMoney(breakdown.settledNetPaise, { signed: true })}
            </span>
            <span className={cx("font-title-md text-title-md", adds ? "text-primary" : "text-error")}>
              = {formatMoney(net, { signed: true })} {adds ? "✓" : "✗"}
            </span>
          </div>
        </div>
      </div>

      {/* Ledger chronicle */}
      <div className="mb-space-xl px-margin">
        <div className="mb-space-md flex items-center justify-between">
          <span className="font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">Ledger Chronicle</span>
          <span className="font-label-sm text-label-sm font-medium text-primary">
            {timeline.length} Event{timeline.length === 1 ? "" : "s"} Accounted
          </span>
        </div>
        {timeline.length === 0 ? <p className="rounded-xl bg-surface-container-low p-space-md font-body-md text-on-surface-variant">Nothing has moved this balance yet.</p> : null}
        <div className="relative space-y-space-lg pl-6">
          {timeline.length ? <div className="absolute bottom-4 left-2.5 top-3 w-0.5 -translate-x-1/2 bg-surface-variant" /> : null}
          {timeline.map((entry, idx) => {
            const d = describeEvent(entry.event, names, { settlements: settlementsById });
            const up = entry.deltaPaise > 0;
            return (
              <div key={entry.event.id} className="group relative">
                <div
                  className={cx(
                    "absolute -left-6 top-1 flex h-5 w-5 items-center justify-center rounded-full shadow-sm",
                    idx === 0 ? "bg-primary text-on-primary" : up ? "bg-primary-fixed text-on-primary-fixed" : "bg-surface-container-highest text-on-surface",
                  )}
                >
                  <Icon name={symbol(d.icon)} className="text-[13px]" />
                </div>
                <div className="rounded-xl bg-surface-container-lowest p-space-md shadow-sm transition-all hover:bg-surface-container-low/40">
                  <div className="flex items-start justify-between gap-space-xs">
                    <div className="min-w-0">
                      <p className="font-label-sm text-label-sm text-on-surface-variant">
                        {dateOf(entry.event.ts)} · {timeOf(entry.event.ts)} · by {names(entry.event.actor)}
                      </p>
                      <h3 className="mt-0.5 font-title-md text-title-md text-on-surface">{d.title}</h3>
                    </div>
                    <span className={cx("whitespace-nowrap font-currency-md text-currency-md", up ? "font-bold text-primary" : "font-semibold text-on-surface")}>{formatMoney(entry.deltaPaise, { signed: true })}</span>
                  </div>
                  <p className="mt-1.5 font-body-md text-body-md text-on-surface-variant">{summariseDelta(first(pid), entry.deltaPaise, entry.lines)}</p>
                  {entry.lines.some((l) => l.shareBefore !== undefined && l.shareAfter !== undefined) ? (
                    <div className="mt-space-xs flex flex-wrap gap-space-xs">
                      {entry.lines
                        .filter((l) => l.shareBefore !== undefined && l.shareAfter !== undefined)
                        .map((l, i) => (
                          <span key={i} className="rounded-full bg-surface-container px-space-sm py-0.5 font-label-sm text-label-sm text-on-surface-variant">
                            {l.title.split(" · ")[0]}: {formatMoney(l.shareBefore!)} → {formatMoney(l.shareAfter!)}
                          </span>
                        ))}
                    </div>
                  ) : null}
                  <div className="mt-space-sm flex items-center justify-between rounded-lg bg-surface-container-low px-space-sm py-1 pt-space-xs">
                    <span className="font-label-sm text-label-sm text-on-surface-variant">Running Balance</span>
                    <span className="font-label-md text-label-md font-semibold text-on-surface">
                      {formatMoney(entry.netBefore, { signed: true })} → {formatMoney(entry.netAfter, { signed: true })}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Closing note (in place of the design's escrow safe-vault card) */}
      <div className="px-margin">
        <div className="flex gap-space-sm rounded-xl bg-surface-container-low p-space-md">
          <Icon name="shield" className="text-[22px] text-primary" />
          <div>
            <p className="font-title-md text-title-md text-on-surface">Derived, never typed in</p>
            <p className="font-body-md text-body-md text-on-surface-variant">Every figure above is recomputed from the trip&apos;s append-only event log. The lines always sum to the balance, and every change names the event that caused it.</p>
          </div>
        </div>
        <button onClick={() => window.print()} className="mt-space-md flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-surface-container font-title-md text-title-md text-on-surface">
          <Icon name="print" className="text-[20px]" /> Print this breakdown
        </button>
      </div>
    </main>
  );
}

export default function ExplainPage() {
  return (
    <Suspense>
      <Explain />
    </Suspense>
  );
}
