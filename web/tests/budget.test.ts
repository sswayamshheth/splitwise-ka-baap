import { describe, expect, it } from "vitest";

import { applyScenario, computeBudget, diffBudget } from "../lib/ledger/budget";
import {
  addExpense,
  addItineraryItem,
  addParticipant,
  CommandError,
  createTrip,
  expenseDraftFromItem,
  removeItineraryItem,
  updateItineraryItem,
  type ItineraryInput,
} from "../lib/ledger/commands";
import { computeLedger } from "../lib/ledger/engine";
import { reduceEvents } from "../lib/ledger/reduce";
import type { LedgerEvent, TripState } from "../lib/ledger/types";
import { sumPaise } from "../lib/money";

const ctx = { actor: "system" as const, now: 1_700_000_000_000 };

function build() {
  const log: LedgerEvent[] = [];
  const { events } = createTrip({ name: "Manali", destination: "Manali", startDate: "2026-12-12", endDate: "2026-12-16" }, ctx);
  log.push(...events);
  const state = () => reduceEvents(log) as TripState;
  const push = (e: LedgerEvent) => {
    log.push(e);
    return state();
  };
  const ids: Record<string, string> = {};
  for (const name of ["A", "B", "C", "D", "E", "F"]) {
    const ev = addParticipant(state(), { name }, ctx);
    push(ev);
    ids[name] = (ev as Extract<LedgerEvent, { type: "PARTICIPANT_ADDED" }>).participant.id;
  }
  return { log, state, push, ids };
}

function item(state: TripState, ids: Record<string, string>, title: string, paise: number, people: string[], extra: Partial<ItineraryInput> = {}) {
  return addItineraryItem(
    state,
    { title, category: "Stay", date: "2026-12-12", estimatedPaise: paise, participantIds: people.map((p) => ids[p]), ...extra } as ItineraryInput,
    ctx,
  );
}

