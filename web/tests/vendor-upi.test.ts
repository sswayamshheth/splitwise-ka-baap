import { describe, expect, it } from "vitest";

import { addItineraryItem, CommandError, updateItineraryItem, upiIntentUrl, parseUpiIntent } from "@/lib/ledger/commands";
import { buildGoaEvents, GOA } from "@/lib/ledger/demo-goa";
import { computeLedger } from "@/lib/ledger/engine";
import { depositToPool, payVendorFromPool } from "@/lib/ledger/pool";
import { applyEvent, reduceEvents } from "@/lib/ledger/reduce";

const base = reduceEvents(buildGoaEvents(new Date(2026, 8, 26, 12).getTime()))!;
const everyone = base.participants.map((p) => p.id);

describe("vendor UPI on itinerary items", () => {
  it("round-trips through add and edit, and rejects malformed UPI IDs", () => {
    const e = addItineraryItem(base, { title: "Boat ride", category: "Activity", date: "2026-10-11", estimatedPaise: 3_000_00, participantIds: everyone, vendor: "Ravi Boats", vendorUpi: "raviboats@okaxis", vendorUpiName: "Ravi Boats" }, { actor: GOA.aarav });
    const s1 = applyEvent(base, e)!;
    const item = s1.itinerary.find((i) => i.title === "Boat ride")!;
    expect(item.vendorUpi).toBe("raviboats@okaxis");
    const edit = updateItineraryItem(s1, item.id, { ...item, estimatedPaise: 3_500_00 }, { actor: GOA.aarav });
    expect(applyEvent(s1, edit)!.itinerary.find((i) => i.id === item.id)!.vendorUpi).toBe("raviboats@okaxis");
    expect(() => addItineraryItem(base, { title: "Bad", category: "Activity", date: "2026-10-11", estimatedPaise: 100, participantIds: everyone, vendorUpi: "not a upi" }, { actor: GOA.aarav })).toThrow(CommandError);
  });

  it("the UPI request encodes vendor, name and amount, and a UPI-paid booking is recorded against the pool", () => {
    const url = upiIntentUrl({ vpa: "raviboats@okaxis", name: "Ravi Boats", amountPaise: 3_000_00, note: "Boat ride" });
    expect(parseUpiIntent(url)).toMatchObject({ vpa: "raviboats@okaxis", name: "Ravi Boats", amountPaise: 3_000_00 });

    let s = applyEvent(base, depositToPool(base, { participantId: GOA.aarav, amountPaise: 6_000_00, method: "upi" }, { actor: GOA.aarav }))!;
    const add = addItineraryItem(s, { title: "Boat ride", category: "Activity", date: "2026-10-11", estimatedPaise: 3_000_00, participantIds: everyone, vendorUpi: "raviboats@okaxis" }, { actor: GOA.aarav });
    s = applyEvent(s, add)!;
    const item = s.itinerary.find((i) => i.title === "Boat ride")!;
    const pay = payVendorFromPool(
      s,
      { title: item.title, vendor: "Ravi Boats", amountPaise: 3_000_00, date: "2026-10-11", category: "Activity", participants: everyone.map((participantId) => ({ participantId, weight: 1 })), splitMode: "equal", itineraryItemId: item.id, capture: { kind: "manual", reference: "UPI UTR 427110998231 · raviboats@okaxis" } },
      { actor: GOA.aarav },
    );
    s = applyEvent(s, pay)!;
    expect(s.itinerary.find((i) => i.id === item.id)!.status).toBe("booked");
    const l = computeLedger(s);
    expect(l.reconciliationPaise).toBe(0);
    const expense = s.expenses.find((x) => x.itineraryItemId === item.id)!;
    expect(expense.fundedFromPool).toBe(true);
    expect(expense.capture?.reference).toContain("427110998231");
  });
});
