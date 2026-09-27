import { sumPaise, type Paise } from "@/lib/money";
import type { Ledger } from "./engine";
import { EXPENSE_CATEGORIES, type ExpenseCategory, type ParticipantId, type TripState } from "./types";

/**
 * One person's own ledger for the trip: what the trip cost them (their share
 * of every booking), what they handed vendors, grouped by category. Every
 * figure is read straight off the computed ledger — nothing is re-derived.
 */

export type PersonalItem = {
  expenseId: string;
  title: string;
  date: string;
  status: "active" | "cancelled";
  sharePaise: Paise;
  /** What they paid the vendor for it, net of refunds they received. */
  paidPaise: Paise;
  /** Refund the vendor returned on this booking (to whoever paid). */
  refundedPaise: Paise;
  /** They dropped out of this booking. */
  withdrew: boolean;
};

export type PersonalCategory = { category: ExpenseCategory; sharePaise: Paise; paidPaise: Paise; items: PersonalItem[] };

export type PersonalLedger = {
  participantId: ParticipantId;
  totalSharePaise: Paise;
  paidPaise: Paise;
  netPaise: Paise;
  categories: PersonalCategory[];
  settlements: { direction: "sent" | "received"; counterparty: ParticipantId; amountPaise: Paise; status: "confirmed" | "initiated" }[];
};

export function personalLedger(state: TripState, ledger: Ledger, pid: ParticipantId): PersonalLedger {
  const byCat = new Map<ExpenseCategory, PersonalCategory>();
  for (const c of ledger.expenses) {
    const share = c.shares[pid] ?? 0;
    const paid = c.netPaidByPayer[pid] ?? 0;
    if (share === 0 && paid === 0) continue;
    const x = c.expense;
    const category = (EXPENSE_CATEGORIES as string[]).includes(x.category) ? x.category : "Other";
    let cat = byCat.get(category);
    if (!cat) byCat.set(category, (cat = { category, sharePaise: 0, paidPaise: 0, items: [] }));
    cat.items.push({
      expenseId: x.id,
      title: x.title,
      date: x.date,
      status: x.status,
      sharePaise: share,
      paidPaise: paid,
      refundedPaise: c.refundedPaise,
      withdrew: (x.withdrawals ?? []).some((w) => w.participantId === pid),
    });
  }
  const categories = [...byCat.values()].map((cat) => ({
    ...cat,
    sharePaise: sumPaise(cat.items.map((i) => i.sharePaise)),
    paidPaise: sumPaise(cat.items.map((i) => i.paidPaise)),
    items: cat.items.sort((a, b) => b.sharePaise - a.sharePaise || a.date.localeCompare(b.date)),
  }));
  categories.sort((a, b) => b.sharePaise - a.sharePaise || b.paidPaise - a.paidPaise);

  const settlements: PersonalLedger["settlements"] = [];
  for (const s of state.settlements) {
    if (s.status === "cancelled") continue;
    if (s.from === pid) settlements.push({ direction: "sent", counterparty: s.to, amountPaise: s.amountPaise, status: s.status });
    if (s.to === pid) settlements.push({ direction: "received", counterparty: s.from, amountPaise: s.amountPaise, status: s.status });
  }

  return {
    participantId: pid,
    totalSharePaise: sumPaise(categories.map((c) => c.sharePaise)),
    paidPaise: sumPaise(categories.map((c) => c.paidPaise)),
    netPaise: ledger.balances[pid]?.netPaise ?? 0,
    categories,
    settlements,
  };
}
