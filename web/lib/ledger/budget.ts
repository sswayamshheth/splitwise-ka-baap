import { allocate, sumPaise, type Paise } from "@/lib/money";
import { daysBetween } from "@/lib/dates";
import type { ExpenseCategory, ExpenseView, ItineraryItem, ParticipantId, RefundData, TripState } from "./types";
import { EXPENSE_CATEGORIES } from "./types";

/**
 * The budget derives entirely from the itinerary. An item carries an
 * estimate; once it is booked and paid, the linked expenses carry the actual.
 * Nothing about the budget is stored — change an itinerary item and every
 * number here moves with it.
 */

export type ItemBudget = {
  item: ItineraryItem;
  /** What we expect it to cost. */
  estimatedPaise: Paise;
  /** Price agreed with the vendor, when booked. Falls back to the estimate. */
  committedPaise: Paise;
  /** Money actually paid against it (sum of linked expense amounts). */
  paidPaise: Paise;
  /** Refunds received against its linked expenses. */
  refundedPaise: Paise;
  /** committed − paid: what the group still owes this vendor. */
  vendorOutstandingPaise: Paise;
  /** Net actual cost: paid − refunds. Undefined until something is paid. */
  actualPaise?: Paise;
  /** actual − estimated, when an actual exists. Positive = over budget. */
  variancePaise?: Paise;
  /** Estimated share per planned participant. Always sums to estimatedPaise. */
  estimatedShares: Record<ParticipantId, Paise>;
  /** Nights, for stays with an end date. */
  nights?: number;
};

export type CategoryBudget = {
  category: ExpenseCategory;
  estimatedPaise: Paise;
  actualPaise: Paise;
  committedPaise: Paise;
  count: number;
  /** Share of the estimated total, 0–1. */
  fraction: number;
};

export type Budget = {
  items: ItemBudget[];
  byItemId: Record<string, ItemBudget>;
  categories: CategoryBudget[];
  estimatedPaise: Paise;
  committedPaise: Paise;
  paidPaise: Paise;
  refundedPaise: Paise;
  actualPaise: Paise;
  variancePaise: Paise;
  vendorOutstandingPaise: Paise;
  /** Estimated total ÷ head count — the headline "per person" figure. */
  perPersonFlatPaise: Paise;
  /** Participation-aware estimate per member. Sums to estimatedPaise. */
  estimatedPerParticipant: Record<ParticipantId, Paise>;
  /** Expenses with no itinerary item behind them (ad-hoc spending). */
  unplannedPaise: Paise;
  plannedCount: number;
  bookedCount: number;
  cancelledCount: number;
};

function itemWeights(item: ItineraryItem): number[] {
  if (item.weights && item.weights.length === item.participantIds.length) return item.weights.map((w) => Math.max(0, w));
  return item.participantIds.map(() => 1);
}

export function computeItemBudget(item: ItineraryItem, expenses: ExpenseView[], refunds: RefundData[]): ItemBudget {
  const linked = expenses.filter((e) => item.expenseIds.includes(e.id));
  const paidPaise = sumPaise(linked.map((e) => e.amountPaise));
  const linkedIds = new Set(linked.map((e) => e.id));
  const refundedPaise = sumPaise(refunds.filter((r) => linkedIds.has(r.expenseId)).map((r) => r.amountPaise));
  const committedPaise = item.actualPaise ?? item.estimatedPaise;
  const hasActual = linked.length > 0;
  const actualPaise = hasActual ? paidPaise - refundedPaise : undefined;

  const shares: Record<ParticipantId, Paise> = {};
  const parts = allocate(item.estimatedPaise, itemWeights(item));
  item.participantIds.forEach((id, i) => {
    shares[id] = (shares[id] ?? 0) + parts[i];
  });

  const nights = item.endDate ? Math.max(0, daysBetween(item.date, item.endDate)) : undefined;

  return {
    item,
    estimatedPaise: item.estimatedPaise,
    committedPaise,
    paidPaise,
    refundedPaise,
    vendorOutstandingPaise: item.status === "cancelled" ? 0 : Math.max(0, committedPaise - paidPaise),
    actualPaise,
    variancePaise: actualPaise === undefined ? undefined : actualPaise - item.estimatedPaise,
    estimatedShares: shares,
    nights,
  };
}

