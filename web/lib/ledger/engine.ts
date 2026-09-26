import { allocate, sumPaise, type Paise } from "@/lib/money";
import { computeBudget, type Budget } from "./budget";
import { minimiseSettlement, type Transfer } from "./settlement";
import type { ExpenseView, ParticipantId, RefundData, SettlementData, TripState } from "./types";

/**
 * Derives every member-to-member number from the replayed trip state.
 * All arithmetic is integer paise; every allocation sums exactly, so the
 * invariant  Σ paid − Σ shares = 0  holds after any sequence of events.
 *
 * What the group owes vendors is a different relationship and is tracked
 * separately (see `vendors` below and lib/ledger/budget.ts).
 */

export type ExpenseComputed = {
  expense: ExpenseView;
  refunds: RefundData[];
  refundedPaise: Paise;
  /** amount − refunds: what the group actually ended up paying for this booking. */
  effectivePaise: Paise;
  /** Derived share per participant of the *effective* amount. */
  shares: Record<ParticipantId, Paise>;
  /** Shares as they would have been before any refund — used to explain refund routing. */
  grossShares: Record<ParticipantId, Paise>;
  /** Net contribution per payer after refunds they received are deducted. */
  netPaidByPayer: Record<ParticipantId, Paise>;
  /** True when shares had to fall back to payers because nobody participates. */
  orphaned: boolean;
};

export type ParticipantBalance = {
  participantId: ParticipantId;
  /** Money handed to vendors (sum of payer amounts on all non-deleted expenses). */
  paidPaise: Paise;
  /** Refunds this person received back from vendors. */
  refundsReceivedPaise: Paise;
  /** Sum of this person's derived shares across all expenses. */
  sharePaise: Paise;
  /** Confirmed settlements sent to other members. */
  settledOutPaise: Paise;
  /** Confirmed settlements received from other members. */
  settledInPaise: Paise;
  /** Initiated but unconfirmed settlements, net (sent − received). */
  pendingPaise: Paise;
  /** Money put into the trip kitty up front (tracked, not yet spent). */
  contributedPaise: Paise;
  /** paid − refunds + settledOut − settledIn − share. Positive = is owed. */
  netPaise: Paise;
  /** net adjusted as if pending settlements confirm. Drives recommendations. */
  provisionalNetPaise: Paise;
};

export type VendorLine = {
  vendor: string;
  committedPaise: Paise;
  paidPaise: Paise;
  outstandingPaise: Paise;
  itemIds: string[];
};

export type Ledger = {
  expenses: ExpenseComputed[];
  byExpenseId: Record<string, ExpenseComputed>;
  balances: Record<ParticipantId, ParticipantBalance>;
  budget: Budget;
  vendors: VendorLine[];
  totals: {
    grossPaise: Paise;
    refundedPaise: Paise;
    spendPaise: Paise;
    activeCount: number;
    cancelledCount: number;
    contributionsPaise: Paise;
    discountPaise: Paise;
  };
  pendingSettlements: SettlementData[];
  confirmedSettlements: SettlementData[];
  /** Recommended transfers to settle the trip from the provisional nets. */
  transfers: Transfer[];
  /** How many transfers the naive pairwise approach would need. */
  naiveTransferCount: number;
  /** Should always be 0. Surfaced so the UI can prove reconciliation. */
  reconciliationPaise: Paise;
};

