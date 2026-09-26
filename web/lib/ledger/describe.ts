import { formatMoney, type Paise } from "@/lib/money";
import type { LedgerEvent, ParticipantId, SettlementData } from "./types";

/**
 * Turns a ledger event into something a person can read in the activity
 * feed. Names are resolved through a lookup built from the whole log so that
 * removed members are still named correctly in old events.
 */

export type Described = {
  icon: string;
  tone: "blue" | "mint" | "coral" | "amber" | "grey" | "lavender";
  title: string;
  detail: string;
  amountPaise?: Paise;
  /** Before → after lines for edits. */
  changes?: { label: string; before: string; after: string }[];
  expenseId?: string;
  itemId?: string;
  participantId?: ParticipantId;
  kind: "trip" | "member" | "itinerary" | "expense" | "refund" | "settlement" | "funding";
};

export type NameOf = (id: ParticipantId | "system") => string;

export function buildNameLookup(events: LedgerEvent[], viewerId: ParticipantId | null): NameOf {
  const names = new Map<string, string>();
  for (const e of events) {
    if (e.type === "PARTICIPANT_ADDED") names.set(e.participant.id, e.participant.name);
    if (e.type === "PARTICIPANT_UPDATED" && e.after.name) names.set(e.participantId, e.after.name);
  }
  return (id) => (id === "system" ? "System" : id === viewerId ? "You" : (names.get(id) ?? "Former member"));
}

