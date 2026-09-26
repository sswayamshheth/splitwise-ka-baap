import { formatMoney, sumPaise, type Paise } from "@/lib/money";
import { bookingDate } from "./commands";
import type { Ledger } from "./engine";
import type { ParticipantId, TripState } from "./types";

/**
 * Deterministic consistency checks. Each rule compares two things the ledger
 * already knows (the plan vs the split, the vendor price vs what was paid,
 * the member list vs the passenger list) and reports a mismatch with the
 * exact people and amounts involved. No model is involved in detecting them.
 */

export type Severity = "critical" | "warning" | "info";

export type Anomaly = {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  expenseId?: string;
  itemId?: string;
  participantIds?: ParticipantId[];
};

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function findAnomalies(state: TripState, ledger: Ledger): Anomaly[] {
  const out: Anomaly[] = [];
  const nameOf = (id: ParticipantId) => state.participants.find((p) => p.id === id)?.name.split(" ")[0] ?? "Former member";
  const names = (ids: ParticipantId[]) => ids.map(nameOf).join(", ");
  const active = state.participants.filter((p) => !p.leftOn);

  // 1. The books must balance. If this ever fires, something is corrupt.
  if (ledger.reconciliationPaise !== 0) {
    out.push({ id: "reconciliation", severity: "critical", title: "Ledger does not balance", detail: `Balances sum to ${formatMoney(ledger.reconciliationPaise)} instead of ₹0.` });
  }

  for (const e of state.expenses) {
    if (e.status !== "active") continue;
    // 2. Payers must add up to the bill.
    const paid = sumPaise(e.payers.map((p) => p.amountPaise));
    if (paid !== e.amountPaise) {
      out.push({ id: `payers-${e.id}`, severity: "critical", title: `${e.title}: payments don't match the bill`, detail: `Bill ${formatMoney(e.amountPaise)}, payers recorded ${formatMoney(paid)}.`, expenseId: e.id });
    }
    // 3. Someone who left is still in a split for something after they left.
    for (const p of e.participants) {
      const who = state.participants.find((x) => x.id === p.participantId);
      if (who?.leftOn && bookingDate(state, e) >= who.leftOn) {
        out.push({
          id: `left-${e.id}-${who.id}`,
          severity: "warning",
          title: `${who.name.split(" ")[0]} left but is still in "${e.title}"`,
          detail: `They left on ${who.leftOn}; this booking is on ${bookingDate(state, e)}. They're still being charged a share.`,
          expenseId: e.id,
          participantIds: [who.id],
        });
      }
    }
    // 4. Nobody shares it: the payer silently carries it.
    if (ledger.byExpenseId[e.id]?.orphaned) {
      out.push({ id: `orphan-${e.id}`, severity: "warning", title: `"${e.title}" has nobody sharing it`, detail: "Its whole cost is falling on whoever paid.", expenseId: e.id });
    }
  }

  // 5. Plan vs money: the itinerary says one group, the paid split says another.
  for (const item of state.itinerary) {
    if (item.status === "cancelled" || !item.expenseIds.length) continue;
    const linked = state.expenses.filter((e) => item.expenseIds.includes(e.id) && e.status === "active");
    if (!linked.length) continue;
    const inSplit = new Set(linked.flatMap((e) => e.participants.map((p) => p.participantId)));
    const planned = new Set(item.participantIds);
    const notCharged = [...planned].filter((id) => !inSplit.has(id));
    const notPlanned = [...inSplit].filter((id) => !planned.has(id));
    if (notCharged.length || notPlanned.length) {
      const bits: string[] = [];
      if (notCharged.length) bits.push(`${names(notCharged)} ${notCharged.length === 1 ? "is" : "are"} on the plan but not paying a share`);
      if (notPlanned.length) bits.push(`${names(notPlanned)} ${notPlanned.length === 1 ? "is" : "are"} paying but not on the plan`);
      out.push({
        id: `plan-${item.id}`,
        severity: "warning",
        title: `${item.title}: plan says ${planned.size}, split says ${inSplit.size}`,
        detail: `${bits.join("; ")}.`,
        itemId: item.id,
        expenseId: linked[0].id,
        participantIds: [...notCharged, ...notPlanned],
      });
    }
    // 6. Vendor paid more than the agreed price — possible double payment.
    const committed = item.actualPaise ?? item.estimatedPaise;
    const paidToVendor = sumPaise(linked.map((e) => e.amountPaise));
    if (item.actualPaise !== undefined && paidToVendor > committed) {
      out.push({
        id: `overpaid-${item.id}`,
        severity: "warning",
        title: `${item.title}: paid more than the booked price`,
        detail: `Booked at ${formatMoney(committed)}, payments total ${formatMoney(paidToVendor)} — check for a duplicate payment.`,
        itemId: item.id,
      });
    }
  }

  // 7. Whole-group transport with fewer seats than members: someone may have no ticket.
  for (const item of state.itinerary) {
    if (item.status === "cancelled" || item.category !== "Transport") continue;
    const missing = active.filter((p) => !item.participantIds.includes(p.id) && item.date >= (state.trip.startDate ?? item.date));
    if (missing.length && missing.length < active.length && item.participantIds.length >= active.length / 2) {
      out.push({
        id: `seats-${item.id}`,
        severity: "info",
        title: `${item.title}: ${item.participantIds.length} travellers, trip has ${active.length}`,
        detail: `${names(missing.map((p) => p.id))} ${missing.length === 1 ? "has" : "have"} no seat on this leg. Intended?`,
        itemId: item.id,
        participantIds: missing.map((p) => p.id),
      });
    }
  }

  // 8. Duplicate entries: same amount on the same day at the same vendor.
  const seen = new Map<string, string>();
  for (const e of state.expenses) {
    if (e.status !== "active") continue;
    const key = `${e.amountPaise}|${e.date}|${(e.vendor ?? e.title).toLowerCase().trim()}`;
    const other = seen.get(key);
    if (other) {
      out.push({ id: `dup-${e.id}`, severity: "warning", title: `Possible duplicate: "${e.title}"`, detail: `Same amount (${formatMoney(e.amountPaise)}), date and vendor as "${other}".`, expenseId: e.id });
    } else seen.set(key, e.title);
  }

  // 9. Cancelled with a refundable policy but no money back recorded.
  for (const e of state.expenses) {
    if (e.status !== "cancelled") continue;
    const refunded = sumPaise(state.refunds.filter((r) => r.expenseId === e.id).map((r) => r.amountPaise));
    if ((e.cancellation?.recoverablePaise ?? 0) > 0 && refunded === 0) {
      out.push({ id: `norefund-${e.id}`, severity: "warning", title: `"${e.title}" refund not recorded`, detail: `${formatMoney(e.cancellation!.recoverablePaise)} should come back under the policy.`, expenseId: e.id });
    }
  }

  // 10. Payments someone says they sent but nobody has confirmed.
  for (const s of ledger.pendingSettlements) {
    out.push({
      id: `pending-${s.id}`,
      severity: "info",
      title: `${nameOf(s.from)} → ${nameOf(s.to)} ${formatMoney(s.amountPaise)} awaiting confirmation`,
      detail: "Balances only move once the recipient confirms it arrived.",
      participantIds: [s.from, s.to],
    });
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

// ---------------------------------------------------------------- health

export type TripHealth = {
  budgetPaise: Paise;
  committedPaise: Paise;
  spentPaise: Paise;
  refundedPaise: Paise;
  /** Confirmed settlements as a share of all money that needed to move between members, 0–1. */
  settledFraction: number;
  settledPaise: Paise;
  outstandingPaise: Paise;
  pendingSettlements: number;
  members: number;
  leftMembers: number;
  bookings: number;
  cancelledBookings: number;
  vendorOutstandingPaise: Paise;
  anomalies: { critical: number; warning: number; info: number };
  transfersToSettle: number;
};

export function tripHealth(state: TripState, ledger: Ledger, anomalies: Anomaly[]): TripHealth {
  const outstanding = sumPaise(Object.values(ledger.balances).map((b) => Math.max(0, b.netPaise)));
  const settled = sumPaise(ledger.confirmedSettlements.map((s) => s.amountPaise));
  const needed = settled + outstanding;
  return {
    budgetPaise: ledger.budget.estimatedPaise,
    committedPaise: ledger.budget.committedPaise,
    spentPaise: ledger.totals.spendPaise,
    refundedPaise: ledger.totals.refundedPaise,
    settledFraction: needed > 0 ? settled / needed : 1,
    settledPaise: settled,
    outstandingPaise: outstanding,
    pendingSettlements: ledger.pendingSettlements.length,
    members: state.participants.filter((p) => !p.leftOn).length,
    leftMembers: state.participants.filter((p) => p.leftOn).length,
    bookings: ledger.totals.activeCount,
    cancelledBookings: ledger.totals.cancelledCount,
    vendorOutstandingPaise: ledger.budget.vendorOutstandingPaise,
    anomalies: {
      critical: anomalies.filter((a) => a.severity === "critical").length,
      warning: anomalies.filter((a) => a.severity === "warning").length,
      info: anomalies.filter((a) => a.severity === "info").length,
    },
    transfersToSettle: ledger.transfers.length,
  };
}
