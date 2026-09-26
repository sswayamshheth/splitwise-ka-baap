"use client";

import { useMemo } from "react";

import { cx, Icon } from "@/components/app/kit";
import { useTrip } from "@/lib/client/trip";
import { categoryBudgets } from "@/lib/ledger/pool";
import type { ExpenseCategory } from "@/lib/ledger/types";
import { formatMoney } from "@/lib/money";
import { CATEGORY_ICON, ProgressBar } from "./common";

/** The group's budget vs what's planned and what's actually been spent (net of refunds). */
export function BudgetCard() {
  const trip = useTrip();
  const { state, ledger } = trip;
  const total = state.trip.budgetPaise;
  const cats = useMemo(() => categoryBudgets(state), [state]);
  const spentBy = useMemo(() => {
    const m = new Map<ExpenseCategory, number>();
    for (const c of ledger.expenses) m.set(c.expense.category, (m.get(c.expense.category) ?? 0) + c.effectivePaise);
    return m;
  }, [ledger]);
  if (!total) return null;
  const spent = ledger.totals.spendPaise;
  const planned = ledger.budget.estimatedPaise;
  const left = total - spent;
  const inSplit = new Set(cats.map((c) => c.category));
  const unbudgeted = [...spentBy.entries()].filter(([cat, v]) => !inSplit.has(cat) && v > 0).reduce((s, [, v]) => s + v, 0);

  return (
    <section className="flex flex-col gap-space-md rounded-xl bg-surface-container-lowest p-space-lg shadow-sm">
      <div className="flex items-start justify-between">
        <div className="flex flex-col">
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-primary">Group budget</span>
          <span className="font-currency-display text-currency-display text-on-surface">{formatMoney(total)}</span>
        </div>
        <span className={cx("rounded-full px-2.5 py-1 font-label-md text-label-md", left >= 0 ? "bg-primary-fixed/50 text-on-primary-fixed-variant" : "bg-error-container text-on-error-container")}>
          {left >= 0 ? `${formatMoney(left)} left` : `${formatMoney(-left)} over`}
        </span>
      </div>
      <ProgressBar value={spent / total} tone={spent > total ? "error" : "primary"} />
      <div className="grid grid-cols-2 gap-space-sm">
        <div className="rounded-lg bg-surface-container-low px-space-md py-space-sm">
          <span className="font-label-sm text-label-sm text-on-surface-variant">Spent so far</span>
          <p className="font-title-md text-title-md text-on-surface">{formatMoney(spent)}</p>
        </div>
        <div className="rounded-lg bg-surface-container-low px-space-md py-space-sm">
          <span className="font-label-sm text-label-sm text-on-surface-variant">Planned in itinerary</span>
          <p className={cx("font-title-md text-title-md", planned > total ? "text-error" : "text-on-surface")}>{formatMoney(planned)}</p>
        </div>
      </div>
      {cats.length ? (
        <div className="flex flex-col gap-space-sm">
          {cats.map((c) => {
            const used = spentBy.get(c.category) ?? 0;
            const ratio = c.paise ? used / c.paise : 0;
            return (
              <div key={c.category} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-space-sm">
                  <span className="flex items-center gap-1.5 font-title-md text-[14px] text-on-surface">
                    <Icon name={CATEGORY_ICON[c.category]} className="text-[18px] text-primary" />
                    {c.category}
                    <span className="font-label-sm text-label-sm text-on-surface-variant">{c.percent}%</span>
                  </span>
                  <span className="font-label-md text-label-md text-on-surface-variant">
                    <span className={cx("font-semibold", ratio > 1 ? "text-error" : "text-on-surface")}>{formatMoney(used)}</span> / {formatMoney(c.paise)}
                  </span>
                </div>
                <ProgressBar value={ratio} tone={ratio > 1 ? "error" : ratio > 0.85 ? "secondary" : "primary"} />
              </div>
            );
          })}
          {unbudgeted ? <span className="font-label-sm text-label-sm text-on-surface-variant">{formatMoney(unbudgeted)} spent in categories without a budget share</span> : null}
        </div>
      ) : null}
    </section>
  );
}