export function computeExpense(expense: ExpenseView, refunds: RefundData[]): ExpenseComputed {
  const own = refunds.filter((r) => r.expenseId === expense.id);
  const refundedPaise = sumPaise(own.map((r) => r.amountPaise));
  const effectivePaise = Math.max(0, expense.amountPaise - refundedPaise);

  const shares: Record<ParticipantId, Paise> = {};
  const grossShares: Record<ParticipantId, Paise> = {};
  const add = (into: Record<ParticipantId, Paise>, id: ParticipantId, amount: Paise) => {
    into[id] = (into[id] ?? 0) + amount;
  };

  // People who dropped out keep a fixed liability (the part of their seat the
  // vendor did not refund). That is carved out first; the rest is split by
  // weight among the people still on the booking.
  const withdrawals = expense.withdrawals ?? [];
  const fixedEffective = carve(effectivePaise, withdrawals.map((w) => w.retainedPaise));
  const fixedGross = carve(expense.amountPaise, withdrawals.map((w) => w.retainedPaise + w.refundPaise));
  withdrawals.forEach((w, i) => {
    if (fixedEffective[i]) add(shares, w.participantId, fixedEffective[i]);
    if (fixedGross[i]) add(grossShares, w.participantId, fixedGross[i]);
  });
  const remainingEffective = effectivePaise - sumPaise(fixedEffective);
  const remainingGross = expense.amountPaise - sumPaise(fixedGross);

  const weights = expense.participants.map((p) => Math.max(0, p.weight));
  const usable = weights.some((w) => w > 0);
  let orphaned = false;

  if (usable) {
    const parts = allocate(remainingEffective, weights);
    const gross = allocate(remainingGross, weights);
    expense.participants.forEach((p, i) => {
      add(shares, p.participantId, parts[i]);
      add(grossShares, p.participantId, gross[i]);
    });
  } else if (remainingEffective !== 0 || remainingGross !== 0) {
    // Nobody bears the cost: keep money conserved by charging the payers in proportion to what they paid.
    orphaned = expense.payers.length > 0;
    const payerWeights = expense.payers.map((p) => p.amountPaise);
    const parts = allocate(remainingEffective, payerWeights);
    const gross = allocate(remainingGross, payerWeights);
    expense.payers.forEach((p, i) => {
      add(shares, p.participantId, parts[i]);
      add(grossShares, p.participantId, gross[i]);
    });
  }

  const netPaidByPayer: Record<ParticipantId, Paise> = {};
  for (const payer of expense.payers) {
    netPaidByPayer[payer.participantId] = (netPaidByPayer[payer.participantId] ?? 0) + payer.amountPaise;
  }
  for (const refund of own) {
    netPaidByPayer[refund.receivedBy] = (netPaidByPayer[refund.receivedBy] ?? 0) - refund.amountPaise;
  }

  return { expense, refunds: own, refundedPaise, effectivePaise, shares, grossShares, netPaidByPayer, orphaned };
}

/**
 * Takes fixed amounts out of a pool. If they ask for more than the pool holds
 * (e.g. the whole booking was later refunded), they are scaled down
 * proportionally so the total is still conserved exactly.
 */
function carve(pool: Paise, wanted: Paise[]): Paise[] {
  const total = sumPaise(wanted);
  if (total <= pool) return wanted;
  return allocate(Math.max(0, pool), wanted);
}

export function computeLedger(state: TripState): Ledger {
  const expenses = state.expenses.map((e) => computeExpense(e, state.refunds));
  const byExpenseId: Record<string, ExpenseComputed> = {};
  for (const c of expenses) byExpenseId[c.expense.id] = c;

  const ids = state.participants.map((p) => p.id);
  const balances: Record<ParticipantId, ParticipantBalance> = {};
  const ensure = (id: ParticipantId) => {
    if (!balances[id]) {
      balances[id] = {
        participantId: id,
        paidPaise: 0,
        refundsReceivedPaise: 0,
        sharePaise: 0,
        settledOutPaise: 0,
        settledInPaise: 0,
        pendingPaise: 0,
        contributedPaise: 0,
        netPaise: 0,
        provisionalNetPaise: 0,
      };
    }
    return balances[id];
  };
  ids.forEach(ensure);

  for (const c of expenses) {
    for (const payer of c.expense.payers) ensure(payer.participantId).paidPaise += payer.amountPaise;
    for (const refund of c.refunds) ensure(refund.receivedBy).refundsReceivedPaise += refund.amountPaise;
    for (const [pid, share] of Object.entries(c.shares)) ensure(pid).sharePaise += share;
  }
  for (const contribution of state.contributions) ensure(contribution.participantId).contributedPaise += contribution.direction === "out" ? -contribution.amountPaise : contribution.amountPaise;

  const pendingSettlements = state.settlements.filter((s) => s.status === "initiated");
  const confirmedSettlements = state.settlements.filter((s) => s.status === "confirmed");
  for (const s of confirmedSettlements) {
    ensure(s.from).settledOutPaise += s.amountPaise;
    ensure(s.to).settledInPaise += s.amountPaise;
  }
  for (const s of pendingSettlements) {
    ensure(s.from).pendingPaise += s.amountPaise;
    ensure(s.to).pendingPaise -= s.amountPaise;
  }

  let reconciliationPaise = 0;
  for (const b of Object.values(balances)) {
    b.netPaise = b.paidPaise - b.refundsReceivedPaise + b.settledOutPaise - b.settledInPaise - b.sharePaise;
    b.provisionalNetPaise = b.netPaise + b.pendingPaise;
    reconciliationPaise += b.netPaise;
  }

  const provisional: Record<ParticipantId, Paise> = {};
  const order = Object.keys(balances);
  for (const id of order) provisional[id] = balances[id].provisionalNetPaise;
  const transfers = reconciliationPaise === 0 ? minimiseSettlement(provisional, order) : [];

  const grossPaise = sumPaise(expenses.map((c) => c.expense.amountPaise));
  const refundedPaise = sumPaise(expenses.map((c) => c.refundedPaise));
  const budget = computeBudget(state);

  return {
    expenses,
    byExpenseId,
    balances,
    budget,
    vendors: computeVendorLedger(state, budget),
    totals: {
      grossPaise,
      refundedPaise,
      spendPaise: grossPaise - refundedPaise,
      activeCount: expenses.filter((c) => c.expense.status === "active").length,
      cancelledCount: expenses.filter((c) => c.expense.status === "cancelled").length,
      contributionsPaise: sumPaise(state.contributions.map((c) => (c.direction === "out" ? -c.amountPaise : c.amountPaise))),
      discountPaise: sumPaise(state.expenses.filter((e) => e.status === "active").map((e) => e.discountPaise ?? 0)),
    },
    pendingSettlements,
    confirmedSettlements,
    transfers,
    naiveTransferCount: countPairwiseDebts(expenses, confirmedSettlements),
    reconciliationPaise,
  };
}

