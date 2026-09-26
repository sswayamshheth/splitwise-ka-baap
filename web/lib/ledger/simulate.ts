import { formatDate } from "@/lib/dates";
import { diffBudget, type BudgetDiff } from "./budget";
import { formatMoney, sumPaise, type Paise } from "@/lib/money";
import {
  addExpense,
  addParticipant,
  cancelExpense,
  CommandError,
  joinBooking,
  leaveTrip,
  recordRefund,
  removeItineraryItem,
  repriceBooking,
  withdrawFromBooking,
  type ExpenseInput,
  type RefundInput,
} from "./commands";
import { computeLedger, type Ledger } from "./engine";
import { attributeDelta, explainBookingChange, type DeltaLine, type NameFn } from "./explain";
import { applyEvent, reduceEvents } from "./reduce";
import type { Transfer } from "./settlement";
import type { FixedLeaveRule, LedgerEvent, ParticipantId, RefundData, TripState } from "./types";

/**
 * The what-if engine. A scenario is a list of changes. Each change is turned
 * into ledger events by the SAME validated commands the app uses, appended to
 * a copy of the log, and the copy is replayed. Nothing is written until the
 * caller appends `events` to the real log — so what you preview is exactly
 * what Apply does, by construction.
 */

export type Change =
  | { kind: "leave-trip"; participantId: ParticipantId; date: string; rule?: FixedLeaveRule }
  | { kind: "withdraw"; participantId: ParticipantId; expenseId: string; date: string; rule?: FixedLeaveRule }
  | { kind: "join-booking"; participantId: ParticipantId; expenseId: string; payerId?: ParticipantId }
  | { kind: "cancel-booking"; expenseId: string; date: string }
  | { kind: "add-member"; name: string; expenseIds: string[] }
  | { kind: "add-expense"; input: ExpenseInput }
  | { kind: "record-refund"; input: RefundInput }
  | { kind: "reprice"; expenseId?: string; itemId?: string; newAmountPaise: Paise; payerId?: ParticipantId }
  | { kind: "drop-item"; itemId: string };

type Ctx = { actor: ParticipantId | "system"; now?: number };

/** Turns one change into the events that would be appended, validated against `state`. */
export function buildChangeEvents(state: TripState, change: Change, ctx: Ctx): LedgerEvent[] {
  switch (change.kind) {
    case "leave-trip":
      return leaveTrip(state, { participantId: change.participantId, date: change.date, rule: change.rule }, ctx).events;
    case "withdraw":
      return [withdrawFromBooking(state, change, ctx)];
    case "join-booking":
      return [joinBooking(state, change, ctx)];
    case "cancel-booking":
      return [cancelExpense(state, change.expenseId, { date: change.date }, ctx)];
    case "add-member": {
      const added = addParticipant(state, { name: change.name }, ctx);
      if (added.type !== "PARTICIPANT_ADDED") return [added];
      let working = applyEvent(state, added)!;
      const events: LedgerEvent[] = [added];
      let tick = 1;
      for (const expenseId of change.expenseIds) {
        const join = joinBooking(working, { participantId: added.participant.id, expenseId }, { ...ctx, now: (ctx.now ?? Date.now()) + tick++ });
        events.push(join);
        working = applyEvent(working, join)!;
      }
      return events;
    }
    case "add-expense":
      return [addExpense(state, change.input, ctx)];
    case "record-refund":
      return [recordRefund(state, change.input, ctx)];
    case "reprice":
      return [repriceBooking(state, change, ctx)];
    case "drop-item":
      return [removeItineraryItem(state, change.itemId, ctx)];
  }
}

