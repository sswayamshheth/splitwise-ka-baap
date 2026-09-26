import { describe, expect, it } from "vitest";

import {
  addExpense,
  addParticipant,
  cancelExpense,
  cancelSettlement,
  confirmSettlement,
  createTrip,
  deleteExpense,
  initiateSettlement,
  previewCancellation,
  recordRefund,
  removalBlocker,
  removeParticipant,
  updateExpense,
  CommandError,
} from "../lib/ledger/commands";
import { computeLedger } from "../lib/ledger/engine";
import { reduceEvents } from "../lib/ledger/reduce";
import type { LedgerEvent, TripState } from "../lib/ledger/types";
import { sumPaise } from "../lib/money";

const ctx = { actor: "system" as const, now: 1_700_000_000_000 };

function build() {
  const log: LedgerEvent[] = [];
  const { events } = createTrip({ name: "Test", destination: "Goa", startDate: "2026-09-12", endDate: "2026-09-15" }, ctx);
  log.push(...events);
  const state = () => reduceEvents(log) as TripState;
  const push = (e: LedgerEvent) => {
    log.push(e);
    return state();
  };
  const ids: Record<string, string> = {};
  for (const name of ["A", "B", "C", "D"]) {
    const ev = addParticipant(state(), { name }, ctx);
    push(ev);
    ids[name] = (ev as Extract<LedgerEvent, { type: "PARTICIPANT_ADDED" }>).participant.id;
  }
  return { log, state, push, ids };
}

function assertConserved(state: TripState) {
  const ledger = computeLedger(state);
  expect(ledger.reconciliationPaise).toBe(0);
  const nets = Object.values(ledger.balances).map((b) => b.netPaise);
  expect(sumPaise(nets)).toBe(0);
  const owed = sumPaise(nets.filter((n) => n < 0));
  const receivable = sumPaise(nets.filter((n) => n > 0));
  expect(owed + receivable).toBe(0);
  return ledger;
}

function expense(state: TripState, ids: Record<string, string>, title: string, amountPaise: number, payer: string, people: string[], extra: Partial<Parameters<typeof addExpense>[1]> = {}) {
  return addExpense(
    state,
    {
      title,
      amountPaise,
      date: "2026-09-13",
      category: "Other",
      payers: [{ participantId: ids[payer], amountPaise }],
      participants: people.map((p) => ({ participantId: ids[p], weight: 1 })),
      splitMode: "equal",
      ...extra,
    },
    ctx,
  );
}

