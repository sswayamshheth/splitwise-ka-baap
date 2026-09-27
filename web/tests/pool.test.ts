import { describe, expect, it } from "vitest";

import { addParticipant, createTrip } from "@/lib/ledger/commands";
import { computeLedger } from "@/lib/ledger/engine";
import { depositToPool, payVendorFromPool, poolSummary, withdrawFromPool } from "@/lib/ledger/pool";
import { reduceEvents } from "@/lib/ledger/reduce";
import type { LedgerEvent } from "@/lib/ledger/types";

function trip() {
  const events: LedgerEvent[] = [];
  let now = 1_700_000_000_000;
  const ctx = () => ({ actor: "system" as const, now: now++ });
  events.push(...createTrip({ name: "Goa", destination: "Goa", startDate: "2026-10-10", endDate: "2026-10-14" }, ctx()).events);
  const ids: Record<string, string> = {};
  for (const name of ["A", "B", "C"]) {
    const e = addParticipant(reduceEvents(events)!, { name }, ctx());
    events.push(e);
    if (e.type === "PARTICIPANT_ADDED") ids[name] = e.participant.id;
  }
  const state = () => reduceEvents(events)!;
  return { events, ids, state, ctx };
}

describe("trip pool (organiser-held)", () => {
  it("vendor payments from the pool are funded pro rata by deposits, and balances stay exact", () => {
    const t = trip();
    t.events.push(depositToPool(t.state(), { participantId: t.ids.A, amountPaise: 10_000_00, method: "upi" }, t.ctx()));
    t.events.push(depositToPool(t.state(), { participantId: t.ids.B, amountPaise: 5_000_00, method: "upi" }, t.ctx()));
    t.events.push(
      payVendorFromPool(
        t.state(),
        { title: "Villa", amountPaise: 9_000_00, date: "2026-10-10", category: "Stay", participants: ["A", "B", "C"].map((n) => ({ participantId: t.ids[n], weight: 1 })), splitMode: "equal" },
        t.ctx(),
      ),
    );
    const pool = poolSummary(t.state());
    expect(pool.spentPaise).toBe(9_000_00);
    expect(pool.members[t.ids.A].spentPaise).toBe(6_000_00); // 2/3 of the pool was A's
    expect(pool.members[t.ids.B].spentPaise).toBe(3_000_00);
    expect(pool.availablePaise).toBe(6_000_00);
    const l = computeLedger(t.state());
    // A funded ₹6,000 and bears ₹3,000; C put nothing in and owes ₹3,000.
    expect(l.balances[t.ids.A].netPaise).toBe(3_000_00);
    expect(l.balances[t.ids.B].netPaise).toBe(0);
    expect(l.balances[t.ids.C].netPaise).toBe(-3_000_00);
    expect(l.reconciliationPaise).toBe(0);
  });

  it("refuses to pay more than the pool holds, and withdrawals are capped at unspent money", () => {
    const t = trip();
    t.events.push(depositToPool(t.state(), { participantId: t.ids.A, amountPaise: 1_000_00, method: "upi" }, t.ctx()));
    expect(() =>
      payVendorFromPool(t.state(), { title: "Cab", amountPaise: 2_000_00, date: "2026-10-10", category: "Local travel", participants: [{ participantId: t.ids.A, weight: 1 }], splitMode: "equal" }, t.ctx()),
    ).toThrow(/available/);
    expect(() => withdrawFromPool(t.state(), { participantId: t.ids.A, amountPaise: 1_500_00, method: "upi" }, t.ctx())).toThrow(/unspent/);
    t.events.push(withdrawFromPool(t.state(), { participantId: t.ids.A, amountPaise: 400_00, method: "upi" }, t.ctx()));
    expect(poolSummary(t.state()).members[t.ids.A].availablePaise).toBe(600_00);
    expect(computeLedger(t.state()).balances[t.ids.A].contributedPaise).toBe(600_00);
  });
});