/**
 * What the group owes each vendor, which is a different number from what
 * members owe each other. Committed price comes from the itinerary item;
 * paid comes from the expenses linked to it.
 */
function computeVendorLedger(state: TripState, budget: Budget): VendorLine[] {
  const lines = new Map<string, VendorLine>();
  for (const b of budget.items) {
    if (b.item.status === "cancelled") continue;
    // Only real vendors belong in this ledger; an unassigned line is budget, not a debt to someone.
    const vendor = b.item.vendor?.trim();
    if (!vendor) continue;
    const line = lines.get(vendor) ?? { vendor, committedPaise: 0, paidPaise: 0, outstandingPaise: 0, itemIds: [] };
    line.committedPaise += b.committedPaise;
    line.paidPaise += b.paidPaise;
    line.outstandingPaise += b.vendorOutstandingPaise;
    line.itemIds.push(b.item.id);
    lines.set(vendor, line);
  }
  // Ad-hoc expenses with a vendor but no itinerary item are, by definition, fully paid.
  for (const e of state.expenses) {
    if (e.status === "cancelled" || e.itineraryItemId) continue;
    const vendor = e.vendor?.trim();
    if (!vendor) continue;
    const line = lines.get(vendor) ?? { vendor, committedPaise: 0, paidPaise: 0, outstandingPaise: 0, itemIds: [] };
    line.committedPaise += e.amountPaise;
    line.paidPaise += e.amountPaise;
    lines.set(vendor, line);
  }
  return [...lines.values()].sort((a, b) => b.outstandingPaise - a.outstandingPaise || b.committedPaise - a.committedPaise);
}

/**
 * "Everyone pays back whoever paid for them" — the number of distinct
 * debtor→creditor pairs with a positive balance. This is the baseline the
 * minimiser is compared against in the UI.
 */
function countPairwiseDebts(expenses: ExpenseComputed[], confirmed: SettlementData[]): number {
  const pair: Record<string, Paise> = {};
  for (const c of expenses) {
    const paidTotal = sumPaise(Object.values(c.netPaidByPayer));
    if (paidTotal <= 0) continue;
    const payerWeights = Object.values(c.netPaidByPayer).map((v) => Math.max(0, v));
    const payerIds = Object.keys(c.netPaidByPayer);
    for (const [pid, share] of Object.entries(c.shares)) {
      const portions = allocate(share, payerWeights);
      payerIds.forEach((payer, i) => {
        if (payer === pid || portions[i] === 0) return;
        const key = `${pid}>${payer}`;
        pair[key] = (pair[key] ?? 0) + portions[i];
      });
    }
  }
  for (const s of confirmed) {
    const key = `${s.from}>${s.to}`;
    pair[key] = (pair[key] ?? 0) - s.amountPaise;
  }
  const seen = new Set<string>();
  let count = 0;
  for (const key of Object.keys(pair)) {
    const [a, b] = key.split(">");
    const rev = `${b}>${a}`;
    if (seen.has(key) || seen.has(rev)) continue;
    seen.add(key);
    seen.add(rev);
    const net = (pair[key] ?? 0) - (pair[rev] ?? 0);
    if (net !== 0) count += 1;
  }
  return count;
}

/** Sum of everything a participant would receive minus pay, across recommended transfers. */
export function transfersFor(transfers: Transfer[], participantId: ParticipantId) {
  return {
    outgoing: transfers.filter((t) => t.from === participantId),
    incoming: transfers.filter((t) => t.to === participantId),
  };
}