describe("participation-derived splitting", () => {
  it("derives different shares for different participant sets (the brief's A/B/C/D example)", () => {
    const { state, push, ids } = build();
    push(expense(state(), ids, "Hotel", 1200000, "A", ["A", "B", "C", "D"]));
    push(expense(state(), ids, "Dinner", 300000, "B", ["A", "B", "C"]));
    push(expense(state(), ids, "Taxi", 80000, "A", ["A", "D"]));
    push(expense(state(), ids, "Drinks", 150000, "C", ["B", "C"]));
    const ledger = assertConserved(state());
    const b = ledger.balances;
    // shares: A = 300000+100000+40000 = 440000, B = 300000+100000+75000 = 475000, C = 300000+100000+75000 = 475000, D = 300000+40000 = 340000
    expect(b[ids.A].sharePaise).toBe(440000);
    expect(b[ids.B].sharePaise).toBe(475000);
    expect(b[ids.C].sharePaise).toBe(475000);
    expect(b[ids.D].sharePaise).toBe(340000);
    expect(b[ids.A].netPaise).toBe(1280000 - 440000);
    expect(b[ids.D].netPaise).toBe(-340000);
    expect(ledger.totals.spendPaise).toBe(1730000);
  });

  it("never loses a paisa on uneven splits", () => {
    const { state, push, ids } = build();
    push(expense(state(), ids, "Cafe", 315050, "A", ["A", "B", "C"]));
    const ledger = assertConserved(state());
    const c = ledger.expenses[0];
    expect(Object.values(c.shares)).toEqual([105017, 105017, 105016]);
    expect(sumPaise(Object.values(c.shares))).toBe(315050);
  });

  it("supports weighted splits (per room) and exact amounts", () => {
    const { state, push, ids } = build();
    push(
      addExpense(
        state(),
        {
          title: "Rooms",
          amountPaise: 900000,
          date: "2026-09-13",
          category: "Stay",
          payers: [{ participantId: ids.A, amountPaise: 900000 }],
          participants: [
            { participantId: ids.A, weight: 2 },
            { participantId: ids.B, weight: 1 },
          ],
          splitMode: "weighted",
        },
        ctx,
      ),
    );
    push(
      addExpense(
        state(),
        {
          title: "Exact",
          amountPaise: 100000,
          date: "2026-09-13",
          category: "Food",
          payers: [{ participantId: ids.C, amountPaise: 100000 }],
          participants: [
            { participantId: ids.C, weight: 70000 },
            { participantId: ids.D, weight: 30000 },
          ],
          splitMode: "exact",
        },
        ctx,
      ),
    );
    const ledger = assertConserved(state());
    expect(ledger.expenses[0].shares[ids.A]).toBe(600000);
    expect(ledger.expenses[0].shares[ids.B]).toBe(300000);
    expect(ledger.expenses[1].shares[ids.C]).toBe(70000);
    expect(ledger.expenses[1].shares[ids.D]).toBe(30000);
  });

  it("handles a payer who does not participate and multiple payers", () => {
    const { state, push, ids } = build();
    push(expense(state(), ids, "Rafting", 960000, "A", ["B", "C", "D"]));
    push(
      addExpense(
        state(),
        {
          title: "Permits",
          amountPaise: 240000,
          date: "2026-09-13",
          category: "Activity",
          payers: [
            { participantId: ids.A, amountPaise: 140000 },
            { participantId: ids.B, amountPaise: 100000 },
          ],
          participants: ["A", "B", "C", "D"].map((p) => ({ participantId: ids[p], weight: 1 })),
          splitMode: "equal",
        },
        ctx,
      ),
    );
    const ledger = assertConserved(state());
    expect(ledger.balances[ids.A].netPaise).toBe(960000 + 140000 - 60000);
    expect(ledger.balances[ids.B].netPaise).toBe(100000 - 320000 - 60000);
  });

  it("rejects invalid expenses with field errors", () => {
    const { state, ids } = build();
    expect(() => expense(state(), ids, "", 100, "A", ["A"])).toThrow(CommandError);
    expect(() => expense(state(), ids, "Zero", 0, "A", ["A"])).toThrow(/more than ₹0/);
    expect(() => expense(state(), ids, "Nobody", 100, "A", [])).toThrow(/at least one/);
    expect(() =>
      addExpense(
        state(),
        {
          title: "Mismatch",
          amountPaise: 1000,
          date: "2026-09-13",
          category: "Other",
          payers: [{ participantId: ids.A, amountPaise: 400 }],
          participants: [{ participantId: ids.A, weight: 1 }],
          splitMode: "equal",
        },
        ctx,
      ),
    ).toThrow(/add up/);
  });
});

describe("live re-derivation", () => {
  it("recomputes every balance when participation changes", () => {
    const { state, push, ids } = build();
    const ev = push(expense(state(), ids, "Hotel", 2400000, "A", ["A", "B", "C", "D"]));
    const id = ev.expenses[0].id;
    expect(computeLedger(state()).balances[ids.D].netPaise).toBe(-600000);
    // D drops out of the hotel
    const current = state().expenses[0];
    push(
      updateExpense(
        state(),
        id,
        { ...current, participants: current.participants.filter((p) => p.participantId !== ids.D) },
        ctx,
      ),
    );
    const ledger = assertConserved(state());
    expect(ledger.balances[ids.D].netPaise).toBe(0);
    expect(ledger.balances[ids.B].netPaise).toBe(-800000);
    expect(ledger.balances[ids.A].netPaise).toBe(2400000 - 800000);
  });

  it("removing a member strips them from expenses and re-derives", () => {
    const { state, push, ids } = build();
    push(expense(state(), ids, "Hotel", 2400000, "A", ["A", "B", "C", "D"]));
    push(expense(state(), ids, "Cab", 300000, "B", ["B", "D"]));
    expect(removalBlocker(state(), ids.D)).toBeNull();
    expect(removalBlocker(state(), ids.A)).toMatch(/paid for/);
    push(removeParticipant(state(), ids.D, ctx));
    const ledger = assertConserved(state());
    expect(state().participants.map((p) => p.name)).toEqual(["A", "B", "C"]);
    expect(ledger.balances[ids.D]).toBeUndefined();
    expect(ledger.balances[ids.B].sharePaise).toBe(800000 + 300000);
  });

  it("deleting an expense removes its refunds and balances", () => {
    const { state, push, ids } = build();
    const ev = push(expense(state(), ids, "Hotel", 2400000, "A", ["A", "B"]));
    push(recordRefund(state(), { expenseId: ev.expenses[0].id, amountPaise: 400000, receivedBy: ids.A, date: "2026-09-14" }, ctx));
    push(deleteExpense(state(), ev.expenses[0].id, ctx));
    const ledger = assertConserved(state());
    expect(state().refunds).toHaveLength(0);
    expect(ledger.totals.spendPaise).toBe(0);
    expect(ledger.balances[ids.A].netPaise).toBe(0);
  });
});

