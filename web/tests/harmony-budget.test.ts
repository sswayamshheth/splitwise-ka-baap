import { describe, expect, it } from "vitest";

import { computeHarmony, itemTags } from "@/lib/interests";
import { createTrip } from "@/lib/ledger/commands";
import { buildGoaEvents } from "@/lib/ledger/demo-goa";
import { categoryBudgets, DEFAULT_BUDGET_SPLIT, setTripBudget } from "@/lib/ledger/pool";
import { reduceEvents } from "@/lib/ledger/reduce";

describe("harmony score", () => {
  it("identical tastes score high; opposite tastes score low; missing prefs give no score", () => {
    const like = { diet: "veg" as const, pace: "balanced" as const, cuisines: ["South Indian"], activities: ["water", "culture"] };
    const same = computeHarmony([{ id: "a", name: "A", interests: like }, { id: "b", name: "B", interests: like }], []);
    expect(same.score).toBe(100);
    const diff = computeHarmony(
      [
        { id: "a", name: "A", interests: { diet: "jain", pace: "relaxed", cuisines: ["Gujarati"], activities: ["culture"] } },
        { id: "b", name: "B", interests: { diet: "non-veg", pace: "packed", cuisines: ["Seafood"], activities: ["nightlife", "adventure"] } },
      ],
      [],
    );
    expect(diff.score!).toBeLessThan(40);
    expect(diff.conflicts.length).toBeGreaterThan(0);
    expect(computeHarmony([{ id: "a", name: "A" }, { id: "b", name: "B" }], []).score).toBeNull();
  });

  it("the Goa demo has a score, shared interests and per-member variations", () => {
    const state = reduceEvents(buildGoaEvents(new Date(2026, 8, 26, 12).getTime()))!;
    const h = computeHarmony(
      state.participants.map((p) => ({ id: p.id, name: p.name, interests: p.interests })),
      state.itinerary.map((i) => ({ id: i.id, title: i.title, category: i.category, vendor: i.vendor, participantIds: i.participantIds })),
    );
    expect(h.score).not.toBeNull();
    expect(h.coverage).toEqual({ withPrefs: 6, total: 6 });
    expect(h.sharedInterests.some((s) => s.id === "water")).toBe(true);
    expect(h.perMember.some((m) => m.variations.length > 0)).toBe(true);
    expect(itemTags({ title: "Scuba at Grande Island", category: "Activity" })).toContain("water");
  });
});

describe("trip budget", () => {
  const state = reduceEvents(createTrip({ name: "T", destination: "Goa", startDate: "2026-10-10", endDate: "2026-10-12" }, { actor: "system" }).events)!;
  it("splits a total by category percentages exactly, and rejects splits that don't add to 100", () => {
    const e = setTripBudget(state, { totalPaise: 75_000_00, split: DEFAULT_BUDGET_SPLIT }, { actor: "system" });
    const next = reduceEvents([...createTrip({ name: "T", destination: "Goa", startDate: "2026-10-10", endDate: "2026-10-12" }, { actor: "system" }).events.map((x) => ({ ...x, trip: { ...(x as { trip: object }).trip, id: state.trip.id } })) as never[], e])!;
    const cats = categoryBudgets(next);
    expect(cats.find((c) => c.category === "Stay")!.paise).toBe(30_000_00);
    expect(cats.reduce((s, c) => s + c.paise, 0)).toBe(75_000_00);
    expect(() => setTripBudget(state, { totalPaise: 75_000_00, split: { Stay: 50, Food: 20 } }, { actor: "system" })).toThrow(/100/);
  });
});
