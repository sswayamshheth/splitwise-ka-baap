"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { cx, Icon, Spinner } from "@/components/app/kit";
import { api } from "@/lib/client/api";
import { tripCover } from "@/lib/covers";
import { formatDate, formatDateRange } from "@/lib/dates";
import { formatMoney, sumPaise } from "@/lib/money";

type Line = { expenseId: string; title: string; vendor?: string; category: string; date: string; status: "active" | "cancelled"; sharePaise: number; paidPaise: number; fromPool: boolean };
type Statement = {
  tripId: string;
  name: string;
  destination: string;
  startDate: string;
  endDate: string;
  year: number;
  phase: "ongoing" | "upcoming" | "past";
  sharePaise: number;
  paidPaise: number;
  settledOutPaise: number;
  settledInPaise: number;
  poolPaise: number;
  netPaise: number;
  byCategory: Record<string, number>;
  lines: Line[];
};

type Sort = "date" | "amount";

const CATEGORY_ICONS: Record<string, string> = {
  Stay: "hotel",
  Transport: "flight",
  Activity: "kayaking",
  Food: "restaurant",
  "Local travel": "directions_car",
  Shopping: "shopping_bag",
  Other: "receipt_long",
};

export default function LedgerPage() {
  const [statements, setStatements] = useState<Statement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState<number | "all">("all");
  const [sort, setSort] = useState<Sort>("date");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api<{ statements: Statement[] }>("/api/statements")
      .then((r) => setStatements(r.statements))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load your ledger"));
  }, []);

  const years = useMemo(() => [...new Set((statements ?? []).map((s) => s.year))].sort((a, b) => b - a), [statements]);
  const shown = useMemo(() => {
    const list = (statements ?? []).filter((s) => year === "all" || s.year === year);
    return [...list].sort((a, b) => (sort === "amount" ? b.sharePaise - a.sharePaise : a.startDate < b.startDate ? 1 : -1));
  }, [statements, year, sort]);

  const totals = useMemo(
    () => ({
      share: sumPaise(shown.map((s) => s.sharePaise)),
      paid: sumPaise(shown.map((s) => s.paidPaise)),
      pool: sumPaise(shown.map((s) => s.poolPaise)),
      net: sumPaise(shown.map((s) => s.netPaise)),
    }),
    [shown],
  );
  const categories = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const s of shown) for (const [c, v] of Object.entries(s.byCategory)) acc[c] = (acc[c] ?? 0) + v;
    const rows = Object.entries(acc)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    const total = Math.max(1, sumPaise(rows.map(([, v]) => v)));
    return rows.map(([category, paise]) => ({ category, paise, fraction: paise / total }));
  }, [shown]);

  // How much of what I bore I've already covered (paid vendors + pool money spent + settlements sent − received).
  const covered = totals.share + totals.net;
  const coveredPct = totals.share > 0 ? Math.max(0, Math.min(100, Math.round((covered / totals.share) * 100))) : 0;

  return (
    <main className="mx-auto flex w-full max-w-[520px] flex-col pb-32">
      {/* Pill tabs: period */}
      <div className="w-full px-margin pb-space-xs pt-space-sm">
        <div className="no-scrollbar flex items-center gap-space-xs overflow-x-auto py-1">
          <PillTab active={year === "all"} onClick={() => setYear("all")}>
            All time
          </PillTab>
          {years.map((y) => (
            <PillTab key={y} active={year === y} onClick={() => setYear(y)}>
              {y}
            </PillTab>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-space-lg px-margin pb-space-xl pt-space-sm">
        {error ? (
          <div className="flex flex-col items-center gap-space-sm rounded-xl bg-surface-container-low p-space-xl text-center">
            <Icon name="cloud_off" className="text-[36px] text-primary" />
            <p className="font-title-md text-title-md text-on-surface">Couldn&apos;t load your ledger</p>
            <p className="font-body-md text-body-md text-on-surface-variant">{error}</p>
          </div>
        ) : !statements ? (
          <Spinner label="Adding it up" />
        ) : statements.length === 0 ? (
          <div className="flex flex-col items-center gap-space-sm rounded-xl bg-surface-container-low p-space-xl text-center">
            <Icon name="receipt_long" className="text-[36px] text-primary" />
            <p className="font-title-md text-title-md text-on-surface">Nothing yet</p>
            <p className="font-body-md text-body-md text-on-surface-variant">Once you&apos;re on a trip, your share of every expense shows up here.</p>
          </div>
        ) : (
          <>
            {/* Hero: my share for the period */}
            <div className="flex flex-col gap-space-md rounded-xl bg-surface-container-lowest p-space-lg shadow-sm">
              <div className="flex items-start justify-between">
                <div className="flex flex-col">
                  <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Your share · {year === "all" ? "all time" : year}</span>
                  <span className="mt-0.5 font-display-lg-mobile text-display-lg-mobile font-normal text-on-surface">{formatMoney(totals.share)}</span>
                </div>
                <div className="flex flex-col items-end text-right">
                  <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Trips</span>
                  <span className="mt-0.5 font-currency-md text-currency-md text-on-surface">{shown.length}</span>
                </div>
              </div>
              <div className="flex flex-col gap-1.5 pt-1">
                <div className="h-2 w-full overflow-hidden rounded-full bg-surface-container">
                  <div className="h-full rounded-full bg-primary-container transition-all duration-700" style={{ width: `${coveredPct}%` }} />
                </div>
                <div className="flex items-center justify-between text-on-surface-variant">
                  <span className="font-label-sm text-label-sm">{coveredPct}% already covered by you</span>
                  <span className="font-label-sm text-label-sm">
                    {totals.net > 0 ? `${formatMoney(totals.net)} owed to you` : totals.net < 0 ? `${formatMoney(-totals.net)} still to pay` : "All square"}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-space-sm">
                <div className="flex items-center gap-space-sm rounded-lg bg-surface-container-low px-3.5 py-2.5">
                  <Icon name="storefront" className="text-[18px] text-primary" />
                  <div className="flex flex-col">
                    <span className="font-label-sm text-label-sm text-on-surface-variant">Paid to vendors</span>
                    <span className="font-title-md text-title-md text-on-surface">{formatMoney(totals.paid)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-space-sm rounded-lg bg-surface-container-low px-3.5 py-2.5">
                  <Icon name="savings" className="text-[18px] text-primary" />
                  <div className="flex flex-col">
                    <span className="font-label-sm text-label-sm text-on-surface-variant">Into trip pools</span>
                    <span className="font-title-md text-title-md text-on-surface">{formatMoney(totals.pool)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Category milestones */}
            {categories.length ? (
              <div className="flex flex-col gap-space-lg rounded-xl bg-surface-container-lowest p-space-lg shadow-sm">
                <div className="flex items-center justify-between">
                  <h2 className="font-title-lg text-title-lg text-on-surface">Where your money went</h2>
                  <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{categories.length} categories</span>
                </div>
                <div className="flex flex-col gap-space-lg">
                  {categories.map((c) => (
                    <div key={c.category} className="flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Icon name={CATEGORY_ICONS[c.category] ?? "receipt_long"} className="text-[18px] text-primary" />
                          <span className="font-title-md text-title-md text-on-surface">{c.category}</span>
                        </div>
                        <span className="font-currency-md text-currency-md text-on-surface">{formatMoney(c.paise)}</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container">
                        <div className="h-full rounded-full bg-primary-container" style={{ width: `${Math.max(3, c.fraction * 100)}%` }} />
                      </div>
                      <span className="font-label-sm text-label-sm text-on-surface-variant">{Math.round(c.fraction * 100)}% of your share</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Trips */}
            <div className="flex flex-col gap-space-sm">
              <div className="flex items-center justify-between">
                <h2 className="font-headline-sm text-headline-sm text-on-surface">Trip by trip</h2>
                <div className="flex gap-space-xs">
                  <PillTab active={sort === "date"} onClick={() => setSort("date")}>
                    Date
                  </PillTab>
                  <PillTab active={sort === "amount"} onClick={() => setSort("amount")}>
                    Amount
                  </PillTab>
                </div>
              </div>

              {shown.map((s) => {
                const isOpen = open === s.tripId;
                return (
                  <div key={s.tripId} className="flex flex-col rounded-xl bg-surface-container-lowest shadow-sm">
                    <button className="flex items-center gap-3.5 p-3.5 text-left" onClick={() => setOpen(isOpen ? null : s.tripId)} aria-expanded={isOpen}>
                      <div className="h-16 w-16 shrink-0 rounded-lg bg-surface-container-high bg-cover bg-center" style={{ backgroundImage: `url("${tripCover(s.destination, s.tripId)}")` }} />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-headline-sm text-title-lg text-on-surface">{s.name}</span>
                        <span className="truncate font-label-md text-label-md text-on-surface-variant">
                          {s.destination.split(",")[0]} · {formatDateRange(s.startDate, s.endDate)}
                        </span>
                        <span className={cx("mt-1 font-label-sm text-label-sm font-semibold", s.netPaise > 0 ? "text-primary" : s.netPaise < 0 ? "text-error" : "text-on-surface-variant")}>
                          {s.netPaise > 0 ? `Owed ${formatMoney(s.netPaise)}` : s.netPaise < 0 ? `You owe ${formatMoney(-s.netPaise)}` : "Settled"}
                          {s.poolPaise ? ` · pool ${formatMoney(s.poolPaise)}` : ""}
                        </span>
                      </div>
                      <div className="flex shrink-0 flex-col items-end">
                        <span className="font-currency-md text-currency-md text-on-surface">{formatMoney(s.sharePaise)}</span>
                        <span className="font-label-sm text-label-sm text-on-surface-variant">your share</span>
                        <Icon name={isOpen ? "expand_less" : "expand_more"} className="text-[20px] text-on-surface-variant/60" />
                      </div>
                    </button>
                    {isOpen ? (
                      <div className="flex flex-col gap-2 border-t border-outline-variant/30 p-3.5">
                        {s.lines.length === 0 ? <p className="font-body-md text-body-md text-on-surface-variant">No expenses involving you yet.</p> : null}
                        {s.lines.map((l) => (
                          <div key={l.expenseId} className="flex items-start gap-3 rounded-lg bg-surface-container-low/60 p-3">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-container text-primary">
                              <Icon name={CATEGORY_ICONS[l.category] ?? "receipt_long"} className="text-[20px]" />
                            </div>
                            <div className="flex min-w-0 flex-1 flex-col">
                              <div className="flex items-start justify-between gap-2">
                                <span className={cx("truncate font-title-md text-title-md text-on-surface", l.status === "cancelled" && "line-through opacity-60")}>{l.title}</span>
                                <span className="shrink-0 font-currency-md text-title-md text-on-surface">{formatMoney(l.sharePaise)}</span>
                              </div>
                              <span className="truncate font-label-md text-label-md text-on-surface-variant">
                                {formatDate(l.date)}
                                {l.vendor ? ` · ${l.vendor}` : ""} · {l.category}
                              </span>
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                {l.paidPaise ? (
                                  <span className="flex items-center gap-1 font-label-sm text-label-sm text-primary">
                                    <span className="h-1.5 w-1.5 rounded-full bg-primary" /> You paid {formatMoney(l.paidPaise)}
                                  </span>
                                ) : null}
                                {l.fromPool ? <span className="rounded-full bg-tertiary-fixed px-2 py-0.5 font-label-sm text-label-sm text-on-tertiary-fixed-variant">From trip pool</span> : null}
                                {l.status === "cancelled" ? <span className="rounded-full bg-error-container px-2 py-0.5 font-label-sm text-label-sm text-on-error-container">Cancelled</span> : null}
                              </div>
                            </div>
                          </div>
                        ))}
                        <Link href={`/trips/${s.tripId}`} className="flex items-center justify-center gap-1 pt-1 font-title-md text-title-md text-primary">
                          Open trip <Icon name="arrow_forward" className="text-[18px]" />
                        </Link>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function PillTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "whitespace-nowrap rounded-full px-4 py-2 font-label-md text-label-md transition-colors",
        active ? "bg-primary-container text-on-primary shadow-sm" : "bg-surface-container text-on-surface-variant hover:bg-surface-variant",
      )}
    >
      {children}
    </button>
  );
}
