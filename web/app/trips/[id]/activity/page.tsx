"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import { Chip, cx, Empty, Icon, inputCls, Label, Spinner } from "@/components/app/kit";
import { CATEGORY_ICON, ChronicleItem } from "@/components/app/trip/common";
import { ExpenseSheet } from "@/components/app/trip/ExpenseSheet";
import { useTrip } from "@/lib/client/trip";
import { daysBetween, formatDate, todayIso } from "@/lib/dates";
import { buildNameLookup, describeEvent } from "@/lib/ledger/describe";
import type { ExpenseCategory } from "@/lib/ledger/types";
import { formatMoney } from "@/lib/money";

type Sort = "new" | "old" | "high" | "low";

/**
 * Everything that happened with money on this trip. Expenses can be sorted
 * and filtered by who paid, vendor, category or whether I'm involved; the
 * audit trail lists every ledger event, newest first.
 */
function Activity() {
  const trip = useTrip();
  const params = useSearchParams();
  const [tab, setTab] = useState<"expenses" | "audit">(params.get("tab") === "audit" ? "audit" : "expenses");
  const [open, setOpen] = useState<string | null>(params.get("expense"));
  const [sort, setSort] = useState<Sort>("new");
  const [payer, setPayer] = useState<string | null>(null);
  const [vendor, setVendor] = useState<string | null>(null);
  const [category, setCategory] = useState<ExpenseCategory | null>(null);
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const { ledger, meId } = trip;
  const vendors = useMemo(() => [...new Set(ledger.expenses.map((c) => c.expense.vendor?.trim()).filter((v): v is string => !!v))].sort(), [ledger]);
  const categories = useMemo(() => [...new Set(ledger.expenses.map((c) => c.expense.category))], [ledger]);
  const payers = useMemo(() => [...new Set(ledger.expenses.flatMap((c) => c.expense.payers.map((p) => p.participantId)))], [ledger]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = ledger.expenses.filter((c) => {
      const e = c.expense;
      if (payer && !e.payers.some((p) => p.participantId === payer)) return false;
      if (vendor && e.vendor?.trim() !== vendor) return false;
      if (category && e.category !== category) return false;
      if (mine && !(c.shares[meId] || c.netPaidByPayer[meId])) return false;
      if (needle && !`${e.title} ${e.vendor ?? ""} ${e.notes ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    return list.sort((a, b) => {
      if (sort === "high") return b.expense.amountPaise - a.expense.amountPaise;
      if (sort === "low") return a.expense.amountPaise - b.expense.amountPaise;
      const d = a.expense.date.localeCompare(b.expense.date);
      return sort === "new" ? -d : d;
    });
  }, [ledger, payer, vendor, category, mine, q, sort, meId]);

  const groups = useMemo(() => {
    if (sort === "high" || sort === "low") return [["", rows] as const];
    const m = new Map<string, typeof rows>();
    for (const r of rows) m.set(r.expense.date, [...(m.get(r.expense.date) ?? []), r]);
    return [...m.entries()];
  }, [rows, sort]);

  const total = rows.reduce((s, c) => s + c.effectivePaise, 0);
  const myTotal = rows.reduce((s, c) => s + (c.shares[meId] ?? 0), 0);
  const filtered = !!(payer || vendor || category || mine || q.trim());
  const dayLabel = (iso: string) => {
    if (iso === todayIso()) return "Today";
    const d = daysBetween(trip.state.trip.startDate, iso);
    return d >= 0 && iso <= trip.state.trip.endDate ? `Day ${d + 1}` : iso < trip.state.trip.startDate ? "Before the trip" : "After the trip";
  };

  return (
    <main className="mx-auto w-full max-w-[520px] flex-1 px-margin pb-32 pt-space-md">
      {/* sub-navigation (design pill tabs) */}
      <div className="flex items-center gap-space-sm py-space-xs">
        {(
          [
            ["expenses", "Expenses", "receipt_long"],
            ["audit", "Ledger chronicle", "history"],
          ] as const
        ).map(([v, l, icon]) => (
          <button
            key={v}
            onClick={() => setTab(v)}
            className={cx(
              "flex items-center gap-1 whitespace-nowrap rounded-full px-space-md py-space-xs font-label-md text-label-md transition-colors",
              tab === v ? "bg-primary-container text-on-primary shadow-sm" : "bg-surface-container-low text-on-surface-variant hover:bg-surface-variant",
            )}
          >
            <Icon name={icon} className="text-[16px]" />
            {l}
          </button>
        ))}
      </div>

      {tab === "audit" ? (
        <AuditTrail />
      ) : (
        <>
          {/* shared ledger hero */}
          <div className="mt-space-md flex flex-col gap-space-md rounded-xl bg-surface-container-lowest p-space-lg shadow-sm">
            <div className="flex items-start justify-between">
              <div className="flex flex-col">
                <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{filtered ? "Matching entries" : "Shared ledger"}</span>
                <div className="mt-space-xs flex items-baseline gap-space-sm">
                  <span className="font-currency-display text-currency-display text-on-surface">{formatMoney(total)}</span>
                  <span className="font-body-md text-body-md text-on-surface-variant">total logged</span>
                </div>
              </div>
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-container text-primary">
                <Icon name="receipt_long" />
              </span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-surface-container-low/80 px-space-md py-space-sm">
              <span className="flex items-center gap-1.5 font-label-md text-label-md text-on-surface">
                <Icon name="person" className="text-[18px] text-primary" /> Your share
              </span>
              <span className="font-currency-md text-[15px] text-primary">{formatMoney(myTotal)}</span>
            </div>
            <span className="font-label-sm text-label-sm text-on-surface-variant">
              {rows.length} expense{rows.length === 1 ? "" : "s"} · net of refunds
            </span>
          </div>

          {/* search, sort, filters */}
          <div className="mt-space-md flex flex-col gap-space-sm">
            <div className="flex items-center gap-space-sm">
              <div className="relative flex-1">
                <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-[20px] text-on-surface-variant" />
                <input className={cx(inputCls, "h-11 rounded-full border-transparent bg-surface-container-low pl-10")} placeholder="Search expenses" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <button onClick={() => setShowFilters(!showFilters)} className={cx("flex h-11 items-center gap-1 rounded-full px-space-md font-label-md text-label-md", showFilters || filtered ? "bg-primary-container text-on-primary" : "bg-surface-container-low text-primary")}>
                <Icon name="tune" className="text-[18px]" /> Filter
              </button>
            </div>
            <div className="flex gap-space-xs overflow-x-auto pb-1">
              {(
                [
                  ["new", "Newest"],
                  ["old", "Oldest"],
                  ["high", "Highest"],
                  ["low", "Lowest"],
                ] as const
              ).map(([v, l]) => (
                <Chip key={v} selected={sort === v} onClick={() => setSort(v)}>
                  {l}
                </Chip>
              ))}
              <Chip selected={mine} icon="person" onClick={() => setMine(!mine)}>
                Involves me
              </Chip>
            </div>
            {showFilters ? (
              <div className="flex flex-col gap-space-sm rounded-xl bg-surface-container-low p-space-md">
                <FilterRow label="Paid by" options={payers.map((id) => [id, trip.short(id)] as const)} value={payer} onChange={setPayer} />
                {vendors.length ? <FilterRow label="Vendor" options={vendors.map((v) => [v, v] as const)} value={vendor} onChange={setVendor} /> : null}
                <FilterRow label="Category" options={categories.map((c) => [c, c] as const)} value={category} onChange={(v) => setCategory(v as ExpenseCategory | null)} />
                {filtered ? (
                  <button
                    className="self-start font-label-md text-label-md text-primary"
                    onClick={() => {
                      setPayer(null);
                      setVendor(null);
                      setCategory(null);
                      setMine(false);
                      setQ("");
                    }}
                  >
                    Clear all filters
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          {rows.length === 0 ? (
            <div className="mt-space-lg">
              <Empty icon="receipt_long" title={filtered ? "Nothing matches" : "No expenses yet"} message={filtered ? "Try clearing a filter." : "Payments recorded from the Money tab show up here."} />
            </div>
          ) : null}

          {groups.map(([date, list]) => (
            <section key={date || "all"} className="mt-space-lg flex flex-col gap-space-sm">
              {date ? (
                <div className="flex items-baseline justify-between">
                  <h3 className="flex items-baseline gap-space-xs font-headline-sm text-headline-sm text-on-surface">
                    {dayLabel(date)}
                    <span className="font-body-md text-body-md text-on-surface-variant">· {formatDate(date)}</span>
                  </h3>
                  <span className="font-label-sm text-label-sm text-on-surface-variant">
                    {list.length} entr{list.length === 1 ? "y" : "ies"}
                  </span>
                </div>
              ) : null}
              {list.map((c) => {
                const e = c.expense;
                const myShare = c.shares[meId] ?? 0;
                const ways = Object.keys(c.shares).length;
                const highlighted = e.status === "cancelled" || c.refundedPaise > 0 || !!e.withdrawals?.length;
                const perPerson = ways ? Math.round(c.effectivePaise / ways) : c.effectivePaise;
                return (
                  <button
                    key={e.id}
                    onClick={() => setOpen(e.id)}
                    className={cx(
                      "flex w-full items-start gap-space-md rounded-xl p-space-md text-left transition-shadow hover:shadow-md",
                      highlighted ? "bg-tertiary-fixed/60" : "bg-surface-container-lowest shadow-sm",
                    )}
                  >
                    <span className={cx("flex h-12 w-12 shrink-0 items-center justify-center rounded-full", e.status === "cancelled" ? "bg-tertiary text-on-tertiary" : "bg-surface-container text-primary")}>
                      <Icon name={e.status === "cancelled" ? "event_busy" : CATEGORY_ICON[e.category]} />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-start justify-between gap-space-sm">
                        <span className="font-title-lg text-title-lg text-on-surface">{e.title}</span>
                        <span className="flex shrink-0 flex-col items-end">
                          <span className="font-currency-md text-currency-md text-on-surface">{formatMoney(c.effectivePaise)}</span>
                          {c.effectivePaise !== e.amountPaise ? (
                            <span className="font-label-sm text-label-sm text-on-surface-variant line-through">{formatMoney(e.amountPaise)}</span>
                          ) : (
                            <span className="font-label-sm text-label-sm text-on-surface-variant">{formatMoney(perPerson)} / person</span>
                          )}
                        </span>
                      </div>
                      {highlighted ? (
                        <span className="inline-flex w-fit items-center gap-1 rounded-full bg-surface-container-lowest/70 px-2 py-0.5 font-label-sm text-label-sm text-on-tertiary-fixed-variant">
                          <span className="h-1.5 w-1.5 rounded-full bg-secondary-container" />
                          {e.status === "cancelled" ? "Cancelled under the vendor's policy" : e.withdrawals?.length ? `${e.withdrawals.length} dropped out` : `${formatMoney(c.refundedPaise)} refunded`}
                        </span>
                      ) : null}
                      <span className="font-body-md text-body-md text-on-surface-variant">
                        Split {ways} way{ways === 1 ? "" : "s"} ({e.category})
                        {e.vendor ? ` · ${e.vendor}` : ""}
                        {!date ? ` · ${formatDate(e.date)}` : ""}
                      </span>
                      <div className="flex items-center justify-between gap-space-sm">
                        <span className="flex items-center gap-1.5 font-label-md text-label-md text-primary">
                          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                          {e.fundedFromPool ? "Paid from the trip pool" : `${e.payers.map((p) => trip.short(p.participantId)).join(" & ")} paid`}
                        </span>
                        <span className="font-label-sm text-label-sm text-on-surface-variant">{myShare ? `you ${formatMoney(myShare)}` : "not you"}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </section>
          ))}

          <div className="mt-space-lg flex gap-space-sm rounded-xl bg-surface-container p-space-md">
            <Icon name="shield" className="text-[20px] text-primary" />
            <p className="font-body-md text-body-md text-on-surface-variant">Every entry is derived from the append-only ledger. Tap one to see exactly how each person&apos;s share is worked out.</p>
          </div>
        </>
      )}
      {open && trip.ledger.byExpenseId[open] ? <ExpenseSheet expenseId={open} onClose={() => setOpen(null)} /> : null}
    </main>
  );
}

function FilterRow({ label, options, value, onChange }: { label: string; options: readonly (readonly [string, string])[]; value: string | null; onChange: (v: string | null) => void }) {
  return (
    <div className="flex flex-col gap-space-xs">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-space-xs">
        <Chip selected={!value} onClick={() => onChange(null)}>
          Any
        </Chip>
        {options.map(([v, l]) => (
          <Chip key={v} selected={value === v} onClick={() => onChange(value === v ? null : v)}>
            {l}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function AuditTrail() {
  const trip = useTrip();
  const names = useMemo(() => buildNameLookup(trip.events, trip.meId), [trip.events, trip.meId]);
  const settlements = useMemo(() => new Map(trip.state.settlements.map((s) => [s.id, s])), [trip.state.settlements]);
  const [kind, setKind] = useState<string | null>(null);
  const all = useMemo(() => [...trip.events].reverse().map((e) => ({ e, d: describeEvent(e, names, { settlements }) })), [trip.events, names, settlements]);
  const kinds = [...new Set(all.map((x) => x.d.kind))];
  const list = kind ? all.filter((x) => x.d.kind === kind) : all;
  return (
    <div className="mt-space-md flex flex-col gap-space-md">
      <div className="flex flex-col gap-space-xs">
        <span className="flex items-center gap-1.5 font-label-sm text-label-sm uppercase tracking-wider text-primary">
          <Icon name="history_edu" className="text-[16px]" /> Ledger chronicle
        </span>
        <h2 className="font-headline-lg text-headline-lg text-on-surface">Every change, in order</h2>
        <p className="font-body-md text-body-md text-on-surface-variant">
          {trip.events.length} events, append-only. Nothing is edited in place — every balance on this trip is replayed from this list, and each line carries who did it and when.
        </p>
      </div>
      <div className="flex gap-space-xs overflow-x-auto pb-1">
        <Chip selected={!kind} onClick={() => setKind(null)}>
          All
        </Chip>
        {kinds.map((k) => (
          <Chip key={k} selected={kind === k} onClick={() => setKind(kind === k ? null : k)}>
            {k}
          </Chip>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <Label>Chronicle</Label>
        <span className="font-label-sm text-label-sm text-primary">{list.length} events accounted</span>
      </div>
      <div className="relative flex flex-col gap-space-md">
        <div className="absolute bottom-4 left-[11px] top-3 w-[2px] rounded-full bg-surface-container-highest" />
        {list.map(({ e, d }) => (
          <ChronicleItem key={e.id} d={d} ts={e.ts} actor={names(e.actor)} />
        ))}
      </div>
    </div>
  );
}

export default function ActivityPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Activity />
    </Suspense>
  );
}