export function describeChange(state: TripState, change: Change): string {
  const person = (id: ParticipantId) => state.participants.find((p) => p.id === id)?.name ?? "Someone";
  const booking = (id: string) => state.expenses.find((e) => e.id === id)?.title ?? "a booking";
  switch (change.kind) {
    case "leave-trip":
      return `${person(change.participantId)} leaves the trip on ${formatDate(change.date)}`;
    case "withdraw":
      return `${person(change.participantId)} drops out of ${booking(change.expenseId)} on ${formatDate(change.date)}`;
    case "join-booking":
      return `${person(change.participantId)} joins ${booking(change.expenseId)}`;
    case "cancel-booking":
      return `${booking(change.expenseId)} is cancelled on ${formatDate(change.date)}`;
    case "add-member":
      return `${change.name} joins the trip${change.expenseIds.length ? ` and ${change.expenseIds.length} booking${change.expenseIds.length === 1 ? "" : "s"}` : ""}`;
    case "add-expense":
      return `New expense: ${change.input.title}`;
    case "record-refund":
      return `Refund on ${booking(change.input.expenseId)}`;
    case "reprice": {
      const what = change.expenseId ? booking(change.expenseId) : (state.itinerary.find((i) => i.id === change.itemId)?.title ?? "a plan item");
      const was = change.expenseId ? state.expenses.find((e) => e.id === change.expenseId)?.amountPaise : state.itinerary.find((i) => i.id === change.itemId)?.estimatedPaise;
      return `${what} costs ${formatMoney(change.newAmountPaise)}${was !== undefined ? ` instead of ${formatMoney(was)}` : ""}`;
    }
    case "drop-item":
      return `${state.itinerary.find((i) => i.id === change.itemId)?.title ?? "A plan item"} is dropped from the plan`;
  }
}

// ---------------------------------------------------------------- diff

export type PersonDiff = {
  participantId: ParticipantId;
  shareBefore: Paise;
  shareAfter: Paise;
  netBefore: Paise;
  netAfter: Paise;
  deltaPaise: Paise;
  lines: DeltaLine[];
  left: boolean;
  isNew: boolean;
};

export type BookingDiff = {
  expenseId: string;
  title: string;
  statusBefore?: "active" | "cancelled";
  statusAfter?: "active" | "cancelled";
  effectiveBefore: Paise;
  effectiveAfter: Paise;
  refundAddedPaise: Paise;
  peopleBefore: number;
  peopleAfter: number;
  reason: string;
  shares: { participantId: ParticipantId; before: Paise; after: Paise }[];
};

export type LedgerDiff = {
  spendBefore: Paise;
  spendAfter: Paise;
  refundsAdded: RefundData[];
  people: PersonDiff[];
  affected: BookingDiff[];
  unaffected: { expenseId: string; title: string; why: string }[];
  transfersBefore: Transfer[];
  transfersAfter: Transfer[];
  reconciliationAfter: Paise;
  /** The plan side: itinerary estimates before and after, line by line. */
  budget: BudgetDiff;
};

export type Snapshot = { state: TripState; ledger: Ledger };

export type Simulation =
  | { ok: true; changes: Change[]; events: LedgerEvent[]; before: Snapshot; after: Snapshot; diff: LedgerDiff }
  | { ok: false; changes: Change[]; error: string; failedAt: number };

export function simulate(baseEvents: LedgerEvent[], changes: Change[], ctx: Ctx, name?: NameFn): Simulation {
  const beforeState = reduceEvents(baseEvents);
  if (!beforeState) return { ok: false, changes, error: "This trip has no history yet", failedAt: 0 };
  let working = beforeState;
  const events: LedgerEvent[] = [];
  let now = ctx.now ?? Date.now();
  for (let i = 0; i < changes.length; i++) {
    try {
      const built = buildChangeEvents(working, changes[i], { ...ctx, now });
      now += built.length + 1;
      for (const e of built) {
        events.push(e);
        working = applyEvent(working, e) ?? working;
      }
    } catch (error) {
      const message = error instanceof CommandError || error instanceof Error ? error.message : String(error);
      return { ok: false, changes, error: message, failedAt: i };
    }
  }
  const before: Snapshot = { state: beforeState, ledger: computeLedger(beforeState) };
  const after: Snapshot = { state: working, ledger: computeLedger(working) };
  const nameFn: NameFn = name ?? ((id) => working.participants.find((p) => p.id === id)?.name ?? "Former member");
  return { ok: true, changes, events, before, after, diff: diffLedgers(before, after, nameFn) };
}