describe("refund routing", () => {
  it("routes a refund to the cost-bearers, not just the payer (brief §2.3)", () => {
    const { state, push, ids } = build();
    // Amit (A) pays ₹30,000 for a room shared by A, B, C. Hotel refunds 60%.
    const ev = push(expense(state(), ids, "Room", 3000000, "A", ["A", "B", "C"]));
    const before = computeLedger(state());
    expect(before.balances[ids.A].netPaise).toBe(2000000);
    expect(before.balances[ids.B].netPaise).toBe(-1000000);
    push(recordRefund(state(), { expenseId: ev.expenses[0].id, amountPaise: 1800000, receivedBy: ids.A, date: "2026-09-14", reason: "60% policy" }, ctx));
    const after = assertConserved(state());
    const c = after.expenses[0];
    expect(c.effectivePaise).toBe(1200000); // ₹12,000 unrecoverable, still split three ways
    expect(c.shares[ids.B]).toBe(400000);
    expect(c.shares[ids.C]).toBe(400000);
    expect(c.shares[ids.A]).toBe(400000);
    // A received ₹18,000 back, so A's receivable from B and C drops from ₹20,000 to ₹8,000.
    expect(after.balances[ids.A].netPaise).toBe(800000);
    expect(after.balances[ids.B].netPaise).toBe(-400000);
    expect(after.balances[ids.C].netPaise).toBe(-400000);
  });

  it("partial refund: ₹12,000 hotel, ₹3,000 refund → ₹9,000 effective", () => {
    const { state, push, ids } = build();
    const ev = push(expense(state(), ids, "Hotel", 1200000, "A", ["A", "B", "C", "D"]));
    push(recordRefund(state(), { expenseId: ev.expenses[0].id, amountPaise: 300000, receivedBy: ids.A, date: "2026-09-14" }, ctx));
    const ledger = assertConserved(state());
    expect(ledger.expenses[0].effectivePaise).toBe(900000);
    expect(ledger.expenses[0].shares[ids.B]).toBe(225000);
    expect(ledger.balances[ids.A].netPaise).toBe(900000 - 225000);
    expect(ledger.totals.spendPaise).toBe(900000);
  });

  it("refunds received by a non-payer still reconcile", () => {
    const { state, push, ids } = build();
    const ev = push(expense(state(), ids, "Bus", 100000, "A", ["A", "B"]));
    push(recordRefund(state(), { expenseId: ev.expenses[0].id, amountPaise: 20000, receivedBy: ids.B, date: "2026-09-14" }, ctx));
    const ledger = assertConserved(state());
    expect(ledger.balances[ids.A].netPaise).toBe(100000 - 40000);
    expect(ledger.balances[ids.B].netPaise).toBe(-20000 - 40000);
  });

  it("caps refunds at the remaining amount and prevents double counting", () => {
    const { state, push, ids } = build();
    const ev = push(expense(state(), ids, "Bus", 100000, "A", ["A", "B"]));
    const id = ev.expenses[0].id;
    push(recordRefund(state(), { expenseId: id, amountPaise: 60000, receivedBy: ids.A, date: "2026-09-14" }, ctx));
    expect(() => recordRefund(state(), { expenseId: id, amountPaise: 50000, receivedBy: ids.A, date: "2026-09-14" }, ctx)).toThrow(/remain refundable/);
    push(recordRefund(state(), { expenseId: id, amountPaise: 40000, receivedBy: ids.A, date: "2026-09-14" }, ctx));
    const ledger = assertConserved(state());
    expect(ledger.expenses[0].effectivePaise).toBe(0);
    expect(ledger.balances[ids.B].netPaise).toBe(0);
  });

  it("cancels under the vendor policy: only the recoverable part comes back, the loss stays split", () => {
    const { state, push, ids } = build();
    const ev = push(expense(state(), ids, "Homestay", 6200000, "A", ["A", "B", "C", "D"], { cancellationPolicy: { refundPercent: 50 } }));
    const id = ev.expenses[0].id;
    const preview = previewCancellation(state(), id);
    expect(preview.recoverablePaise).toBe(3100000);
    expect(preview.lossPaise).toBe(3100000);
    push(cancelExpense(state(), id, { date: "2026-09-14" }, ctx));
    const ledger = assertConserved(state());
    expect(state().expenses[0].status).toBe("cancelled");
    expect(ledger.expenses[0].effectivePaise).toBe(3100000);
    expect(ledger.expenses[0].shares[ids.B]).toBe(775000);
    expect(ledger.balances[ids.A].netPaise).toBe(3100000 - 775000);
    expect(() => cancelExpense(state(), id, { date: "2026-09-14" }, ctx)).toThrow(/already cancelled/);
  });
});

