"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { Chip, cx, Empty, Icon, inputCls, Spinner } from "@/components/app/kit";
import { CATEGORY_ICON, Portrait, symbol } from "@/components/app/trip/common";
import { ExpenseSheet } from "@/components/app/trip/ExpenseSheet";
import { useTrip } from "@/lib/client/trip";
import { formatDate, formatRelative } from "@/lib/dates";
import { buildNameLookup, describeEvent, type Described } from "@/lib/ledger/describe";
import type { LedgerEvent } from "@/lib/ledger/types";
import { formatMoney } from "@/lib/money";

type Line = { e: LedgerEvent; d: Described };
type Kind = "booking" | "plan" | "members" | "payments" | "trip";
type Block = {
  key: string;
  kind: Kind;
  title: string;
  sub: string;
  icon: string;
  amountPaise?: number;
  status?: { label: string; tone: "teal" | "coral" | "lavender" | "grey" | "amber" };
  paidBy?: string;
  date?: string;
  firstTs: number;
  lastTs: number;
  lines: Line[];
  expenseId?: string;
};

type Filter = "all" | "bookings" | "payments" | "members";
type Sort = "new" | "old" | "amount";

const STATUS_TONE: Record<NonNullable<Block["status"]>["tone"], string> = {
  teal: "bg-primary-fixed/60 text-on-primary-fixed-variant",
  coral: "bg-error-container text-on-error-container",
  lavender: "bg-tertiary-fixed text-on-tertiary-fixed-variant",
  grey: "bg-surface-container text-on-surface-variant",
  amber: "bg-secondary-fixed text-on-secondary-fixed-variant",
};

const DOT: Record<Described["tone"], string> = {
  blue: "bg-primary-fixed/60 text-primary",
  mint: "bg-primary-fixed/40 text-primary",
  coral: "bg-error-container text-on-error-container",
  amber: "bg-secondary-fixed text-on-secondary-fixed-variant",
  grey: "bg-surface-container text-on-surface-variant",
  lavender: "bg-tertiary-fixed text-on-tertiary-fixed-variant",
};

/**
 * Everything that happened on this trip, organised: one block per booking
 * (and per plan item with its own history), plus Members, Pool & payments
 * and Trip blocks. Collapsed blocks show the headline; opening one shows its
 * full history from the append-only log and, for bookings, who bears what.
 */
