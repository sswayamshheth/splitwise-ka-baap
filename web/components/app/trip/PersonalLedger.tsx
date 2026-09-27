"use client";

import { useMemo, useState } from "react";

import { cx, Icon } from "@/components/app/kit";
import { useTrip } from "@/lib/client/trip";
import { formatDate } from "@/lib/dates";
import { personalLedger } from "@/lib/ledger/personal";
import type { ParticipantId } from "@/lib/ledger/types";
import { formatMoney } from "@/lib/money";
import { CATEGORY_ICON } from "./common";

/**
 * One person's own ledger: what the trip cost them, category by category,
 * each category opening into its bookings. Figures come from the computed
 * ledger (lib/ledger/personal.ts); the net is the same one the Money tab shows.
 */
export function PersonalLedger({ pid, showSettlements = false }: { pid?: ParticipantId; showSettlements?: boolean }) {
  const trip = useTrip();
  const who = pid ?? trip.meId;
  const me = trip.isMe(who);
  const p = useMemo(() => personalLedger(trip.state, trip.ledger, who), [trip.state, trip.ledger, who]);
  const [open, setOpen] = useState<string | null>(null);
  const max = Math.max(1, ...p.categories.map((c) => Math.abs(c.sharePaise)));
  const net = p.netPaise;
  const name = me ? "You" : trip.short(who);

  return (
    <section className="flex flex-col gap-space-md rounded-xl bg-surface-container-lowest p-space-lg shadow-sm">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-label-sm text-label-sm uppercase tracking-wider text-primary">
          <Icon name="account_balance_wallet" className="text-[16px]" /> {me ? "My spending" : `${trip.fullName(who)}'s spending`}
        </span>
        <span className={cx("rounded-full px-2 py-0.5 font-label-sm text-label-sm", net > 0 ? "bg-primary-fixed/60 text-on-primary-fixed-variant" : net < 0 ? "bg-secondary-fixed text-on-secondary-fixed-variant" : "bg-surface-container text-on-surface-variant")}>
          {net > 0 ? `${me ? "You're" : `${name} is`} owed ${formatMoney(net)}` : net < 0 ? `${name} owe${me ? "" : "s"} ${formatMoney(-net)}` : "Square"}
        </span>
      </div>

      <div>
        <span className="font-currency-display text-[28px] leading-9 text-on-surface">{formatMoney(p.totalSharePaise)}</span>
        <p className="font-body-md text-body-md text-on-surface-variant">
          {me ? "What the trip has cost you" : "What the trip has cost them"} · {name} paid {formatMoney(p.paidPaise)}
        </p>
      </div>

      {p.categories.length === 0 ? (
        <p className="font-body-md text-body-md text-on-surface-variant">No bookings yet.</p>
      ) : (
        <div className="flex flex-col divide-y divide-outline-variant/40">
          {p.categories.map((c) => {
            const isOpen = open === c.category;
            return (
              <div key={c.category} className="flex flex-col">
                <button onClick={() => setOpen(isOpen ? null : c.category)} aria-expanded={isOpen} className="flex w-full items-center gap-space-sm py-space-sm text-left">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container text-primary">
                    <Icon name={CATEGORY_ICON[c.category] ?? "receipt_long"} className="text-[18px]" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center justify-between gap-space-sm">
                      <span className="truncate font-title-md text-[15px] text-on-surface">
                        {c.category} <span className="font-label-sm text-label-sm text-on-surface-variant">· {c.items.length}</span>
                      </span>
                      <span className="shrink-0 font-currency-md text-[15px] tabular-nums text-on-surface">{formatMoney(c.sharePaise)}</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, (c.sharePaise / max) * 100)}%` }} />
                    </div>
                  </div>
                  <Icon name={isOpen ? "expand_less" : "expand_more"} className="text-[20px] text-on-surface-variant" />
                </button>
                {isOpen ? (
                  <div className="mb-space-sm flex flex-col gap-space-xs rounded-lg bg-surface-container-low/60 p-space-sm">
                    {c.items.map((i) => (
                      <div key={i.expenseId} className="flex items-start justify-between gap-space-sm px-1">
                        <div className="flex min-w-0 flex-col">
                          <span className={cx("truncate font-body-md text-[14px] text-on-surface", i.status === "cancelled" && "line-through opacity-70")}>{i.title}</span>
                          <span className="font-label-sm text-label-sm text-on-surface-variant">
                            {formatDate(i.date)}
                            {i.paidPaise ? ` · ${name} paid ${formatMoney(i.paidPaise)}` : ""}
                            {i.status === "cancelled" ? " · cancelled" : ""}
                            {i.refundedPaise ? ` · ${formatMoney(i.refundedPaise)} refunded` : ""}
                            {i.withdrew ? " · dropped out" : ""}
                          </span>
                        </div>
                        <span className="shrink-0 font-label-md text-label-md tabular-nums text-on-surface">{formatMoney(i.sharePaise)}</span>
                      </div>
                    ))}
                    <div className="flex justify-between border-t border-outline-variant/40 px-1 pt-1 font-label-sm text-label-sm text-on-surface-variant">
                      <span>Share {formatMoney(c.sharePaise)}</span>
                      <span>Paid {formatMoney(c.paidPaise)}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {showSettlements ? (
        <div className="flex flex-col gap-space-xs rounded-lg bg-surface-container-low/60 p-space-sm">
          <span className="px-1 font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Settlements</span>
          {p.settlements.length === 0 ? (
            <span className="px-1 font-body-md text-[14px] text-on-surface-variant">None yet.</span>
          ) : (
            p.settlements.map((s, i) => (
              <div key={i} className="flex items-center justify-between gap-space-sm px-1">
                <span className="font-body-md text-[14px] text-on-surface">
                  {s.direction === "sent" ? `${name} → ${trip.short(s.counterparty)}` : `${trip.short(s.counterparty)} → ${name}`}
                  {s.status === "initiated" ? <span className="font-label-sm text-label-sm text-secondary"> · awaiting confirmation</span> : null}
                </span>
                <span className={cx("font-label-md text-label-md tabular-nums", s.direction === "received" ? "text-primary" : "text-on-surface")}>
                  {s.direction === "sent" ? "−" : "+"}
                  {formatMoney(s.amountPaise)}
                </span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}
