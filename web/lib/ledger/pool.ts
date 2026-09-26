import { newId } from "@/lib/id";
import { allocate, isPaise, sumPaise, type Paise } from "@/lib/money";
import { addExpense, CommandError, type ExpenseInput } from "./commands";
import type { ContributionData, ExpenseCategory, LedgerEvent, ParticipantId, SettlementMethod, TripState } from "./types";

/**
 * The trip pool (a simulated escrow). Members deposit into it; vendors are
 * paid out of it; unspent money can be withdrawn back. Nothing here moves
 * real money — the ledger records who put what in and whose deposit paid for
 * which booking, so balances stay exact.
 *
 * A vendor payment from the pool is an ordinary expense whose payers are the
 * members whose deposits funded it, in proportion to what each still has in
 * the pool. So "paid from the pool" and "paid by the people who funded the
 * pool" are the same fact, and every share, refund and settlement keeps
 * working unchanged.
 */

export type PoolMember = {
  participantId: ParticipantId;
  depositedPaise: Paise;
  withdrawnPaise: Paise;
  /** Their part of vendor payments made from the pool. */
  spentPaise: Paise;
  /** deposited − withdrawn − spent. Never negative. */
  availablePaise: Paise;
};

export type PoolSummary = {
  members: Record<ParticipantId, PoolMember>;
  depositedPaise: Paise;
  withdrawnPaise: Paise;
  spentPaise: Paise;
  availablePaise: Paise;
  vendorPayments: { expenseId: string; title: string; vendor?: string; amountPaise: Paise; date: string; status: "active" | "cancelled" }[];
};

export function poolSummary(state: TripState): PoolSummary {
  const members: Record<ParticipantId, PoolMember> = {};
  const m = (id: ParticipantId) => (members[id] ??= { participantId: id, depositedPaise: 0, withdrawnPaise: 0, spentPaise: 0, availablePaise: 0 });
  for (const p of state.participants) m(p.id);
  for (const c of state.contributions) {
    if (c.direction === "out") m(c.participantId).withdrawnPaise += c.amountPaise;
    else m(c.participantId).depositedPaise += c.amountPaise;
  }
  const pooled = state.expenses.filter((e) => e.fundedFromPool);
  for (const e of pooled) for (const payer of e.payers) m(payer.participantId).spentPaise += payer.amountPaise;
  for (const x of Object.values(members)) x.availablePaise = Math.max(0, x.depositedPaise - x.withdrawnPaise - x.spentPaise);
  const all = Object.values(members);
  return {
    members,
    depositedPaise: sumPaise(all.map((x) => x.depositedPaise)),
    withdrawnPaise: sumPaise(all.map((x) => x.withdrawnPaise)),
    spentPaise: sumPaise(all.map((x) => x.spentPaise)),
    availablePaise: sumPaise(all.map((x) => x.availablePaise)),
    vendorPayments: pooled.map((e) => ({ expenseId: e.id, title: e.title, vendor: e.vendor, amountPaise: e.amountPaise, date: e.date, status: e.status })),
  };
}

type Ctx = { actor: ParticipantId | "system"; now?: number };
const base = (ctx: Ctx) => ({ id: newId("ev"), ts: ctx.now ?? Date.now(), actor: ctx.actor });

function contribution(state: TripState, input: { participantId: ParticipantId; amountPaise: Paise; method: SettlementMethod; reference?: string }, direction: "in" | "out", ctx: Ctx): LedgerEvent {
  if (state.trip.status === "closed") throw new CommandError("This trip is closed.");
  const person = state.participants.find((p) => p.id === input.participantId);
  if (!person) throw new CommandError("That member is not on the trip");
  if (!isPaise(input.amountPaise) || input.amountPaise <= 0) throw new CommandError("Enter an amount above ₹0", "amount");
  if (direction === "out") {
    const available = poolSummary(state).members[input.participantId]?.availablePaise ?? 0;
    if (input.amountPaise > available) throw new CommandError(`${person.name} has only ₹${(available / 100).toLocaleString("en-IN")} unspent in the pool`, "amount");
  } else if (person.leftOn) {
    throw new CommandError(`${person.name} has left the trip`);
  }
  const data: ContributionData = {
    id: newId("ct"),
    participantId: input.participantId,
    amountPaise: input.amountPaise,
    direction,
    method: input.method,
    reference: input.reference?.trim() || undefined,
    ts: ctx.now ?? Date.now(),
  };
  return { ...base(ctx), type: "CONTRIBUTION_RECORDED", contribution: data };
}

/** A member deposits into the pool. */
export function depositToPool(state: TripState, input: { participantId: ParticipantId; amountPaise: Paise; method: SettlementMethod; reference?: string }, ctx: Ctx): LedgerEvent {
  return contribution(state, input, "in", ctx);
}

/** A member takes unspent money back out of the pool. */
export function withdrawFromPool(state: TripState, input: { participantId: ParticipantId; amountPaise: Paise; method: SettlementMethod; reference?: string }, ctx: Ctx): LedgerEvent {
  return contribution(state, input, "out", ctx);
}

export type PoolPaymentInput = Omit<ExpenseInput, "payers" | "fundedFromPool">;

