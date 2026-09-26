import { withoutPlanParticipant } from "./policy";
import type { ExpenseView, LedgerEvent, TripState } from "./types";

/**
 * Replays an event log into the current trip state. Pure and deterministic:
 * the same log always yields the same state, and any historical position can
 * be rebuilt by replaying a prefix of the log.
 */
export function reduceEvents(events: LedgerEvent[]): TripState | null {
  let state: TripState | null = null;
  for (const event of events) {
    state = applyEvent(state, event);
  }
  return state;
}

export function applyEvent(state: TripState | null, event: LedgerEvent): TripState | null {
  if (event.type === "TRIP_CREATED") {
    return { trip: event.trip, participants: [], itinerary: [], expenses: [], refunds: [], settlements: [], contributions: [] };
  }
  if (!state) return null;

  switch (event.type) {
    case "TRIP_UPDATED":
      return { ...state, trip: { ...state.trip, ...event.after } };

    case "TRIP_CLOSED":
      return { ...state, trip: { ...state.trip, status: "closed" }, closedAt: event.ts };

    case "TRIP_REOPENED":
      return { ...state, trip: { ...state.trip, status: "active" }, closedAt: undefined };

    case "PARTICIPANT_ADDED":
      if (state.participants.some((p) => p.id === event.participant.id)) return state;
      return { ...state, participants: [...state.participants, event.participant] };

    case "PARTICIPANT_UPDATED":
      return {
        ...state,
        participants: state.participants.map((p) => (p.id === event.participantId ? { ...p, ...event.after } : p)),
      };

    case "PARTICIPANT_REMOVED":
      return {
        ...state,
        participants: state.participants.filter((p) => p.id !== event.participantId),
        expenses: state.expenses.map((expense) =>
          event.removedFromExpenses.includes(expense.id)
            ? { ...expense, participants: expense.participants.filter((x) => x.participantId !== event.participantId) }
            : expense,
        ),
        itinerary: state.itinerary.map((item) => {
          if (!event.removedFromItinerary.includes(item.id)) return item;
          const index = item.participantIds.indexOf(event.participantId);
          if (index < 0) return item;
          return {
            ...item,
            participantIds: item.participantIds.filter((id) => id !== event.participantId),
            weights: item.weights ? item.weights.filter((_, i) => i !== index) : undefined,
          };
        }),
      };

    case "PAYMENT_METHOD_ADDED":
      return {
        ...state,
        participants: state.participants.map((p) =>
          p.id === event.participantId
            ? { ...p, paymentMethods: [...(p.paymentMethods ?? []).filter((m) => m.id !== event.method.id), event.method] }
            : p,
        ),
      };

    case "PAYMENT_METHOD_REMOVED":
      return {
        ...state,
        participants: state.participants.map((p) =>
          p.id === event.participantId ? { ...p, paymentMethods: (p.paymentMethods ?? []).filter((m) => m.id !== event.methodId) } : p,
        ),
      };

    case "ITINERARY_ITEM_ADDED":
      if (state.itinerary.some((i) => i.id === event.item.id)) return state;
      return { ...state, itinerary: [...state.itinerary, event.item] };

    case "ITINERARY_IMPORTED": {
      const existing = new Set(state.itinerary.map((i) => i.id));
      return { ...state, itinerary: [...state.itinerary, ...event.items.filter((i) => !existing.has(i.id))] };
    }

    case "ITINERARY_ITEM_UPDATED":
      return { ...state, itinerary: state.itinerary.map((i) => (i.id === event.itemId ? event.after : i)) };

    case "ITINERARY_ITEM_REMOVED":
      return {
        ...state,
        itinerary: state.itinerary.filter((i) => i.id !== event.itemId),
        // Expenses already recorded against it stay in the ledger; they just lose the link.
        expenses: state.expenses.map((e) => (e.itineraryItemId === event.itemId ? { ...e, itineraryItemId: undefined } : e)),
      };

    case "EXPENSE_ADDED": {
      if (state.expenses.some((e) => e.id === event.expense.id)) return state;
      const view: ExpenseView = { ...event.expense, status: "active" };
      return {
        ...state,
        expenses: [...state.expenses, view],
        itinerary: state.itinerary.map((i) =>
          i.id === event.expense.itineraryItemId ? { ...i, expenseIds: [...i.expenseIds, event.expense.id], status: i.status === "planned" ? "booked" : i.status } : i,
        ),
      };
    }

    case "EXPENSE_UPDATED": {
      const previousItem = event.before.itineraryItemId;
      const nextItem = event.after.itineraryItemId;
      let itinerary = state.itinerary;
      if (previousItem !== nextItem) {
        itinerary = itinerary.map((i) => {
          if (i.id === previousItem) return { ...i, expenseIds: i.expenseIds.filter((x) => x !== event.expenseId) };
          if (i.id === nextItem) return { ...i, expenseIds: [...i.expenseIds, event.expenseId], status: i.status === "planned" ? "booked" : i.status };
          return i;
        });
      }
      return { ...state, itinerary, expenses: state.expenses.map((e) => (e.id === event.expenseId ? { ...e, ...event.after } : e)) };
    }

    case "EXPENSE_DELETED":
      return {
        ...state,
        expenses: state.expenses.filter((e) => e.id !== event.expenseId),
        refunds: state.refunds.filter((r) => r.expenseId !== event.expenseId),
        itinerary: state.itinerary.map((i) => (i.expenseIds.includes(event.expenseId) ? { ...i, expenseIds: i.expenseIds.filter((x) => x !== event.expenseId) } : i)),
      };

    case "EXPENSE_CANCELLED":
      return {
        ...state,
        expenses: state.expenses.map((e) =>
          e.id === event.expenseId
            ? {
                ...e,
                status: "cancelled",
                cancellation: {
                  recoverablePaise: event.recoverablePaise,
                  lossPaise: event.lossPaise,
                  refundPercent: event.refundPercent,
                  ts: event.ts,
                },
              }
            : e,
        ),
        itinerary: state.itinerary.map((i) => (i.expenseIds.includes(event.expenseId) ? { ...i, status: "cancelled" } : i)),
        refunds: event.refund ? [...state.refunds, event.refund] : state.refunds,
      };

    case "PARTICIPANT_WITHDRAWN": {
      const { participantId } = event.withdrawal;
      const target = state.expenses.find((e) => e.id === event.expenseId);
      return {
        ...state,
        expenses: state.expenses.map((e) =>
          e.id === event.expenseId
            ? {
                ...e,
                participants: e.participants.filter((p) => p.participantId !== participantId),
                withdrawals: [...(e.withdrawals ?? []), event.withdrawal],
              }
            : e,
        ),
        // Keep the plan consistent with the money: they are no longer on the linked item either.
        // A per-head seat also leaves the plan estimate; a fixed price stays and is re-split.
        itinerary: state.itinerary.map((item) =>
          target?.itineraryItemId && item.id === target.itineraryItemId ? withoutPlanParticipant(item, participantId, event.withdrawal.pricing === "per-head") : item,
        ),
        refunds: event.refund && !state.refunds.some((r) => r.id === event.refund!.id) ? [...state.refunds, event.refund] : state.refunds,
      };
    }

    case "PARTICIPANT_LEFT":
      return {
        ...state,
        participants: state.participants.map((p) => (p.id === event.participantId ? { ...p, leftOn: event.date } : p)),
      };

    case "REFUND_RECORDED":
      if (state.refunds.some((r) => r.id === event.refund.id)) return state;
      return { ...state, refunds: [...state.refunds, event.refund] };

    case "REFUND_DELETED":
      return { ...state, refunds: state.refunds.filter((r) => r.id !== event.refundId) };

    case "SETTLEMENT_INITIATED":
      if (state.settlements.some((s) => s.id === event.settlement.id)) return state;
      return { ...state, settlements: [...state.settlements, event.settlement] };

    case "SETTLEMENT_CONFIRMED":
      return {
        ...state,
        settlements: state.settlements.map((s) =>
          s.id === event.settlementId && s.status === "initiated" ? { ...s, status: "confirmed", confirmedTs: event.confirmedTs } : s,
        ),
      };

    case "SETTLEMENT_CANCELLED":
      return {
        ...state,
        settlements: state.settlements.map((s) =>
          s.id === event.settlementId && s.status !== "confirmed" ? { ...s, status: "cancelled", cancelledTs: event.ts } : s,
        ),
      };

    case "CONTRIBUTION_RECORDED":
      if (state.contributions.some((c) => c.id === event.contribution.id)) return state;
      return { ...state, contributions: [...state.contributions, event.contribution] };

    case "CONTRIBUTION_REMOVED":
      return { ...state, contributions: state.contributions.filter((c) => c.id !== event.contributionId) };

    default:
      return state;
  }
}
