import { formatMoney, sumPaise, type Paise } from "@/lib/money";
import { computeLedger, type ExpenseComputed, type Ledger } from "./engine";
import { applyEvent } from "./reduce";
import type { LedgerEvent, ParticipantId, TripState } from "./types";

/**
 * Explanations are computed, not written. Every sentence here is produced by
 * comparing two derived ledgers (before/after an event, or current/simulated)
 * and naming the concrete cause: who joined or left a booking, which refund
 * landed, which settlement confirmed. The numbers in the text are the numbers
 * in the ledger.
 */

export type NameFn = (id: ParticipantId) => string;

function listNames(ids: ParticipantId[], name: NameFn): string {
  const names = ids.map(name);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** How one person's share of one booking is derived, as arithmetic a person can check. */
export function shareFormula(c: ExpenseComputed, pid: ParticipantId): string {
  const share = c.shares[pid] ?? 0;
  const withdrawal = c.expense.withdrawals?.find((w) => w.participantId === pid);
  if (withdrawal) {
    if (withdrawal.pricing === "per-head") {
      return `dropped out: seat ${formatMoney(withdrawal.seatPaise)} − ${formatMoney(withdrawal.refundPaise)} vendor refund (${withdrawal.refundPercent}%) = ${formatMoney(withdrawal.retainedPaise)} non-refundable`;
    }
    return withdrawal.rule === "leaver-pays" ? `dropped out but keeps paying their ${formatMoney(withdrawal.retainedPaise)} share (fixed price)` : "dropped out; fixed price re-split across the others";
  }
  if (c.orphaned) return `nobody else is on this booking, so the payer carries ${formatMoney(share)}`;
  const people = c.expense.participants.filter((p) => p.weight > 0);
  const me = people.find((p) => p.participantId === pid);
  if (!me) return "not part of this booking";
  const carved = sumPaise((c.expense.withdrawals ?? []).map((w) => (c.shares[w.participantId] ?? 0)));
  const pool = c.effectivePaise - carved;
  const parts: string[] = [];
  let poolText = formatMoney(pool);
  if (c.refundedPaise > 0 || carved > 0) {
    const bits = [formatMoney(c.expense.amountPaise)];
    if (c.refundedPaise > 0) bits.push(`${formatMoney(c.refundedPaise)} refunded`);
    if (carved > 0) bits.push(`${formatMoney(carved)} kept by people who dropped out`);
    poolText = `(${bits.join(" − ")})`;
  }
  const totalWeight = people.reduce((s, p) => s + p.weight, 0);
  if (c.expense.splitMode === "exact") {
    // Weights are the agreed rupee amounts. Unchanged pool → the amount itself; otherwise scaled pro rata.
    if (pool === totalWeight) return `exact amount agreed for this person = ${formatMoney(share)}`;
    return `${poolText} × ${formatMoney(me.weight)} of ${formatMoney(totalWeight)} agreed (exact amounts, scaled) = ${formatMoney(share)}`;
  }
  const equal = people.every((p) => p.weight === people[0].weight);
  if (equal) parts.push(`${poolText} ÷ ${people.length} ${people.length === 1 ? "person" : "people"}`);
  else parts.push(`${poolText} × ${me.weight}/${totalWeight} (weighted)`);
  return `${parts.join("")} = ${formatMoney(share)}`;
}

// ---------------------------------------------------------------- balance breakdown

export type BreakdownLine = {
  expenseId: string;
  title: string;
  status: "active" | "cancelled";
  /** Money this person handed the vendor, net of refunds they received. */
  paidPaise: Paise;
  sharePaise: Paise;
  /** paid − share: this booking's contribution to their balance. */
  netPaise: Paise;
  formula: string;
};

export type Breakdown = {
  participantId: ParticipantId;
  lines: BreakdownLine[];
  settlements: { direction: "sent" | "received"; counterparty: ParticipantId; amountPaise: Paise; status: "confirmed" | "initiated" }[];
  paidPaise: Paise;
  sharePaise: Paise;
  settledNetPaise: Paise;
  netPaise: Paise;
};

/** Every line that makes up one person's balance. The lines sum exactly to their net. */
export function balanceBreakdown(state: TripState, ledger: Ledger, pid: ParticipantId): Breakdown {
  const lines: BreakdownLine[] = [];
  for (const c of ledger.expenses) {
    const paid = c.netPaidByPayer[pid] ?? 0;
    const share = c.shares[pid] ?? 0;
    if (paid === 0 && share === 0) continue;
    lines.push({
      expenseId: c.expense.id,
      title: c.expense.title,
      status: c.expense.status,
      paidPaise: paid,
      sharePaise: share,
      netPaise: paid - share,
      formula: share ? shareFormula(c, pid) : "not sharing this one",
    });
  }
  const settlements: Breakdown["settlements"] = [];
  for (const s of state.settlements) {
    if (s.status === "cancelled") continue;
    if (s.from === pid) settlements.push({ direction: "sent", counterparty: s.to, amountPaise: s.amountPaise, status: s.status });
    if (s.to === pid) settlements.push({ direction: "received", counterparty: s.from, amountPaise: s.amountPaise, status: s.status });
  }
  const b = ledger.balances[pid];
  return {
    participantId: pid,
    lines,
    settlements,
    paidPaise: sumPaise(lines.map((l) => l.paidPaise)),
    sharePaise: sumPaise(lines.map((l) => l.sharePaise)),
    settledNetPaise: (b?.settledOutPaise ?? 0) - (b?.settledInPaise ?? 0),
    netPaise: b?.netPaise ?? 0,
  };
}

// ---------------------------------------------------------------- attributing a change

export type DeltaLine = {
  expenseId?: string;
  title: string;
  /** Effect on this person's net balance. Positive = better off (owed more / owes less). */
  deltaPaise: Paise;
  shareBefore?: Paise;
  shareAfter?: Paise;
  reason: string;
};

function participantIds(c: ExpenseComputed | undefined): ParticipantId[] {
  return c ? c.expense.participants.filter((p) => p.weight > 0).map((p) => p.participantId) : [];
}

/** Why a booking's split changed between two ledgers, in one sentence. */
export function explainBookingChange(before: ExpenseComputed | undefined, after: ExpenseComputed | undefined, name: NameFn): string {
  if (!before && after) return `new booking: ${formatMoney(after.expense.amountPaise)} split across ${participantIds(after).length}`;
  if (before && !after) return "booking deleted — all its shares withdrawn";
  if (!before || !after) return "changed";
  const bits: string[] = [];
  if (before.expense.status === "active" && after.expense.status === "cancelled") {
    const c = after.expense.cancellation;
    bits.push(`cancelled: ${c?.refundPercent ?? 0}% refundable, ${formatMoney(c?.recoverablePaise ?? 0)} back, ${formatMoney(c?.lossPaise ?? 0)} lost and still shared`);
  }
  const newWithdrawals = (after.expense.withdrawals ?? []).filter((w) => !(before.expense.withdrawals ?? []).some((x) => x.participantId === w.participantId));
  for (const w of newWithdrawals) {
    if (w.pricing === "per-head") {
      bits.push(`${name(w.participantId)} dropped out: per-seat booking, ${w.refundPercent}% of their ${formatMoney(w.seatPaise)} seat refunded, they keep ${formatMoney(w.retainedPaise)}`);
    } else if (w.rule === "leaver-pays") {
      bits.push(`${name(w.participantId)} dropped out but keeps paying ${formatMoney(w.retainedPaise)} (fixed price)`);
    } else {
      bits.push(`${name(w.participantId)} dropped out: fixed price, so ${formatMoney(after.effectivePaise)} is now split ${participantIds(after).length} ways instead of ${participantIds(before).length}`);
    }
  }
  const beforeIds = participantIds(before);
  const afterIds = participantIds(after);
  const withdrawnIds = new Set(newWithdrawals.map((w) => w.participantId));
  const left = beforeIds.filter((id) => !afterIds.includes(id) && !withdrawnIds.has(id));
  const joined = afterIds.filter((id) => !beforeIds.includes(id));
  if (left.length) bits.push(`${listNames(left, name)} left: split ${afterIds.length} ways instead of ${beforeIds.length}`);
  if (joined.length) bits.push(`${listNames(joined, name)} joined: split ${afterIds.length} ways instead of ${beforeIds.length}`);
  if (before.expense.amountPaise !== after.expense.amountPaise) bits.push(`price ${formatMoney(before.expense.amountPaise)} → ${formatMoney(after.expense.amountPaise)}`);
  const refundDelta = after.refundedPaise - before.refundedPaise;
  if (refundDelta > 0 && !newWithdrawals.length && after.expense.status === before.expense.status) {
    bits.push(`${formatMoney(refundDelta)} refund lowered its cost to ${formatMoney(after.effectivePaise)}`);
  }
  return bits.length ? bits.join("; ") : "re-split";
}

/**
 * Explains the difference in one person's net balance between two ledgers,
 * booking by booking. The deltas sum exactly to the change in their net.
 */
export function attributeDelta(before: Ledger, after: Ledger, pid: ParticipantId, name: NameFn): DeltaLine[] {
  const lines: DeltaLine[] = [];
  const ids = new Set([...Object.keys(before.byExpenseId), ...Object.keys(after.byExpenseId)]);
  for (const id of ids) {
    const b = before.byExpenseId[id];
    const a = after.byExpenseId[id];
    const shareB = b?.shares[pid] ?? 0;
    const shareA = a?.shares[pid] ?? 0;
    const paidB = b?.netPaidByPayer[pid] ?? 0;
    const paidA = a?.netPaidByPayer[pid] ?? 0;
    const title = (a ?? b)!.expense.title;
    if (shareA !== shareB) {
      lines.push({ expenseId: id, title, deltaPaise: shareB - shareA, shareBefore: shareB, shareAfter: shareA, reason: explainBookingChange(b, a, name) });
    }
    if (paidA !== paidB) {
      const refundIn = (a?.refunds ?? []).filter((r) => r.receivedBy === pid).reduce((s, r) => s + r.amountPaise, 0) - (b?.refunds ?? []).filter((r) => r.receivedBy === pid).reduce((s, r) => s + r.amountPaise, 0);
      // Whose money is it? Whoever's share of this booking went down.
      const gainers = Object.keys({ ...(b?.shares ?? {}), ...(a?.shares ?? {}) })
        .map((id) => ({ id, drop: (b?.shares[id] ?? 0) - (a?.shares[id] ?? 0) }))
        .filter((g) => g.drop > 0);
      const others = gainers.filter((g) => g.id !== pid);
      const belongsTo = others.length ? others.map((g) => `${name(g.id)} ${formatMoney(g.drop)}`).join(", ") : "";
      const reason =
        refundIn > 0
          ? `the vendor refunds ${formatMoney(refundIn)} to ${name(pid)} because they paid for it${
              belongsTo ? `; that money belongs to ${belongsTo} (their share went down), so ${name(pid)} now owes it on` : "; it is credited back through the lower share"
            }`
          : paidA > paidB
            ? `paid ${formatMoney(paidA - paidB)} more to the vendor`
            : `payment reduced by ${formatMoney(paidB - paidA)}`;
      lines.push({ expenseId: id, title: `${title} · payment`, deltaPaise: paidA - paidB, reason });
    }
  }
  const settled = (l: Ledger) => (l.balances[pid] ? l.balances[pid].settledOutPaise - l.balances[pid].settledInPaise : 0);
  const settleDelta = settled(after) - settled(before);
  if (settleDelta !== 0) {
    lines.push({ title: "Settlement", deltaPaise: settleDelta, reason: settleDelta > 0 ? `sent ${formatMoney(settleDelta)} to settle up` : `received ${formatMoney(-settleDelta)} as settlement` });
  }
  return lines.sort((x, y) => Math.abs(y.deltaPaise) - Math.abs(x.deltaPaise));
}

/**
 * One sentence from the delta lines: "Kavya's balance went down by ₹1,950:
 * Villa Azul share up ₹1,800 (Aarav dropped out…); Airport pickup share up ₹150."
 * Every figure is a line the ledger produced; the lines sum to the total.
 */
export function summariseDelta(who: string, deltaPaise: Paise, lines: DeltaLine[]): string {
  if (deltaPaise === 0 && !lines.length) return `${who}'s balance did not change.`;
  const head = deltaPaise === 0 ? `${who}'s balance is unchanged overall` : `${who}'s balance went ${deltaPaise > 0 ? "up" : "down"} by ${formatMoney(Math.abs(deltaPaise))}`;
  const parts = lines.slice(0, 4).map((l) => {
    if (l.shareBefore !== undefined && l.shareAfter !== undefined) {
      const up = l.shareAfter > l.shareBefore;
      return `${l.title} share ${up ? "up" : "down"} ${formatMoney(Math.abs(l.shareAfter - l.shareBefore))} (${l.reason})`;
    }
    return `${l.title} ${formatMoney(l.deltaPaise, { signed: true })} (${l.reason})`;
  });
  const more = lines.length > 4 ? `; and ${lines.length - 4} smaller change${lines.length - 4 === 1 ? "" : "s"}` : "";
  return `${head} because: ${parts.join("; ")}${more}.`;
}

// ---------------------------------------------------------------- history

export type TimelineEntry = {
  event: LedgerEvent;
  netBefore: Paise;
  netAfter: Paise;
  deltaPaise: Paise;
  lines: DeltaLine[];
};

/**
 * Replays the log and records every event that moved this person's balance,
 * with the booking-level reasons. Answers "why did my balance change?".
 */
export function balanceTimeline(events: LedgerEvent[], pid: ParticipantId, name: NameFn): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let state: TripState | null = null;
  let ledger: Ledger | null = null;
  for (const event of events) {
    const next = applyEvent(state, event);
    if (!next) continue;
    const nextLedger = computeLedger(next);
    if (ledger && state) {
      const before = ledger.balances[pid]?.netPaise ?? 0;
      const after = nextLedger.balances[pid]?.netPaise ?? 0;
      if (before !== after) {
        out.push({ event, netBefore: before, netAfter: after, deltaPaise: after - before, lines: attributeDelta(ledger, nextLedger, pid, name) });
      }
    }
    state = next;
    ledger = nextLedger;
  }
  return out;
}