export function computeBudget(state: TripState): Budget {
  const active = state.itinerary.filter((i) => i.status !== "cancelled");
  const items = state.itinerary.map((i) => computeItemBudget(i, state.expenses, state.refunds));
  const byItemId: Record<string, ItemBudget> = {};
  for (const b of items) byItemId[b.item.id] = b;
  const live = items.filter((b) => b.item.status !== "cancelled");

  const estimatedPaise = sumPaise(live.map((b) => b.estimatedPaise));
  const committedPaise = sumPaise(live.map((b) => b.committedPaise));
  const paidPaise = sumPaise(live.map((b) => b.paidPaise));
  const refundedPaise = sumPaise(live.map((b) => b.refundedPaise));
  const actualPaise = paidPaise - refundedPaise;

  const categories: CategoryBudget[] = EXPENSE_CATEGORIES.map((category) => {
    const inCat = live.filter((b) => b.item.category === category);
    const est = sumPaise(inCat.map((b) => b.estimatedPaise));
    return {
      category,
      estimatedPaise: est,
      actualPaise: sumPaise(inCat.map((b) => (b.actualPaise ?? 0))),
      committedPaise: sumPaise(inCat.map((b) => b.committedPaise)),
      count: inCat.length,
      fraction: estimatedPaise > 0 ? est / estimatedPaise : 0,
    };
  }).filter((c) => c.count > 0 || c.estimatedPaise > 0);

  const estimatedPerParticipant: Record<ParticipantId, Paise> = {};
  for (const p of state.participants) estimatedPerParticipant[p.id] = 0;
  for (const b of live) {
    for (const [id, share] of Object.entries(b.estimatedShares)) {
      estimatedPerParticipant[id] = (estimatedPerParticipant[id] ?? 0) + share;
    }
  }

  const plannedItemIds = new Set(state.itinerary.map((i) => i.id));
  const unplannedPaise = sumPaise(
    state.expenses.filter((e) => e.status === "active" && (!e.itineraryItemId || !plannedItemIds.has(e.itineraryItemId))).map((e) => e.amountPaise),
  );

  const headCount = Math.max(1, state.participants.length);
  return {
    items,
    byItemId,
    categories,
    estimatedPaise,
    committedPaise,
    paidPaise,
    refundedPaise,
    actualPaise,
    variancePaise: paidPaise > 0 ? actualPaise - estimatedPaise : 0,
    vendorOutstandingPaise: sumPaise(live.map((b) => b.vendorOutstandingPaise)),
    perPersonFlatPaise: Math.round(estimatedPaise / headCount),
    estimatedPerParticipant,
    unplannedPaise,
    plannedCount: active.filter((i) => i.status === "planned").length,
    bookedCount: active.filter((i) => i.status === "booked").length,
    cancelledCount: state.itinerary.length - active.length,
  };
}

// ---------------------------------------------------------------- diffing

export type BudgetLineChange = {
  itemId: string;
  title: string;
  kind: "added" | "removed" | "changed";
  beforePaise: Paise;
  afterPaise: Paise;
  deltaPaise: Paise;
  /** Human reason, e.g. "cost increased" / "3 more nights" / "2 fewer people". */
  reason: string;
};

export type BudgetDiff = {
  beforePaise: Paise;
  afterPaise: Paise;
  deltaPaise: Paise;
  lines: BudgetLineChange[];
  /** Per-participant estimated responsibility, before and after. */
  perParticipant: Record<ParticipantId, { before: Paise; after: Paise; delta: Paise }>;
  perPersonFlatBefore: Paise;
  perPersonFlatAfter: Paise;
};

/**
 * Compares two itineraries and explains the budget difference line by line.
 * Used for the "what changed in my budget" summary after an edit, and for
 * the what-if scenario screen before committing anything.
 */
