import { describe, expect, it } from "vitest";

import { itemTags } from "@/lib/interests";
import { planOffline } from "@/lib/itinerary/planner";
import { buildGoaEvents } from "@/lib/ledger/demo-goa";
import { reduceEvents } from "@/lib/ledger/reduce";

const state = reduceEvents(buildGoaEvents(new Date(2026, 8, 26, 12).getTime()))!;

describe("built-in plan assistant", () => {
  it("'add water sports' proposes real water activities for Goa, within the trip dates", () => {
    const p = planOffline(state, "add water sports");
    expect(p.understood).toBe(true);
    const adds = p.ops.filter((o) => o.op === "add");
    expect(adds.length).toBeGreaterThan(0);
    for (const a of adds) {
      if (a.op !== "add") continue;
      expect(itemTags({ title: a.item.title, category: a.item.category })).toContain("water");
      expect(a.item.date >= state.trip.startDate && a.item.date <= state.trip.endDate).toBe(true);
      expect(a.item.estimatedPaise).toBeGreaterThan(0);
      // Scuba is already booked on this trip — never suggest it again.
      expect(a.item.title.toLowerCase()).not.toContain("scuba");
    }
  });

  it("'add 2 nightlife on day 3' respects count and day", () => {
    const p = planOffline(state, "add 2 nightlife things on day 3");
    const adds = p.ops.filter((o) => o.op === "add");
    expect(adds.length).toBeGreaterThanOrEqual(1);
    expect(adds.every((a) => a.op === "add" && a.item.date === "2026-10-12")).toBe(true);
  });

  it("removes planned items by name but never paid bookings", () => {
    const p = planOffline(state, "remove the scooter rentals and scuba");
    expect(p.ops.some((o) => o.op === "remove" && o.title.startsWith("Scooter"))).toBe(true);
    expect(p.ops.some((o) => o.op === "remove" && o.title.startsWith("Scuba"))).toBe(false); // scuba is paid
    expect(p.summary).toMatch(/already paid/);
  });

  it("makes a new plan without touching paid items, and says when it doesn't understand", () => {
    const p = planOffline(state, "make a new plan for our group");
    expect(p.ops.some((o) => o.op === "add")).toBe(true);
    const paidIds = new Set(state.itinerary.filter((i) => i.expenseIds.length).map((i) => i.id));
    expect(p.ops.every((o) => o.op === "add" || !paidIds.has(o.itemId))).toBe(true);
    expect(planOffline(state, "hmm").understood).toBe(false);
  });

  it("moves an item to another day", () => {
    const p = planOffline(state, "move dinner to day 4");
    expect(p.ops).toEqual([expect.objectContaining({ op: "update", changes: { date: "2026-10-13" } })]);
  });
});