/** Which members' deposits fund a vendor payment: pro rata to what each still has in the pool. */
export function poolPayers(state: TripState, amountPaise: Paise) {
  const pool = poolSummary(state);
  if (amountPaise > pool.availablePaise) {
    throw new CommandError(`The pool has ₹${(pool.availablePaise / 100).toLocaleString("en-IN")} available — top it up first`, "amount");
  }
  const funders = Object.values(pool.members).filter((m) => m.availablePaise > 0);
  const parts = allocate(amountPaise, funders.map((m) => m.availablePaise));
  return funders.map((m, i) => ({ participantId: m.participantId, amountPaise: parts[i] })).filter((p) => p.amountPaise > 0);
}

/** Pay a vendor out of the pool. Shares still derive from who is on the booking. */
export function payVendorFromPool(state: TripState, input: PoolPaymentInput, ctx: Ctx): LedgerEvent {
  if (!isPaise(input.amountPaise) || input.amountPaise <= 0) throw new CommandError("Enter an amount above ₹0", "amount");
  const payers = poolPayers(state, input.amountPaise);
  return addExpense(state, { ...input, payers, fundedFromPool: true }, ctx);
}

// ---------------------------------------------------------------- pool target & funding view

/** The organiser sets (or clears) the whole-trip pool target. Recorded as a normal trip update. */
export function setPoolTarget(state: TripState, targetPaise: Paise | undefined, ctx: Ctx): LedgerEvent {
  if (state.trip.status === "closed") throw new CommandError("This trip is closed.");
  if (targetPaise !== undefined && (!isPaise(targetPaise) || targetPaise <= 0)) throw new CommandError("Enter a target above ₹0", "amount");
  if (targetPaise === state.trip.poolTargetPaise) throw new CommandError("That is already the target");
  return { ...base(ctx), type: "TRIP_UPDATED", before: { poolTargetPaise: state.trip.poolTargetPaise }, after: { poolTargetPaise: targetPaise } };
}

export type PoolFunding = {
  targetPaise: Paise | null;
  /** Money put in (deposits). */
  collectedPaise: Paise;
  /** Committed to vendors out of the pool. */
  reservedPaise: Paise;
  /** Taken back out (withdrawals and payment refunds). */
  refundedPaise: Paise;
  /** collected − reserved − refunded. */
  availablePaise: Paise;
  /** target − collected, never below zero; null without a target. */
  remainingPaise: Paise | null;
  /** 0–100, null without a target. */
  fundingPercent: number | null;
  status: "open" | "funded" | "closed";
};

/** Pool totals in the shape the Trip Pool API returns. Derived from the ledger only. */
export function poolFunding(state: TripState): PoolFunding {
  const s = poolSummary(state);
  const target = state.trip.poolTargetPaise ?? null;
  const collected = s.depositedPaise;
  const available = collected - s.spentPaise - s.withdrawnPaise;
  return {
    targetPaise: target,
    collectedPaise: collected,
    reservedPaise: s.spentPaise,
    refundedPaise: s.withdrawnPaise,
    availablePaise: available,
    remainingPaise: target === null ? null : Math.max(0, target - collected),
    fundingPercent: target ? Math.min(100, Math.floor((collected * 100) / target)) : null,
    status: state.trip.status === "closed" ? "closed" : target !== null && collected >= target ? "funded" : "open",
  };
}

// ---------------------------------------------------------------- trip budget

/** Default split offered when the organiser wants category budgets (editable). */
export const DEFAULT_BUDGET_SPLIT: Partial<Record<ExpenseCategory, number>> = { Stay: 40, Transport: 20, Food: 20, Activity: 15, Other: 5 };

/** Sets the trip's total budget and (optionally) its category split. Recorded as a trip update. */
export function setTripBudget(state: TripState, input: { totalPaise: Paise | undefined; split?: Partial<Record<ExpenseCategory, number>> }, ctx: Ctx): LedgerEvent {
  if (state.trip.status === "closed") throw new CommandError("This trip is closed.");
  if (input.totalPaise !== undefined && (!isPaise(input.totalPaise) || input.totalPaise <= 0)) throw new CommandError("Enter a budget above ₹0", "amount");
  let split: Partial<Record<ExpenseCategory, number>> | undefined;
  if (input.split) {
    split = {};
    let sum = 0;
    for (const [cat, pct] of Object.entries(input.split) as [ExpenseCategory, number][]) {
      if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new CommandError("Percentages must be whole numbers 0–100", "split");
      if (pct > 0) split[cat] = pct;
      sum += pct;
    }
    if (sum !== 100) throw new CommandError(`Category percentages must add up to 100 (they add up to ${sum})`, "split");
  }
  return {
    ...base(ctx),
    type: "TRIP_UPDATED",
    before: { budgetPaise: state.trip.budgetPaise, budgetSplit: state.trip.budgetSplit },
    after: { budgetPaise: input.totalPaise, budgetSplit: split },
  };
}

/** Budget per category in paise from the total and split (largest-remainder, sums exactly). */
export function categoryBudgets(state: TripState): { category: ExpenseCategory; percent: number; paise: Paise }[] {
  const total = state.trip.budgetPaise;
  const split = state.trip.budgetSplit;
  if (!total || !split) return [];
  const cats = Object.entries(split).filter(([, p]) => (p ?? 0) > 0) as [ExpenseCategory, number][];
  const parts = allocate(total, cats.map(([, p]) => p));
  return cats.map(([category, percent], i) => ({ category, percent, paise: parts[i] }));
}