export function diffBudget(before: TripState, after: TripState): BudgetDiff {
  const a = computeBudget(before);
  const b = computeBudget(after);
  const beforeById = new Map(before.itinerary.map((i) => [i.id, i]));
  const afterById = new Map(after.itinerary.map((i) => [i.id, i]));
  const lines: BudgetLineChange[] = [];

  const liveEstimate = (i: ItineraryItem | undefined) => (i && i.status !== "cancelled" ? i.estimatedPaise : 0);

  for (const [id, item] of afterById) {
    const prev = beforeById.get(id);
    const beforePaise = liveEstimate(prev);
    const afterPaise = liveEstimate(item);
    if (beforePaise === afterPaise && prev) continue;
    if (!prev) {
      lines.push({ itemId: id, title: item.title, kind: "added", beforePaise: 0, afterPaise, deltaPaise: afterPaise, reason: "added to the itinerary" });
      continue;
    }
    lines.push({
      itemId: id,
      title: item.title,
      kind: "changed",
      beforePaise,
      afterPaise,
      deltaPaise: afterPaise - beforePaise,
      reason: describeItemChange(prev, item),
    });
  }
  for (const [id, item] of beforeById) {
    if (afterById.has(id)) continue;
    const beforePaise = liveEstimate(item);
    if (beforePaise === 0) continue;
    lines.push({ itemId: id, title: item.title, kind: "removed", beforePaise, afterPaise: 0, deltaPaise: -beforePaise, reason: "removed from the itinerary" });
  }
  lines.sort((x, y) => Math.abs(y.deltaPaise) - Math.abs(x.deltaPaise));

  const perParticipant: BudgetDiff["perParticipant"] = {};
  const ids = new Set([...Object.keys(a.estimatedPerParticipant), ...Object.keys(b.estimatedPerParticipant)]);
  for (const id of ids) {
    const beforeShare = a.estimatedPerParticipant[id] ?? 0;
    const afterShare = b.estimatedPerParticipant[id] ?? 0;
    perParticipant[id] = { before: beforeShare, after: afterShare, delta: afterShare - beforeShare };
  }

  return {
    beforePaise: a.estimatedPaise,
    afterPaise: b.estimatedPaise,
    deltaPaise: b.estimatedPaise - a.estimatedPaise,
    lines,
    perParticipant,
    perPersonFlatBefore: a.perPersonFlatPaise,
    perPersonFlatAfter: b.perPersonFlatPaise,
  };
}

function describeItemChange(before: ItineraryItem, after: ItineraryItem): string {
  const bits: string[] = [];
  if (before.estimatedPaise !== after.estimatedPaise) bits.push(after.estimatedPaise > before.estimatedPaise ? "cost increased" : "cost reduced");
  if (before.status !== after.status) bits.push(after.status === "cancelled" ? "cancelled" : `marked ${after.status}`);
  const beforeNights = before.endDate ? daysBetween(before.date, before.endDate) : 0;
  const afterNights = after.endDate ? daysBetween(after.date, after.endDate) : 0;
  if (beforeNights !== afterNights) {
    const d = afterNights - beforeNights;
    bits.push(`${Math.abs(d)} ${Math.abs(d) === 1 ? "night" : "nights"} ${d > 0 ? "added" : "removed"}`);
  }
  if (before.participantIds.length !== after.participantIds.length) {
    const d = after.participantIds.length - before.participantIds.length;
    bits.push(`${Math.abs(d)} ${Math.abs(d) === 1 ? "person" : "people"} ${d > 0 ? "joined" : "left"}`);
  }
  return bits.length ? bits.join(" · ") : "updated";
}

/**
 * Applies a what-if scenario to a trip state without touching the event log.
 * The scenario screen builds one of these, renders the diff, and only then
 * turns it into real events if the user commits.
 */
export type Scenario = {
  /** Item id → estimate override, in paise. */
  estimates?: Record<string, Paise>;
  /** Items excluded from the scenario. */
  removed?: string[];
  /** Extra nights added to every stay. */
  extraNights?: number;
  /** Participants excluded from every item. */
  withoutParticipants?: ParticipantId[];
};

export function applyScenario(state: TripState, scenario: Scenario): TripState {
  const removed = new Set(scenario.removed ?? []);
  const without = new Set(scenario.withoutParticipants ?? []);
  const itinerary = state.itinerary
    .filter((i) => !removed.has(i.id))
    .map((item) => {
      let next = { ...item };
      const override = scenario.estimates?.[item.id];
      if (override !== undefined) next.estimatedPaise = override;
      if (scenario.extraNights && item.endDate && item.category === "Stay") {
        const nights = Math.max(1, daysBetween(item.date, item.endDate));
        const perNight = Math.round(next.estimatedPaise / nights);
        next.estimatedPaise = next.estimatedPaise + perNight * scenario.extraNights;
        const end = new Date(item.endDate);
        end.setDate(end.getDate() + scenario.extraNights);
        next.endDate = end.toISOString().slice(0, 10);
      }
      if (without.size) {
        const keep = next.participantIds.map((id, i) => ({ id, w: next.weights?.[i] ?? 1 })).filter((x) => !without.has(x.id));
        next.participantIds = keep.map((x) => x.id);
        next.weights = next.weights ? keep.map((x) => x.w) : undefined;
      }
      return next;
    });
  const participants = without.size ? state.participants.filter((p) => !without.has(p.id)) : state.participants;
  return { ...state, itinerary, participants };
}