describe("itinerary-driven budget", () => {
  it("estimates the trip from the itinerary and splits it by who is on each item", () => {
    const { state, push, ids } = build();
    push(item(state(), ids, "Hotel", 62_000_00, ["A", "B", "C", "D", "E", "F"]));
    push(item(state(), ids, "Transport", 30_000_00, ["A", "B", "C", "D", "E", "F"], { category: "Transport" }));
    push(item(state(), ids, "Paragliding", 24_000_00, ["A", "B"], { category: "Activity" }));
    push(item(state(), ids, "Food", 30_000_00, ["A", "B", "C", "D", "E", "F"], { category: "Food" }));
    push(item(state(), ids, "Local travel", 15_000_00, ["A", "B", "C", "D", "E", "F"], { category: "Local travel" }));
    push(item(state(), ids, "Misc", 9_000_00, ["A", "B", "C", "D", "E", "F"], { category: "Other" }));

    const budget = computeBudget(state());
    expect(budget.estimatedPaise).toBe(1_70_000_00);
    expect(budget.perPersonFlatPaise).toBe(Math.round(1_70_000_00 / 6));
    // Categories add up to the total and carry their share of it.
    expect(sumPaise(budget.categories.map((c) => c.estimatedPaise))).toBe(1_70_000_00);
    expect(budget.categories.find((c) => c.category === "Stay")!.estimatedPaise).toBe(62_000_00);
    // Participation-aware: A and B carry the paragliding, the others don't.
    expect(sumPaise(Object.values(budget.estimatedPerParticipant))).toBe(1_70_000_00);
    expect(budget.estimatedPerParticipant[ids.A]).toBeGreaterThan(budget.estimatedPerParticipant[ids.C]);
    // A carries half the ₹24,000 paragliding that C is not on; the rest of the
    // trip is shared six ways, where largest-remainder can differ by one paisa.
    expect(Math.abs(budget.estimatedPerParticipant[ids.A] - budget.estimatedPerParticipant[ids.C] - 12_000_00)).toBeLessThanOrEqual(1);
  });

  it("the brief's what-if: hotel 62k → 75k, then drop a 5k activity", () => {
    const { state, push, ids } = build();
    const hotelEvent = push(item(state(), ids, "Hotel", 62_000_00, ["A", "B", "C", "D", "E", "F"]));
    const hotelId = hotelEvent.itinerary[0].id;
    push(item(state(), ids, "Transport", 30_000_00, ["A", "B", "C", "D", "E", "F"], { category: "Transport" }));
    push(item(state(), ids, "Paragliding", 24_000_00, ["A", "B", "C", "D", "E", "F"], { category: "Activity" }));
    push(item(state(), ids, "Food", 30_000_00, ["A", "B", "C", "D", "E", "F"], { category: "Food" }));
    push(item(state(), ids, "Local travel", 15_000_00, ["A", "B", "C", "D", "E", "F"], { category: "Local travel" }));
    push(item(state(), ids, "Misc", 9_000_00, ["A", "B", "C", "D", "E", "F"], { category: "Other" }));
    const walk = push(item(state(), ids, "Village walk", 5_000_00, ["A", "B", "C", "D", "E", "F"], { category: "Activity" }));
    const walkId = walk.itinerary[walk.itinerary.length - 1].id;

    const before = computeBudget(state());
    expect(before.estimatedPaise).toBe(1_75_000_00);

    const hotel = state().itinerary.find((i) => i.id === hotelId)!;
    const afterHotel = push(
      updateItineraryItem(
        state(),
        hotelId,
        { ...hotel, estimatedPaise: 75_000_00, participantIds: hotel.participantIds } as ItineraryInput,
        ctx,
      ),
    );
    expect(computeBudget(afterHotel).estimatedPaise).toBe(1_88_000_00);

    const afterRemove = push(removeItineraryItem(state(), walkId, ctx));
    const final = computeBudget(afterRemove);
    expect(final.estimatedPaise).toBe(1_83_000_00);
    expect(final.estimatedPaise - before.estimatedPaise).toBe(8_000_00);
  });

  it("explains a budget change line by line", () => {
    const { state, push, ids } = build();
    const added = push(item(state(), ids, "Hotel", 62_000_00, ["A", "B", "C", "D", "E", "F"]));
    const before = state();
    const hotelId = added.itinerary[0].id;
    const hotel = before.itinerary[0];
    const after = push(updateItineraryItem(before, hotelId, { ...hotel, estimatedPaise: 75_000_00, participantIds: hotel.participantIds } as ItineraryInput, ctx));

    const diff = diffBudget(before, after);
    expect(diff.beforePaise).toBe(62_000_00);
    expect(diff.afterPaise).toBe(75_000_00);
    expect(diff.deltaPaise).toBe(13_000_00);
    expect(diff.lines).toHaveLength(1);
    expect(diff.lines[0].reason).toMatch(/cost increased/);
    // ₹13,000 over six people: each moves by about ₹2,166.67, and the parts add up exactly.
    expect(Math.abs(diff.perParticipant[ids.A].delta - Math.round(13_000_00 / 6))).toBeLessThanOrEqual(1);
    expect(sumPaise(Object.values(diff.perParticipant).map((p) => p.delta))).toBe(13_000_00);
  });

  it("scenarios never touch the log", () => {
    const { state, push, ids } = build();
    const ev = push(item(state(), ids, "Hotel", 62_000_00, ["A", "B", "C", "D", "E", "F"], { endDate: "2026-12-16" }));
    const id = ev.itinerary[0].id;
    const withExtraNight = applyScenario(state(), { extraNights: 2 });
    const diff = diffBudget(state(), withExtraNight);
    // 4 nights at 62,000 → 15,500 a night → two more nights is 31,000
    expect(diff.deltaPaise).toBe(31_000_00);
    expect(state().itinerary[0].estimatedPaise).toBe(62_000_00);

    const dropped = applyScenario(state(), { removed: [id] });
    expect(computeBudget(dropped).estimatedPaise).toBe(0);

    const fewer = applyScenario(state(), { withoutParticipants: [ids.A, ids.B] });
    const fewerBudget = computeBudget(fewer);
    expect(fewerBudget.estimatedPaise).toBe(62_000_00);
    expect(fewerBudget.perPersonFlatPaise).toBe(Math.round(62_000_00 / 4));
  });

  it("tracks planned vs actual and what the group still owes the vendor", () => {
    const { state, push, ids } = build();
    const ev = push(item(state(), ids, "Hotel", 62_000_00, ["A", "B", "C", "D", "E", "F"], { vendor: "Himalayan Nest" }));
    const id = ev.itinerary[0].id;
    expect(computeBudget(state()).vendorOutstandingPaise).toBe(62_000_00);

    // A part payment: ₹40,000 of a ₹62,000 booking.
    const draft = expenseDraftFromItem(state().itinerary[0], ids.A);
    push(addExpense(state(), { ...draft, amountPaise: 40_000_00, payers: [{ participantId: ids.A, amountPaise: 40_000_00 }] }, ctx));

    const budget = computeBudget(state());
    const line = budget.byItemId[id];
    expect(line.paidPaise).toBe(40_000_00);
    expect(line.actualPaise).toBe(40_000_00);
    expect(line.variancePaise).toBe(-22_000_00);
    expect(line.vendorOutstandingPaise).toBe(22_000_00);
    expect(state().itinerary[0].status).toBe("booked");

    const ledger = computeLedger(state());
    expect(ledger.reconciliationPaise).toBe(0);
    expect(ledger.vendors).toHaveLength(1);
    expect(ledger.vendors[0].outstandingPaise).toBe(22_000_00);
    // Member balances only ever reflect money that actually moved.
    expect(ledger.balances[ids.A].netPaise).toBe(40_000_00 - ledger.balances[ids.A].sharePaise);
    expect(ledger.balances[ids.A].sharePaise).toBe(ledger.byExpenseId[Object.keys(ledger.byExpenseId)[0]].shares[ids.A]);
  });

  it("refuses to remove an item that has already been paid for", () => {
    const { state, push, ids } = build();
    const ev = push(item(state(), ids, "Hotel", 10_000_00, ["A", "B"]));
    const id = ev.itinerary[0].id;
    push(addExpense(state(), expenseDraftFromItem(state().itinerary[0], ids.A), ctx));
    expect(() => removeItineraryItem(state(), id, ctx)).toThrow(/Cancel it instead/);
  });

  it("validates itinerary input", () => {
    const { state, ids } = build();
    expect(() => item(state(), ids, "", 100, ["A"])).toThrow(CommandError);
    expect(() => item(state(), ids, "Nobody", 100, [])).toThrow(/Pick who this is for/);
    expect(() => item(state(), ids, "Bad date", 100, ["A"], { date: "nope" } as Partial<ItineraryInput>)).toThrow(/YYYY-MM-DD/);
    expect(() => item(state(), ids, "Bad range", 100, ["A"], { endDate: "2026-12-01" } as Partial<ItineraryInput>)).toThrow(/before the start/);
  });
});