function Activity() {
  const trip = useTrip();
  const { state, ledger, meId, events } = trip;
  const params = useSearchParams();
  const deep = params.get("expense");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(deep ? [`x:${deep}`] : []));
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("new");
  const [q, setQ] = useState("");
  const [sheet, setSheet] = useState<string | null>(null);

  const names = useMemo(() => buildNameLookup(events, meId), [events, meId]);
  const settlements = useMemo(() => new Map(state.settlements.map((s) => [s.id, s])), [state.settlements]);

  const blocks = useMemo(() => {
    const itemToExpense = new Map<string, string>();
    for (const it of state.itinerary) if (it.expenseIds[0]) itemToExpense.set(it.id, it.expenseIds[0]);
    for (const x of state.expenses) if (x.itineraryItemId && !itemToExpense.has(x.itineraryItemId)) itemToExpense.set(x.itineraryItemId, x.id);

    const map = new Map<string, Block>();
    const get = (key: string, init: () => Omit<Block, "lines" | "firstTs" | "lastTs">) => {
      let b = map.get(key);
      if (!b) {
        b = { ...init(), lines: [], firstTs: Infinity, lastTs: 0 };
        map.set(key, b);
      }
      return b;
    };
    const payerNames = (ids: string[]) => ids.map((id) => trip.short(id)).join(" & ");

    for (const e of events) {
      const d = describeEvent(e, names, { settlements });
      let block: Block;
      const itemId = d.itemId ?? (e.type === "ITINERARY_ITEM_REMOVED" ? e.itemId : undefined);
      const expenseId = d.expenseId ?? (itemId ? itemToExpense.get(itemId) : undefined);
      if (expenseId) {
        block = get(`x:${expenseId}`, () => {
          const c = ledger.byExpenseId[expenseId];
          if (!c) {
            const deleted = e.type === "EXPENSE_DELETED" ? e.expense : e.type === "EXPENSE_ADDED" ? e.expense : undefined;
            return { key: `x:${expenseId}`, kind: "booking", title: deleted?.title ?? "Removed expense", sub: deleted?.vendor ?? "", icon: "delete", amountPaise: deleted?.amountPaise, status: { label: "Deleted", tone: "grey" }, expenseId };
          }
          const x = c.expense;
          const status: Block["status"] =
            x.status === "cancelled"
              ? { label: "Cancelled", tone: "coral" }
              : c.refundedPaise > 0 && c.effectivePaise === 0
                ? { label: "Refunded", tone: "lavender" }
                : c.refundedPaise > 0
                  ? { label: "Partly refunded", tone: "lavender" }
                  : { label: x.fundedFromPool ? "Paid · pool" : "Paid", tone: "teal" };
          return {
            key: `x:${expenseId}`,
            kind: "booking",
            title: x.title,
            sub: [x.vendor, x.category].filter(Boolean).join(" · "),
            icon: CATEGORY_ICON[x.category] ?? "receipt_long",
            amountPaise: c.effectivePaise,
            status,
            paidBy: x.fundedFromPool ? "Trip pool" : payerNames(x.payers.map((p) => p.participantId)),
            date: x.date,
            expenseId,
          };
        });
      } else if (itemId) {
        block = get(`i:${itemId}`, () => {
          const it = state.itinerary.find((i) => i.id === itemId) ?? (e.type === "ITINERARY_ITEM_REMOVED" ? e.item : e.type === "ITINERARY_ITEM_ADDED" ? e.item : undefined);
          const live = state.itinerary.some((i) => i.id === itemId);
          return {
            key: `i:${itemId}`,
            kind: "plan",
            title: it?.title ?? "Plan item",
            sub: [it?.vendor, it?.category, "not paid yet"].filter(Boolean).join(" · "),
            icon: it ? (CATEGORY_ICON[it.category] ?? "event_note") : "event_note",
            amountPaise: it?.estimatedPaise,
            status: !live ? { label: "Removed", tone: "grey" } : it?.status === "cancelled" ? { label: "Cancelled", tone: "coral" } : { label: "Planned", tone: "amber" },
            date: it?.date,
          };
        });
      } else if (e.type.startsWith("SETTLEMENT_") || e.type.startsWith("CONTRIBUTION_")) {
        block = get("payments", () => ({ key: "payments", kind: "payments", title: "Pool & payments", sub: "", icon: "account_balance_wallet" }));
      } else if (d.kind === "member") {
        block = get("members", () => ({ key: "members", kind: "members", title: "Members", sub: "", icon: "group" }));
      } else {
        block = get("trip", () => ({ key: "trip", kind: "trip", title: "Trip & plan setup", sub: "", icon: "flag" }));
      }
      block.lines.push({ e, d });
      block.firstTs = Math.min(block.firstTs, e.ts);
      block.lastTs = Math.max(block.lastTs, e.ts);
    }

    // Headlines for the grouped blocks, from the ledger.
    const pay = map.get("payments");
    if (pay) {
      const deposits = state.contributions.filter((c) => c.direction !== "out").reduce((s, c) => s + c.amountPaise, 0);
      const confirmed = state.settlements.filter((s) => s.status === "confirmed");
      const pending = state.settlements.filter((s) => s.status === "initiated").length;
      pay.amountPaise = deposits + confirmed.reduce((s, x) => s + x.amountPaise, 0);
      pay.sub = `${formatMoney(deposits)} into the pool · ${confirmed.length} settlement${confirmed.length === 1 ? "" : "s"} confirmed${pending ? ` · ${pending} pending` : ""}`;
      if (pending) pay.status = { label: `${pending} pending`, tone: "amber" };
    }
    const mem = map.get("members");
    if (mem) {
      const left = state.participants.filter((p) => p.leftOn).length;
      mem.sub = `${state.participants.length - left} travelling${left ? ` · ${left} left` : ""}`;
    }
    const tr = map.get("trip");
    if (tr) tr.sub = `${state.trip.destination} · ${state.itinerary.length} plan item${state.itinerary.length === 1 ? "" : "s"}`;
    return [...map.values()];
  }, [events, names, settlements, state, ledger, trip]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = blocks.filter((b) => {
      if (filter === "bookings" && b.kind !== "booking" && b.kind !== "plan") return false;
      if (filter === "payments" && b.kind !== "payments") return false;
      if (filter === "members" && b.kind !== "members") return false;
      if (needle && !`${b.title} ${b.sub} ${b.paidBy ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    return list.sort((a, b) => (sort === "amount" ? (b.amountPaise ?? 0) - (a.amountPaise ?? 0) : sort === "old" ? a.firstTs - b.firstTs : b.lastTs - a.lastTs));
  }, [blocks, filter, sort, q]);

  useEffect(() => {
    if (!deep) return;
    const el = document.getElementById(`block-x:${deep}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [deep]);

  const toggle = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const bookings = ledger.expenses.filter((c) => c.expense.status === "active").length;
  const myShare = ledger.balances[meId]?.sharePaise ?? 0;

  return (
    <main className="mx-auto w-full max-w-[520px] flex-1 px-margin pb-10 pt-space-md">
      {/* summary */}
      <div className="flex items-center justify-between rounded-xl bg-surface-container-lowest p-space-md shadow-sm">
        <div className="flex flex-col">
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Shared ledger</span>
          <span className="font-currency-display text-[28px] leading-9 text-on-surface">{formatMoney(ledger.totals.spendPaise)}</span>
          <span className="font-label-sm text-label-sm text-on-surface-variant">
            {bookings} booking{bookings === 1 ? "" : "s"} · {events.length} updates · net of refunds
          </span>
        </div>
        <div className="flex flex-col items-end rounded-lg bg-surface-container-low px-space-md py-space-sm">
          <span className="font-label-sm text-label-sm text-on-surface-variant">Your share</span>
          <span className="font-currency-md text-currency-md text-primary">{formatMoney(myShare)}</span>
        </div>
      </div>

      {/* controls */}
      <div className="mt-space-md flex flex-col gap-space-sm">
        <div className="relative">
          <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-[20px] text-on-surface-variant" />
          <input className={cx(inputCls, "h-11 rounded-full border-transparent bg-surface-container-low pl-10")} placeholder="Search bookings, vendors, people" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex items-center justify-between gap-space-sm">
          <div className="flex gap-space-xs overflow-x-auto">
            {(
              [
                ["all", "All"],
                ["bookings", "Bookings"],
                ["payments", "Payments"],
                ["members", "Members"],
              ] as const
            ).map(([v, l]) => (
              <Chip key={v} selected={filter === v} onClick={() => setFilter(v)}>
                {l}
              </Chip>
            ))}
          </div>
          <select
            aria-label="Sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className="h-9 shrink-0 rounded-full border-none bg-surface-container-low px-3 font-label-md text-label-md text-on-surface-variant outline-none"
          >
            <option value="new">Newest</option>
            <option value="old">Oldest</option>
            <option value="amount">Amount</option>
          </select>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="mt-space-lg">
          <Empty icon="receipt_long" title={q || filter !== "all" ? "Nothing matches" : "No activity yet"} message={q || filter !== "all" ? "Try another filter." : "Bookings and payments show up here as they happen."} />
        </div>
      ) : null}

      <div className="mt-space-md flex flex-col gap-space-sm">
        {visible.map((b) => (
          <BlockCard key={b.key} b={b} open={expanded.has(b.key)} onToggle={() => toggle(b.key)} onDetails={b.expenseId && ledger.byExpenseId[b.expenseId] ? () => setSheet(b.expenseId!) : undefined} names={names} />
        ))}
      </div>

      <p className="mt-space-lg flex items-start gap-space-sm rounded-xl bg-surface-container p-space-md font-body-md text-body-md text-on-surface-variant">
        <Icon name="shield" className="text-[20px] text-primary" />
        Every line comes from the trip&apos;s append-only ledger — nothing is edited in place, and each update keeps who did it and when.
      </p>

      {sheet && ledger.byExpenseId[sheet] ? <ExpenseSheet expenseId={sheet} onClose={() => setSheet(null)} /> : null}
    </main>
  );
}