function list(ids: ParticipantId[], name: NameOf): string {
  const names = ids.map(name);
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

export type DescribeContext = { settlements?: Map<string, SettlementData> };

export function describeEvent(e: LedgerEvent, name: NameOf, ctx: DescribeContext = {}): Described {
  const by = name(e.actor);
  const settlementOf = (id: string) => ctx.settlements?.get(id);
  switch (e.type) {
    case "TRIP_CREATED":
      return { kind: "trip", icon: "flight-takeoff", tone: "blue", title: "Trip created", detail: `${e.trip.name} · ${e.trip.destination}` };
    case "TRIP_UPDATED":
      return {
        kind: "trip",
        icon: "edit",
        tone: "grey",
        title: "Trip details updated",
        detail: `by ${by}`,
        changes: Object.keys(e.after).map((k) => ({ label: k, before: String((e.before as Record<string, unknown>)[k] ?? "—"), after: String((e.after as Record<string, unknown>)[k]) })),
      };
    case "PARTICIPANT_ADDED":
      return { kind: "member", icon: "person-add-alt-1", tone: "mint", title: `${name(e.participant.id)} joined the trip`, detail: e.participant.upiId ? `UPI ${e.participant.upiId}` : "No UPI ID yet", participantId: e.participant.id };
    case "PARTICIPANT_UPDATED":
      if ("interests" in e.after && Object.keys(e.after).length === 1) {
        return { kind: "member", icon: "interests", tone: "lavender", title: `${name(e.participantId)} updated travel preferences`, detail: "Used for the trip's Harmony Score", participantId: e.participantId };
      }
      return {
        kind: "member",
        icon: "manage-accounts",
        tone: "grey",
        title: `${name(e.participantId)}'s details updated`,
        detail: `by ${by}`,
        participantId: e.participantId,
        changes: Object.keys(e.after).map((k) => ({ label: k === "upiId" ? "UPI ID" : k, before: String((e.before as Record<string, unknown>)[k] ?? "—"), after: String((e.after as Record<string, unknown>)[k] ?? "—") })),
      };
    case "TRIP_CLOSED":
      return {
        kind: "trip",
        icon: "flag",
        tone: "mint",
        title: "Trip closed",
        detail: `Planned ${formatMoney(e.summary.plannedPaise)} · actual ${formatMoney(e.summary.actualPaise)} · ${formatMoney(e.summary.outstandingPaise)} still to settle`,
        amountPaise: e.summary.actualPaise,
      };
    case "TRIP_REOPENED":
      return { kind: "trip", icon: "lock-open", tone: "amber", title: "Trip reopened", detail: `by ${by}` };
    case "PAYMENT_METHOD_ADDED":
      return {
        kind: "member",
        icon: "credit-card",
        tone: "lavender",
        title: `${name(e.participantId)} added ${e.method.label}`,
        detail: `${e.method.bank}${e.method.network ? ` · ${e.method.network}` : ""}${e.method.last4 ? ` · ••${e.method.last4}` : ""} — card metadata only, never a card number`,
        participantId: e.participantId,
      };
    case "PAYMENT_METHOD_REMOVED":
      return { kind: "member", icon: "credit-card-off", tone: "grey", title: `${e.label} removed`, detail: `from ${name(e.participantId)}'s methods`, participantId: e.participantId };
    case "ITINERARY_ITEM_ADDED":
      return {
        kind: "itinerary",
        icon: "event",
        tone: "blue",
        title: `${e.item.title} added to the itinerary`,
        detail: `${e.item.category} · estimated for ${e.item.participantIds.length} ${e.item.participantIds.length === 1 ? "person" : "people"}`,
        amountPaise: e.item.estimatedPaise,
        itemId: e.item.id,
      };
    case "ITINERARY_IMPORTED":
      return {
        kind: "itinerary",
        icon: "upload-file",
        tone: "blue",
        title: `${e.items.length} itinerary item${e.items.length === 1 ? "" : "s"} imported`,
        detail: `from ${e.sourceName} · reviewed before saving`,
        amountPaise: e.items.reduce((sum, i) => sum + i.estimatedPaise, 0),
      };
    case "ITINERARY_ITEM_UPDATED": {
      const changes: Described["changes"] = [];
      if (e.before.estimatedPaise !== e.after.estimatedPaise) {
        changes.push({ label: "Estimate", before: formatMoney(e.before.estimatedPaise), after: formatMoney(e.after.estimatedPaise) });
      }
      if (e.before.title !== e.after.title) changes.push({ label: "Title", before: e.before.title, after: e.after.title });
      if (e.before.date !== e.after.date) changes.push({ label: "Date", before: e.before.date, after: e.after.date });
      if ((e.before.endDate ?? "") !== (e.after.endDate ?? "")) changes.push({ label: "Ends", before: e.before.endDate ?? "—", after: e.after.endDate ?? "—" });
      if (e.before.participantIds.length !== e.after.participantIds.length) {
        changes.push({ label: "For", before: `${e.before.participantIds.length} people`, after: `${e.after.participantIds.length} people` });
      }
      if (e.before.status !== e.after.status) changes.push({ label: "Status", before: e.before.status, after: e.after.status });
      const delta = e.after.estimatedPaise - e.before.estimatedPaise;
      return {
        kind: "itinerary",
        icon: "edit-calendar",
        tone: delta === 0 ? "grey" : delta > 0 ? "amber" : "mint",
        title: `${e.after.title} updated`,
        detail: delta === 0 ? `Edited by ${by} · budget unchanged` : `Budget ${delta > 0 ? "up" : "down"} ${formatMoney(Math.abs(delta))} · every share re-derived`,
        amountPaise: e.after.estimatedPaise,
        itemId: e.itemId,
        changes,
      };
    }
    case "ITINERARY_ITEM_REMOVED":
      return {
        kind: "itinerary",
        icon: "event-busy",
        tone: "coral",
        title: `${e.item.title} removed from the itinerary`,
        detail: `Budget down ${formatMoney(e.item.estimatedPaise)}`,
        amountPaise: e.item.estimatedPaise,
      };
    case "CONTRIBUTION_RECORDED":
      return {
        kind: "funding",
        icon: "savings",
        tone: "mint",
        title: e.contribution.direction === "out" ? `${name(e.contribution.participantId)} withdrew unspent money from the pool` : `${name(e.contribution.participantId)} added money to the trip pool`,
        detail: `${e.contribution.method === "razorpay" ? "Razorpay (test mode) · verified by the server" : e.contribution.method === "upi" ? "UPI" : "Cash"}${e.contribution.reference ? ` · ${e.contribution.reference}` : ""}`,
        amountPaise: e.contribution.amountPaise,
        participantId: e.contribution.participantId,
      };
    case "CONTRIBUTION_REMOVED":
      return { kind: "funding", icon: "undo", tone: "grey", title: "Contribution removed", detail: `by ${by}`, amountPaise: e.contribution.amountPaise };
    case "PARTICIPANT_REMOVED":
      return {
        kind: "member",
        icon: "person-remove",
        tone: "coral",
        title: `${e.name} left the trip`,
        detail:
          e.removedFromExpenses.length || e.removedFromItinerary.length
            ? `Removed from ${e.removedFromExpenses.length} expense${e.removedFromExpenses.length === 1 ? "" : "s"} and ${e.removedFromItinerary.length} itinerary item${e.removedFromItinerary.length === 1 ? "" : "s"} · shares re-derived`
            : "Was not part of any expense",
        participantId: e.participantId,
      };
    case "EXPENSE_ADDED":
      return {
        kind: "expense",
        icon: "receipt-long",
        tone: "blue",
        title: `${e.expense.title} added`,
        detail: `Paid by ${list(e.expense.payers.map((p) => p.participantId), name)} · shared by ${e.expense.participants.length} ${e.expense.participants.length === 1 ? "person" : "people"}`,
        amountPaise: e.expense.amountPaise,
        expenseId: e.expense.id,
      };
    case "EXPENSE_UPDATED": {
      const changes: Described["changes"] = [];
      if (e.before.amountPaise !== e.after.amountPaise) changes.push({ label: "Amount", before: formatMoney(e.before.amountPaise), after: formatMoney(e.after.amountPaise) });
      if (e.before.title !== e.after.title) changes.push({ label: "Title", before: e.before.title, after: e.after.title });
      if (e.before.date !== e.after.date) changes.push({ label: "Date", before: e.before.date, after: e.after.date });
      if (e.before.category !== e.after.category) changes.push({ label: "Category", before: e.before.category, after: e.after.category });
      const beforeP = e.before.participants.map((p) => p.participantId);
      const afterP = e.after.participants.map((p) => p.participantId);
      const left = beforeP.filter((id) => !afterP.includes(id));
      const joined = afterP.filter((id) => !beforeP.includes(id));
      if (left.length || joined.length) {
        changes.push({ label: "Shared by", before: `${beforeP.length} people`, after: `${afterP.length} people${left.length ? ` · ${list(left, name)} out` : ""}${joined.length ? ` · ${list(joined, name)} in` : ""}` });
      } else if (JSON.stringify(e.before.participants) !== JSON.stringify(e.after.participants) || e.before.splitMode !== e.after.splitMode) {
        changes.push({ label: "Split", before: e.before.splitMode, after: e.after.splitMode });
      }
      const beforePay = e.before.payers.map((p) => `${name(p.participantId)} ${formatMoney(p.amountPaise)}`).join(", ");
      const afterPay = e.after.payers.map((p) => `${name(p.participantId)} ${formatMoney(p.amountPaise)}`).join(", ");
      if (beforePay !== afterPay) changes.push({ label: "Paid by", before: beforePay, after: afterPay });
      const detail = left.length && !joined.length && changes.length === 1 ? `${list(left, name)} dropped out · every share re-derived` : changes.length ? `${changes.length} change${changes.length === 1 ? "" : "s"} by ${by}` : `Edited by ${by}`;
      return { kind: "expense", icon: "edit-note", tone: "amber", title: `${e.after.title} edited`, detail, amountPaise: e.after.amountPaise, expenseId: e.expenseId, changes };
    }
    case "EXPENSE_DELETED":
      return { kind: "expense", icon: "delete-outline", tone: "coral", title: `${e.expense.title} deleted`, detail: `Removed by ${by} · all shares from it withdrawn`, amountPaise: e.expense.amountPaise };
    case "EXPENSE_CANCELLED":
      return {
        kind: "refund",
        icon: "event-busy",
        tone: "coral",
        title: "Booking cancelled under vendor policy",
        detail: `${e.refundPercent}% refundable · ${formatMoney(e.recoverablePaise)} recovered${e.refund ? ` by ${name(e.refund.receivedBy)}` : ""} · ${formatMoney(e.lossPaise)} unrecoverable stays shared`,
        amountPaise: e.recoverablePaise,
        expenseId: e.expenseId,
      };
    case "PARTICIPANT_WITHDRAWN": {
      const w = e.withdrawal;
      const who = name(w.participantId);
      const detail =
        w.pricing === "per-head"
          ? `Per-seat booking · ${w.refundPercent}% of the ${formatMoney(w.seatPaise)} seat refunded (${formatMoney(w.refundPaise)}) · ${formatMoney(w.retainedPaise)} non-refundable stays with ${who} · others unchanged`
          : w.rule === "leaver-pays"
            ? `Fixed-price booking · vendor refunds nothing · ${who} keeps paying ${formatMoney(w.retainedPaise)} · others unchanged`
            : `Fixed-price booking · vendor refunds nothing · ${formatMoney(w.seatPaise)} re-split across the remaining people`;
      return { kind: "expense", icon: "person-remove", tone: "coral", title: `${who} dropped out of ${e.expenseTitle}`, detail, amountPaise: w.seatPaise, expenseId: e.expenseId, participantId: w.participantId };
    }
    case "PARTICIPANT_LEFT":
      return { kind: "member", icon: "logout", tone: "coral", title: `${e.name} left the trip`, detail: `From ${e.date} · stays on the books until settled`, participantId: e.participantId };
    case "REFUND_RECORDED":
      return {
        kind: "refund",
        icon: "replay",
        tone: "lavender",
        title: "Refund routed to cost-bearers",
        detail: `${name(e.refund.receivedBy)} received it${e.refund.reason ? ` · ${e.refund.reason}` : ""}`,
        amountPaise: e.refund.amountPaise,
        expenseId: e.refund.expenseId,
      };
    case "REFUND_DELETED":
      return { kind: "refund", icon: "undo", tone: "grey", title: "Refund removed", detail: `by ${by}`, amountPaise: e.refund.amountPaise, expenseId: e.refund.expenseId };
    case "SETTLEMENT_INITIATED":
      return {
        kind: "settlement",
        icon: e.settlement.method === "upi" ? "qr-code-2" : "payments",
        tone: "amber",
        title: `${name(e.settlement.from)} → ${name(e.settlement.to)} · payment initiated`,
        detail: `${e.settlement.method === "upi" ? "UPI" : "Cash"}${e.settlement.reference ? ` · ${e.settlement.reference}` : ""} · awaiting confirmation`,
        amountPaise: e.settlement.amountPaise,
      };
    case "SETTLEMENT_CONFIRMED": {
      const s = settlementOf(e.settlementId);
      return {
        kind: "settlement",
        icon: "check-circle",
        tone: "mint",
        title: s ? `${name(s.from)} → ${name(s.to)} · payment confirmed` : "Payment confirmed",
        detail: `Confirmed by ${by} · balances updated`,
        amountPaise: s?.amountPaise,
      };
    }
    case "SETTLEMENT_CANCELLED": {
      const s = settlementOf(e.settlementId);
      return {
        kind: "settlement",
        icon: "cancel",
        tone: "grey",
        title: s ? `${name(s.from)} → ${name(s.to)} · payment cancelled` : "Payment cancelled",
        detail: e.reason ?? `by ${by}`,
        amountPaise: s?.amountPaise,
      };
    }
  }
}