export function diffLedgers(before: Snapshot, after: Snapshot, name: NameFn): LedgerDiff {
  const lb = before.ledger;
  const la = after.ledger;
  const beforeRefundIds = new Set(before.state.refunds.map((r) => r.id));
  const refundsAdded = after.state.refunds.filter((r) => !beforeRefundIds.has(r.id));

  const ids = [...new Set([...before.state.participants.map((p) => p.id), ...after.state.participants.map((p) => p.id)])];
  const people: PersonDiff[] = ids.map((id) => {
    const b = lb.balances[id];
    const a = la.balances[id];
    const netBefore = b?.netPaise ?? 0;
    const netAfter = a?.netPaise ?? 0;
    return {
      participantId: id,
      shareBefore: b?.sharePaise ?? 0,
      shareAfter: a?.sharePaise ?? 0,
      netBefore,
      netAfter,
      deltaPaise: netAfter - netBefore,
      lines: netAfter !== netBefore || (b?.sharePaise ?? 0) !== (a?.sharePaise ?? 0) ? attributeDelta(lb, la, id, name) : [],
      left: !!after.state.participants.find((p) => p.id === id)?.leftOn && !before.state.participants.find((p) => p.id === id)?.leftOn,
      isNew: !b,
    };
  });

  const affected: BookingDiff[] = [];
  const unaffected: LedgerDiff["unaffected"] = [];
  const expenseIds = [...new Set([...Object.keys(lb.byExpenseId), ...Object.keys(la.byExpenseId)])];
  for (const id of expenseIds) {
    const b = lb.byExpenseId[id];
    const a = la.byExpenseId[id];
    const pids = [...new Set([...Object.keys(b?.shares ?? {}), ...Object.keys(a?.shares ?? {})])];
    const shares = pids.map((pid) => ({ participantId: pid, before: b?.shares[pid] ?? 0, after: a?.shares[pid] ?? 0 }));
    const changed =
      !b ||
      !a ||
      b.expense.status !== a.expense.status ||
      b.effectivePaise !== a.effectivePaise ||
      shares.some((s) => s.before !== s.after) ||
      (b.expense.withdrawals?.length ?? 0) !== (a.expense.withdrawals?.length ?? 0) ||
      JSON.stringify(b.netPaidByPayer) !== JSON.stringify(a.netPaidByPayer);
    const title = (a ?? b)!.expense.title;
    if (!changed) {
      if (b.expense.status === "active") unaffected.push({ expenseId: id, title, why: unaffectedReason(before.state, after.state, id) });
      continue;
    }
    affected.push({
      expenseId: id,
      title,
      statusBefore: b?.expense.status,
      statusAfter: a?.expense.status,
      effectiveBefore: b?.effectivePaise ?? 0,
      effectiveAfter: a?.effectivePaise ?? 0,
      refundAddedPaise: (a?.refundedPaise ?? 0) - (b?.refundedPaise ?? 0),
      peopleBefore: b ? b.expense.participants.length : 0,
      peopleAfter: a ? a.expense.participants.length : 0,
      reason: explainBookingChange(b, a, name),
      shares: shares.filter((s) => s.before !== 0 || s.after !== 0),
    });
  }

  return {
    spendBefore: lb.totals.spendPaise,
    spendAfter: la.totals.spendPaise,
    refundsAdded,
    people,
    affected,
    unaffected,
    transfersBefore: lb.transfers,
    transfersAfter: la.transfers,
    reconciliationAfter: la.reconciliationPaise,
    budget: diffBudget(before.state, after.state),
  };
}

/** Why a booking did not move: the person wasn't on it, or it was already used. */
function unaffectedReason(before: TripState, after: TripState, expenseId: string): string {
  const leavers = after.participants.filter((p) => p.leftOn && !before.participants.find((x) => x.id === p.id)?.leftOn);
  const expense = before.expenses.find((e) => e.id === expenseId);
  if (!expense || !leavers.length) return "not touched by this change";
  const on = leavers.filter((p) => expense.participants.some((x) => x.participantId === p.id));
  if (on.length) return "already used before the leave date — share kept";
  return `${leavers.map((p) => p.name.split(" ")[0]).join(", ")} ${leavers.length === 1 ? "wasn't" : "weren't"} part of it`;
}

/** Total vendor refunds a scenario brings in. */
export function refundTotal(diff: LedgerDiff): Paise {
  return sumPaise(diff.refundsAdded.map((r) => r.amountPaise));
}