function BlockCard({ b, open, onToggle, onDetails, names }: { b: Block; open: boolean; onToggle: () => void; onDetails?: () => void; names: (id: string) => string }) {
  const trip = useTrip();
  const c = b.expenseId ? trip.ledger.byExpenseId[b.expenseId] : undefined;
  const updates = b.lines.length;
  return (
    <section id={`block-${b.key}`} className={cx("scroll-mt-20 overflow-hidden rounded-xl bg-surface-container-lowest shadow-sm", open && "ring-1 ring-primary/20")}>
      <button onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-space-md p-space-md text-left">
        <span className={cx("flex h-11 w-11 shrink-0 items-center justify-center rounded-full", b.status?.tone === "coral" ? "bg-error-container text-on-error-container" : "bg-surface-container text-primary")}>
          <Icon name={b.icon} className="text-[22px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-start justify-between gap-space-sm">
            <span className="min-w-0 truncate font-title-md text-title-md text-on-surface">{b.title}</span>
            {b.amountPaise !== undefined ? <span className="shrink-0 font-currency-md text-[16px] text-on-surface">{formatMoney(b.amountPaise)}</span> : null}
          </div>
          {b.sub ? <span className="truncate font-body-md text-[13px] text-on-surface-variant">{b.sub}</span> : null}
          <div className="mt-1 flex flex-wrap items-center gap-x-space-sm gap-y-1">
            {b.status ? <span className={cx("rounded-full px-2 py-0.5 font-label-sm text-label-sm", STATUS_TONE[b.status.tone])}>{b.status.label}</span> : null}
            {b.paidBy ? (
              <span className="flex items-center gap-1 font-label-sm text-label-sm text-primary">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" /> {b.paidBy}
              </span>
            ) : null}
            {b.date ? <span className="font-label-sm text-label-sm text-on-surface-variant">{formatDate(b.date)}</span> : null}
            <span className="ml-auto flex items-center gap-0.5 font-label-sm text-label-sm text-on-surface-variant">
              {updates} update{updates === 1 ? "" : "s"}
              <Icon name={open ? "expand_less" : "expand_more"} className="text-[18px]" />
            </span>
          </div>
        </div>
      </button>

      {open ? (
        <div className="flex flex-col gap-space-md border-t border-outline-variant/40 bg-surface-container-low/40 px-space-md pb-space-md pt-space-sm">
          {/* history, oldest first */}
          <ol className="relative flex flex-col gap-space-sm">
            <span className="absolute bottom-2 left-[13px] top-2 w-[2px] rounded-full bg-surface-container-highest" aria-hidden />
            {b.lines.map(({ e, d }) => (
              <li key={e.id} className="relative flex gap-space-sm">
                <span className={cx("relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", DOT[d.tone])}>
                  <Icon name={symbol(d.icon)} className="text-[15px]" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-start justify-between gap-space-sm">
                    <span className="font-title-md text-[14px] leading-5 text-on-surface">{d.title}</span>
                    {d.amountPaise !== undefined ? <span className="shrink-0 font-label-md text-label-md tabular-nums text-on-surface">{formatMoney(d.amountPaise)}</span> : null}
                  </div>
                  {d.detail ? <span className="font-label-md text-[12px] leading-4 text-on-surface-variant">{d.detail}</span> : null}
                  {d.changes?.length ? (
                    <div className="mt-1 flex flex-col gap-0.5 rounded-md bg-surface-container-lowest px-space-sm py-1">
                      {d.changes.map((ch, i) => (
                        <span key={i} className="font-label-sm text-label-sm text-on-surface-variant">
                          {ch.label}: <span className="line-through opacity-70">{ch.before}</span> → <span className="text-on-surface">{ch.after}</span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <span className="font-label-sm text-[11px] text-outline">
                    {formatRelative(e.ts)} · {names(e.actor)}
                  </span>
                </div>
              </li>
            ))}
          </ol>

          {/* who bears what */}
          {c && Object.keys(c.shares).length ? (
            <div className="flex flex-col gap-space-xs rounded-lg bg-surface-container-lowest p-space-sm">
              <span className="px-1 font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Who bears what</span>
              {Object.entries(c.shares).map(([pid, share]) => {
                const paid = c.netPaidByPayer[pid] ?? 0;
                return (
                  <div key={pid} className="flex items-center gap-space-sm px-1">
                    <Portrait name={trip.fullName(pid)} size={24} />
                    <span className="min-w-0 flex-1 truncate font-body-md text-[14px] text-on-surface">{trip.isMe(pid) ? "You" : trip.fullName(pid)}</span>
                    {paid ? <span className="font-label-sm text-label-sm text-primary">paid {formatMoney(paid)}</span> : null}
                    <span className="w-20 text-right font-label-md text-label-md tabular-nums text-on-surface">{formatMoney(share)}</span>
                  </div>
                );
              })}
            </div>
          ) : null}

          {onDetails ? (
            <button onClick={onDetails} className="flex h-10 items-center justify-center gap-1.5 rounded-lg bg-surface-container font-label-md text-label-md text-primary hover:bg-surface-container-high">
              <Icon name="receipt_long" className="text-[18px]" /> Details · cancel or record a refund
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default function ActivityPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Activity />
    </Suspense>
  );
}