describe("settlements", () => {
  it("pending payments do not move balances until confirmed; confirmed ones do", () => {
    const { state, push, ids } = build();
    push(expense(state(), ids, "Hotel", 1200000, "A", ["A", "B", "C", "D"]));
    const before = computeLedger(state());
    expect(before.transfers).toHaveLength(3);
    const ev = push(initiateSettlement(state(), { from: ids.B, to: ids.A, amountPaise: 300000, method: "upi" }, ctx));
    const pending = computeLedger(state());
    expect(pending.balances[ids.B].netPaise).toBe(-300000);
    expect(pending.balances[ids.B].provisionalNetPaise).toBe(0);
    expect(pending.transfers).toHaveLength(2);
    push(confirmSettlement(state(), ev.settlements[0].id, ctx));
    const after = assertConserved(state());
    expect(after.balances[ids.B].netPaise).toBe(0);
    expect(after.balances[ids.A].netPaise).toBe(600000);
    expect(after.transfers).toHaveLength(2);
  });

  it("rejects over-payment and self-payment", () => {
    const { state, push, ids } = build();
    push(expense(state(), ids, "Hotel", 1200000, "A", ["A", "B"]));
    expect(() => initiateSettlement(state(), { from: ids.B, to: ids.A, amountPaise: 700000, method: "upi" }, ctx)).toThrow(/more than/);
    expect(() => initiateSettlement(state(), { from: ids.A, to: ids.B, amountPaise: 100, method: "upi" }, ctx)).toThrow(/doesn't owe/);
    expect(() => initiateSettlement(state(), { from: ids.B, to: ids.B, amountPaise: 100, method: "upi" }, ctx)).toThrow(/different/);
  });

  it("cancelling an initiated payment restores the recommendation; confirmed payments cannot be cancelled", () => {
    const { state, push, ids } = build();
    push(expense(state(), ids, "Hotel", 1200000, "A", ["A", "B"]));
    const ev = push(initiateSettlement(state(), { from: ids.B, to: ids.A, amountPaise: 600000, method: "cash" }, ctx));
    expect(computeLedger(state()).transfers).toHaveLength(0);
    push(cancelSettlement(state(), ev.settlements[0].id, ctx));
    expect(computeLedger(state()).transfers).toHaveLength(1);
    const ev2 = push(initiateSettlement(state(), { from: ids.B, to: ids.A, amountPaise: 600000, method: "cash" }, ctx));
    push(confirmSettlement(state(), ev2.settlements[1].id, ctx));
    expect(() => cancelSettlement(state(), ev2.settlements[1].id, ctx)).toThrow(/can't be cancelled/);
    assertConserved(state());
  });

  it("a fully settled trip recommends no transfers", () => {
    const { state, push, ids } = build();
    push(expense(state(), ids, "Hotel", 1200000, "A", ["A", "B", "C", "D"]));
    for (const who of ["B", "C", "D"]) {
      const ev = push(initiateSettlement(state(), { from: ids[who], to: ids.A, amountPaise: 300000, method: "upi" }, ctx));
      push(confirmSettlement(state(), ev.settlements[ev.settlements.length - 1].id, ctx));
    }
    const ledger = assertConserved(state());
    expect(ledger.transfers).toEqual([]);
    expect(Object.values(ledger.balances).every((b) => b.netPaise === 0)).toBe(true);
  });
});

describe("edge cases", () => {
  it("one participant paying for themselves nets to zero", () => {
    const { state, push, ids } = build();
    push(expense(state(), ids, "Solo", 50000, "A", ["A"]));
    const ledger = assertConserved(state());
    expect(ledger.balances[ids.A].netPaise).toBe(0);
    expect(ledger.transfers).toEqual([]);
  });

  it("replaying a prefix of the log reconstructs history exactly", () => {
    const { state, push, ids, log } = build();
    push(expense(state(), ids, "Hotel", 1200000, "A", ["A", "B"]));
    const snapshot = computeLedger(reduceEvents(log.slice()) as TripState);
    push(expense(state(), ids, "Dinner", 300000, "B", ["A", "B"]));
    const replayed = computeLedger(reduceEvents(log.slice(0, -1)) as TripState);
    expect(replayed.balances[ids.A].netPaise).toBe(snapshot.balances[ids.A].netPaise);
    expect(replayed.totals.spendPaise).toBe(1200000);
  });

  it("large amounts stay exact", () => {
    const { state, push, ids } = build();
    push(expense(state(), ids, "Charter", 99_99_99_999_99, "A", ["A", "B", "C"]));
    const ledger = assertConserved(state());
    expect(sumPaise(Object.values(ledger.expenses[0].shares))).toBe(99_99_99_999_99);
  });
});
