import { describe, expect, it } from "vitest";

import { findAnomalies, tripHealth } from "@/lib/ledger/checks";
import {
  addExpense,
  addParticipant,
  cancelExpense,
  confirmSettlement,
  createTrip,
  initiateSettlement,
  joinBooking,
  leaveTrip,
  recordRefund,
  withdrawFromBooking,
  type ExpenseInput,
} from "@/lib/ledger/commands";
import { buildGoaEvents, GOA } from "@/lib/ledger/demo-goa";
import { computeLedger } from "@/lib/ledger/engine";
import { attributeDelta, balanceBreakdown, balanceTimeline, summariseDelta } from "@/lib/ledger/explain";
import { refundPercentOn } from "@/lib/ledger/policy";
import { applyEvent, reduceEvents } from "@/lib/ledger/reduce";
import { minimiseSettlement } from "@/lib/ledger/settlement";
import { simulate, type Change } from "@/lib/ledger/simulate";
import type { CancellationPolicy, LedgerEvent, TripState } from "@/lib/ledger/types";
import { sumPaise } from "@/lib/money";

/**
 * The scenarios from the problem statement, each driven through the same
 * validated commands the app uses. Amounts are paise: ₹3,000 = 3_000_00.
 */

const NAMES = ["Aarav", "Rohan", "Siya", "Kavya", "Dev", "Meera"];

class Trip {
  events: LedgerEvent[] = [];
  ids: Record<string, string> = {};
  now = 1_700_000_000_000;

  constructor(names = NAMES) {
    const created = createTrip({ name: "Goa", destination: "Goa", startDate: "2026-10-10", endDate: "2026-10-14" }, this.ctx());
    this.push(created.events);
    for (const name of names) {
      const e = addParticipant(this.state, { name }, this.ctx());
      this.push(e);
      if (e.type === "PARTICIPANT_ADDED") this.ids[name] = e.participant.id;
    }
  }
  ctx() {
    return { actor: "system" as const, now: this.now++ };
  }
  get state(): TripState {
    return reduceEvents(this.events)!;
  }
  get ledger() {
    return computeLedger(this.state);
  }
  push(e: LedgerEvent | LedgerEvent[]) {
    this.events.push(...(Array.isArray(e) ? e : [e]));
  }
  id(name: string) {
    return this.ids[name];
  }
  net(name: string) {
    return this.ledger.balances[this.id(name)].netPaise;
  }
  share(expenseId: string, name: string) {
    return this.ledger.byExpenseId[expenseId].shares[this.id(name)] ?? 0;
  }
  expense(input: Partial<ExpenseInput> & { title: string; amountPaise: number; payer: string; people: string[] }): string {
    const full: ExpenseInput = {
      title: input.title,
      amountPaise: input.amountPaise,
      date: input.date ?? "2026-10-10",
      category: input.category ?? "Stay",
      payers: input.payers ?? [{ participantId: this.id(input.payer), amountPaise: input.amountPaise }],
      participants: input.participants ?? input.people.map((n) => ({ participantId: this.id(n), weight: 1 })),
      splitMode: input.splitMode ?? "equal",
      pricing: input.pricing,
      cancellationPolicy: input.cancellationPolicy,
    };
    const e = addExpense(this.state, full, this.ctx());
    this.push(e);
    return e.type === "EXPENSE_ADDED" ? e.expense.id : "";
  }
  reconciles() {
    const l = this.ledger;
    return sumPaise(Object.values(l.balances).map((b) => b.netPaise)) === 0 && l.reconciliationPaise === 0;
  }
}

const VILLA_POLICY: CancellationPolicy = { refundPercent: 0, tiers: [{ until: "2026-09-20", refundPercent: 100 }, { until: "2026-10-03", refundPercent: 50 }] };

describe("1 · six people, equal split", () => {
  it("₹18,000 villa is ₹3,000 each and the payer is owed ₹15,000", () => {
    const t = new Trip();
    const villa = t.expense({ title: "Villa", amountPaise: 18_000_00, payer: "Aarav", people: NAMES, pricing: "fixed" });
    for (const n of NAMES) expect(t.share(villa, n)).toBe(3_000_00);
    expect(t.net("Aarav")).toBe(15_000_00);
    expect(t.net("Rohan")).toBe(-3_000_00);
    expect(t.reconciles()).toBe(true);
  });
});

describe("2 · different participants per booking", () => {
  it("only the three divers bear the scuba cost", () => {
    const t = new Trip();
    const scuba = t.expense({ title: "Scuba", amountPaise: 10_500_00, payer: "Siya", people: ["Aarav", "Siya", "Kavya"], category: "Activity" });
    expect(t.share(scuba, "Aarav")).toBe(3_500_00);
    expect(t.share(scuba, "Rohan")).toBe(0);
    expect(t.net("Dev")).toBe(0);
    expect(t.net("Siya")).toBe(7_000_00);
    expect(t.reconciles()).toBe(true);
  });
});

describe("3 · participant joins", () => {
  it("fixed price: a sixth person joining lowers everyone's share", () => {
    const t = new Trip();
    const villa = t.expense({ title: "Villa", amountPaise: 18_000_00, payer: "Aarav", people: ["Aarav", "Rohan", "Siya", "Kavya", "Dev"], pricing: "fixed" });
    expect(t.share(villa, "Rohan")).toBe(3_600_00);
    t.push(joinBooking(t.state, { participantId: t.id("Meera"), expenseId: villa }, t.ctx()));
    expect(t.share(villa, "Rohan")).toBe(3_000_00);
    expect(t.share(villa, "Meera")).toBe(3_000_00);
    expect(t.reconciles()).toBe(true);
  });

  it("per-head: joining buys one more seat, nobody else's share moves", () => {
    const t = new Trip();
    const scuba = t.expense({ title: "Scuba", amountPaise: 10_500_00, payer: "Siya", people: ["Aarav", "Siya", "Kavya"], category: "Activity", pricing: "per-head" });
    t.push(joinBooking(t.state, { participantId: t.id("Dev"), expenseId: scuba }, t.ctx()));
    const e = t.state.expenses.find((x) => x.id === scuba)!;
    expect(e.amountPaise).toBe(14_000_00);
    expect(t.share(scuba, "Aarav")).toBe(3_500_00);
    expect(t.share(scuba, "Dev")).toBe(3_500_00);
    expect(t.net("Siya")).toBe(14_000_00 - 3_500_00);
    expect(t.reconciles()).toBe(true);
  });
});

describe("4 · participant leaves", () => {
  it("fixed price, remaining people absorb: ₹3,000 → ₹3,600 and the explanation says why", () => {
    const t = new Trip();
    const villa = t.expense({ title: "Villa", amountPaise: 18_000_00, payer: "Aarav", people: NAMES, pricing: "fixed" });
    const before = t.ledger;
    t.push(withdrawFromBooking(t.state, { participantId: t.id("Rohan"), expenseId: villa, date: "2026-10-01" }, t.ctx()));
    const after = t.ledger;
    expect(t.share(villa, "Siya")).toBe(3_600_00);
    expect(t.share(villa, "Rohan")).toBe(0);
    const lines = attributeDelta(before, after, t.id("Siya"), (id) => NAMES.find((n) => t.id(n) === id)!);
    expect(lines).toHaveLength(1);
    expect(lines[0].shareBefore).toBe(3_000_00);
    expect(lines[0].shareAfter).toBe(3_600_00);
    expect(lines[0].deltaPaise).toBe(-600_00);
    expect(lines[0].reason).toContain("Rohan dropped out");
    expect(lines[0].reason).toContain("5 ways instead of 6");
    expect(t.reconciles()).toBe(true);
  });

  it("fixed price, leaver keeps paying: nobody else moves", () => {
    const t = new Trip();
    const villa = t.expense({ title: "Villa", amountPaise: 18_000_00, payer: "Aarav", people: NAMES, pricing: "fixed" });
    t.push(withdrawFromBooking(t.state, { participantId: t.id("Rohan"), expenseId: villa, date: "2026-10-01", rule: "leaver-pays" }, t.ctx()));
    expect(t.share(villa, "Siya")).toBe(3_000_00);
    expect(t.share(villa, "Rohan")).toBe(3_000_00);
    expect(t.reconciles()).toBe(true);
  });
});

describe("5 · participant leaves after paying", () => {
  it("they stay on the books, keep their consumed shares, and are paid back", () => {
    const t = new Trip();
    t.expense({ title: "Groceries", amountPaise: 1_200_00, payer: "Kavya", people: NAMES, date: "2026-10-09", category: "Food" });
    const villa = t.expense({ title: "Villa", amountPaise: 18_000_00, payer: "Rohan", people: NAMES, pricing: "fixed", date: "2026-10-11" });
    const plan = leaveTrip(t.state, { participantId: t.id("Rohan"), date: "2026-10-10" }, t.ctx());
    t.push(plan.events);
    const rohan = t.state.participants.find((p) => p.id === t.id("Rohan"))!;
    expect(rohan.leftOn).toBe("2026-10-10");
    expect(plan.withdrawn).toEqual([villa]);
    expect(plan.consumed).toHaveLength(1); // groceries were before the leave date
    // Paid ₹18,000, bears ₹0 of the villa and ₹200 of groceries: owed ₹17,800.
    expect(t.net("Rohan")).toBe(17_800_00);
    expect(t.ledger.transfers.filter((x) => x.to === t.id("Rohan")).reduce((s, x) => s + x.amountPaise, 0)).toBe(17_800_00);
    expect(t.reconciles()).toBe(true);
  });

  it("can't be added to new expenses after leaving", () => {
    const t = new Trip();
    t.push(leaveTrip(t.state, { participantId: t.id("Dev"), date: "2026-10-10" }, t.ctx()).events);
    expect(() => t.expense({ title: "Dinner", amountPaise: 4_000_00, payer: "Aarav", people: ["Aarav", "Dev"], category: "Food" })).toThrow(/left the trip/);
  });
});

describe("6 · booking cancellation under a tiered policy", () => {
  it("₹18,000 villa cancelled in the 50% tier: ₹9,000 back to the payer, credited to all six", () => {
    const t = new Trip();
    const villa = t.expense({ title: "Villa", amountPaise: 18_000_00, payer: "Aarav", people: NAMES, pricing: "fixed", cancellationPolicy: VILLA_POLICY });
    t.push(cancelExpense(t.state, villa, { date: "2026-10-01" }, t.ctx()));
    const c = t.ledger.byExpenseId[villa];
    expect(c.refundedPaise).toBe(9_000_00);
    expect(c.effectivePaise).toBe(9_000_00);
    for (const n of NAMES) expect(t.share(villa, n)).toBe(1_500_00);
    // Aarav paid 18,000, got 9,000 back, bears 1,500.
    expect(t.net("Aarav")).toBe(7_500_00);
    expect(t.net("Meera")).toBe(-1_500_00);
    expect(t.reconciles()).toBe(true);
  });

  it("the tier is chosen by the cancellation date", () => {
    expect(refundPercentOn(VILLA_POLICY, "2026-09-15")).toBe(100);
    expect(refundPercentOn(VILLA_POLICY, "2026-09-20")).toBe(100);
    expect(refundPercentOn(VILLA_POLICY, "2026-09-21")).toBe(50);
    expect(refundPercentOn(VILLA_POLICY, "2026-10-03")).toBe(50);
    expect(refundPercentOn(VILLA_POLICY, "2026-10-04")).toBe(0);
    expect(refundPercentOn(undefined, "2026-10-04")).toBe(0);
  });
});

describe("7 · partial refund", () => {
  it("a ₹3,000 refund lowers every share of an ₹18,000 booking to ₹2,500", () => {
    const t = new Trip();
    const villa = t.expense({ title: "Villa", amountPaise: 18_000_00, payer: "Aarav", people: NAMES });
    t.push(recordRefund(t.state, { expenseId: villa, amountPaise: 3_000_00, receivedBy: t.id("Aarav"), date: "2026-10-12" }, t.ctx()));
    for (const n of NAMES) expect(t.share(villa, n)).toBe(2_500_00);
    expect(t.net("Aarav")).toBe(18_000_00 - 3_000_00 - 2_500_00);
    expect(t.reconciles()).toBe(true);
  });

  it("if someone other than the payer receives the refund, they owe it onward", () => {
    const t = new Trip();
    const villa = t.expense({ title: "Villa", amountPaise: 18_000_00, payer: "Aarav", people: NAMES });
    t.push(recordRefund(t.state, { expenseId: villa, amountPaise: 6_000_00, receivedBy: t.id("Dev"), date: "2026-10-12" }, t.ctx()));
    // Dev holds ₹6,000 of group money and bears ₹2,000: he owes ₹8,000.
    expect(t.net("Dev")).toBe(-8_000_00);
    expect(t.net("Aarav")).toBe(16_000_00);
    expect(t.reconciles()).toBe(true);
  });
});

describe("8 · full refund", () => {
  it("cancelling in the 100% tier returns everyone to zero", () => {
    const t = new Trip();
    const villa = t.expense({ title: "Villa", amountPaise: 18_000_00, payer: "Aarav", people: NAMES, cancellationPolicy: VILLA_POLICY });
    t.push(cancelExpense(t.state, villa, { date: "2026-09-10" }, t.ctx()));
    for (const n of NAMES) expect(t.net(n)).toBe(0);
    expect(t.ledger.transfers).toHaveLength(0);
  });
});

describe("9 · non-refundable booking", () => {
  it("per-head at 0%: the leaver keeps their whole seat, the others don't move", () => {
    const t = new Trip();
    const flight = t.expense({ title: "Flight", amountPaise: 24_000_00, payer: "Aarav", people: NAMES.slice(0, 5), category: "Transport", pricing: "per-head", cancellationPolicy: { refundPercent: 0 } });
    t.push(withdrawFromBooking(t.state, { participantId: t.id("Dev"), expenseId: flight, date: "2026-10-09" }, t.ctx()));
    expect(t.share(flight, "Dev")).toBe(4_800_00);
    expect(t.share(flight, "Rohan")).toBe(4_800_00);
    expect(t.ledger.byExpenseId[flight].refundedPaise).toBe(0);
    expect(t.reconciles()).toBe(true);
  });

  it("per-head at 60%: vendor refunds ₹2,880 of a ₹4,800 seat; the leaver keeps ₹1,920", () => {
    const t = new Trip();
    const flight = t.expense({ title: "Flight", amountPaise: 24_000_00, payer: "Aarav", people: NAMES.slice(0, 5), category: "Transport", pricing: "per-head", cancellationPolicy: { refundPercent: 0, tiers: [{ until: "2026-10-03", refundPercent: 60 }] } });
    t.push(withdrawFromBooking(t.state, { participantId: t.id("Dev"), expenseId: flight, date: "2026-10-01" }, t.ctx()));
    expect(t.ledger.byExpenseId[flight].refundedPaise).toBe(2_880_00);
    expect(t.share(flight, "Dev")).toBe(1_920_00);
    expect(t.share(flight, "Rohan")).toBe(4_800_00);
    expect(t.net("Dev")).toBe(-1_920_00);
    expect(t.reconciles()).toBe(true);
  });
});

describe("10 · unequal contributions", () => {
  it("two payers on one bill are credited what each actually paid", () => {
    const t = new Trip();
    t.expense({
      title: "Dinner",
      amountPaise: 6_000_00,
      payer: "Aarav",
      people: ["Aarav", "Rohan", "Siya"],
      category: "Food",
      payers: [
        { participantId: t.id("Aarav"), amountPaise: 5_000_00 },
        { participantId: t.id("Rohan"), amountPaise: 1_000_00 },
      ],
    });
    expect(t.net("Aarav")).toBe(3_000_00);
    expect(t.net("Rohan")).toBe(-1_000_00);
    expect(t.net("Siya")).toBe(-2_000_00);
  });
});

describe("11 · custom splits", () => {
  it("exact amounts are honoured to the paisa", () => {
    const t = new Trip();
    const ins = t.expense({
      title: "Insurance",
      amountPaise: 1_950_00,
      payer: "Dev",
      people: [],
      category: "Other",
      splitMode: "exact",
      participants: [
        { participantId: t.id("Aarav"), weight: 450_00 },
        { participantId: t.id("Siya"), weight: 600_00 },
        { participantId: t.id("Dev"), weight: 900_00 },
      ],
    });
    expect(t.share(ins, "Siya")).toBe(600_00);
    expect(t.share(ins, "Dev")).toBe(900_00);
    expect(t.reconciles()).toBe(true);
  });

  it("weighted split: 2 rooms vs 1 room", () => {
    const t = new Trip();
    const up = t.expense({ title: "Upgrade", amountPaise: 4_500_00, payer: "Rohan", people: [], splitMode: "weighted", participants: [{ participantId: t.id("Rohan"), weight: 2 }, { participantId: t.id("Siya"), weight: 1 }] });
    expect(t.share(up, "Rohan")).toBe(3_000_00);
    expect(t.share(up, "Siya")).toBe(1_500_00);
  });

  it("indivisible amounts still sum exactly (₹100 across 3)", () => {
    const t = new Trip();
    const x = t.expense({ title: "Chai", amountPaise: 100_00, payer: "Aarav", people: ["Aarav", "Rohan", "Siya"], category: "Food" });
    const shares = ["Aarav", "Rohan", "Siya"].map((n) => t.share(x, n));
    expect(sumPaise(shares)).toBe(100_00);
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
  });
});

describe("12 · new expense after a settlement", () => {
  it("only the new expense is outstanding once earlier debts were paid", () => {
    const t = new Trip(["Aarav", "Rohan"]);
    t.expense({ title: "Villa", amountPaise: 10_000_00, payer: "Aarav", people: ["Aarav", "Rohan"] });
    const s = initiateSettlement(t.state, { from: t.id("Rohan"), to: t.id("Aarav"), amountPaise: 5_000_00, method: "upi" }, t.ctx());
    t.push(s);
    expect(t.net("Rohan")).toBe(-5_000_00); // not confirmed yet: balances don't move
    if (s.type === "SETTLEMENT_INITIATED") t.push(confirmSettlement(t.state, s.settlement.id, t.ctx()));
    expect(t.net("Rohan")).toBe(0);
    t.expense({ title: "Dinner", amountPaise: 2_000_00, payer: "Rohan", people: ["Aarav", "Rohan"], category: "Food" });
    expect(t.net("Aarav")).toBe(-1_000_00);
    expect(t.ledger.transfers).toEqual([{ from: t.id("Aarav"), to: t.id("Rohan"), amountPaise: 1_000_00 }]);
  });
});

describe("13 · settlement optimisation", () => {
  it("the brief's example settles in 4 transfers", () => {
    const transfers = minimiseSettlement({ aarav: 6_000_00, rohan: 3_000_00, siya: -4_000_00, kavya: -3_500_00, dev: -1_500_00 });
    expect(transfers).toHaveLength(4);
    // Everyone ends at zero.
    const net: Record<string, number> = { aarav: 6_000_00, rohan: 3_000_00, siya: -4_000_00, kavya: -3_500_00, dev: -1_500_00 };
    for (const t of transfers) {
      net[t.from] += t.amountPaise;
      net[t.to] -= t.amountPaise;
    }
    expect(Object.values(net).every((v) => v === 0)).toBe(true);
  });

  it("finds independent zero-sum groups greedy alone would miss: n − groups transfers", () => {
    // Greedy largest-first would chain these into 5 transfers; the optimum is 4 (two groups of 3).
    const balances = { a: 7_00, b: -4_00, c: -3_00, d: 6_00, e: -5_00, f: -1_00 };
    const transfers = minimiseSettlement(balances);
    expect(transfers).toHaveLength(4);
  });

  it("the Goa demo needs 5 transfers instead of 12 pairwise debts", () => {
    const state = reduceEvents(buildGoaEvents(new Date(2026, 8, 26, 12).getTime()))!;
    const l = computeLedger(state);
    expect(l.transfers.length).toBe(5);
    expect(l.naiveTransferCount).toBe(12);
  });
});

describe("14 · simulation: multiple simultaneous changes", () => {
  const now = new Date(2026, 8, 26, 12).getTime();
  const base = buildGoaEvents(now);
  const changes: Change[] = [
    { kind: "leave-trip", participantId: GOA.aarav, date: "2026-09-26" },
    { kind: "cancel-booking", expenseId: "x_villa", date: "2026-09-26" },
  ];

  it("does not touch the real log", () => {
    const copy = JSON.stringify(base);
    const sim = simulate(base, changes, { actor: GOA.aarav, now });
    expect(sim.ok).toBe(true);
    expect(JSON.stringify(base)).toBe(copy);
  });

  it("applying the simulated events gives exactly the simulated ledger", () => {
    const sim = simulate(base, changes, { actor: GOA.aarav, now });
    if (!sim.ok) throw new Error(sim.error);
    const applied = computeLedger(reduceEvents([...base, ...sim.events])!);
    expect(applied.balances).toEqual(sim.after.ledger.balances);
    expect(applied.transfers).toEqual(sim.after.ledger.transfers);
  });

  it("the diff explains every person's change exactly", () => {
    const sim = simulate(base, changes, { actor: GOA.aarav, now });
    if (!sim.ok) throw new Error(sim.error);
    for (const p of sim.diff.people) expect(sumPaise(p.lines.map((l) => l.deltaPaise))).toBe(p.deltaPaise);
    expect(sim.diff.reconciliationAfter).toBe(0);
    // Villa cancelled in the 50% tier after Aarav left the fixed-price villa: ₹27,000 back to Rohan.
    expect(sim.diff.refundsAdded.find((r) => r.expenseId === "x_villa")?.amountPaise).toBe(27_000_00);
  });

  it("reports an invalid change instead of guessing", () => {
    const sim = simulate(base, [{ kind: "withdraw", participantId: GOA.rohan, expenseId: "x_scuba", date: "2026-09-26" }], { actor: GOA.aarav, now });
    expect(sim.ok).toBe(false);
    if (!sim.ok) expect(sim.error).toMatch(/not part of/);
  });

  it("Aarav leaving: villa and pickup re-split, scuba fully refunded, insurance non-refundable, gear untouched", () => {
    const sim = simulate(base, [changes[0]], { actor: GOA.aarav, now });
    if (!sim.ok) throw new Error(sim.error);
    const affected = sim.diff.affected.map((b) => b.expenseId).sort();
    expect(affected).toEqual(["x_flights", "x_insurance", "x_pickup", "x_scuba", "x_villa"].sort());
    expect(sim.diff.unaffected.map((b) => b.expenseId)).toEqual(["x_gear"]);
    const siya = sim.diff.people.find((p) => p.participantId === GOA.siya)!;
    expect(siya.lines.find((l) => l.expenseId === "x_villa")?.deltaPaise).toBe(-1_800_00);
    const insurance = sim.after.ledger.byExpenseId.x_insurance;
    expect(insurance.shares[GOA.aarav]).toBe(450_00);
    // Meals scale with headcount: the table-for-four estimate drops by Aarav's quarter.
    expect(sim.diff.budget.lines.find((l) => l.itemId === "it_dinner")?.afterPaise).toBe(6_000_00);
    // A per-head seat leaves the plan too (₹24,000 → ₹19,200); the fixed-price villa estimate stays and re-splits.
    expect(sim.after.state.itinerary.find((i) => i.id === "it_flight_out")!.estimatedPaise).toBe(19_200_00);
    expect(sim.after.state.itinerary.find((i) => i.id === "it_villa")!.estimatedPaise).toBe(54_000_00);
    // Rohan's planned spend moves only on fixed-price items.
    expect(sim.diff.budget.perParticipant[GOA.rohan].after - sim.diff.budget.perParticipant[GOA.rohan].before).toBe(
      // villa re-split 6 → 5 (+₹1,800) and the 6-person pickup plan re-split (+₹100); meals scale, so they don't move him.
      54_000_00 / 5 - 54_000_00 / 6 + (3_000_00 / 5 - 3_000_00 / 6),
    );
    expect(sim.after.state.itinerary.find((i) => i.id === "it_dinner")!.participantIds).not.toContain(GOA.aarav);
  });
});

describe("explanations", () => {
  const now = new Date(2026, 8, 26, 12).getTime();
  const events = buildGoaEvents(now);
  const state = reduceEvents(events)!;
  const ledger = computeLedger(state);
  const name = (id: string) => state.participants.find((p) => p.id === id)?.name ?? "?";

  it("a balance breakdown sums exactly to the balance", () => {
    for (const p of state.participants) {
      const b = balanceBreakdown(state, ledger, p.id);
      expect(sumPaise(b.lines.map((l) => l.netPaise)) + b.settledNetPaise).toBe(ledger.balances[p.id].netPaise);
    }
  });

  it("the history replays to the current balance", () => {
    for (const p of state.participants) {
      const timeline = balanceTimeline(events, p.id, name);
      expect(sumPaise(timeline.map((t) => t.deltaPaise))).toBe(ledger.balances[p.id].netPaise);
      for (const entry of timeline) expect(sumPaise(entry.lines.map((l) => l.deltaPaise))).toBe(entry.deltaPaise);
    }
  });
});

describe("17 · inconsistent state is detected", () => {
  const now = new Date(2026, 8, 26, 12).getTime();

  it("flags the Goa pickup plan-vs-split mismatch and Meera's missing flight", () => {
    const state = reduceEvents(buildGoaEvents(now))!;
    const found = findAnomalies(state, computeLedger(state));
    expect(found.some((a) => a.id === "plan-it_pickup" && a.participantIds?.includes(GOA.meera))).toBe(true);
    expect(found.some((a) => a.id === "seats-it_flight_out")).toBe(true);
    expect(found.every((a) => a.severity !== "critical")).toBe(true);
  });

  it("flags a member who left but is still in a later split", () => {
    const events = buildGoaEvents(now);
    const state = reduceEvents(events)!;
    // Corrupt data the commands would refuse: mark Dev as left without withdrawing him.
    const corrupted = applyEvent(state, { id: "x", ts: now, actor: "system", type: "PARTICIPANT_LEFT", participantId: GOA.dev, name: "Dev", date: "2026-09-26" })!;
    const found = findAnomalies(corrupted, computeLedger(corrupted));
    expect(found.some((a) => a.id.startsWith("left-") && a.participantIds?.includes(GOA.dev))).toBe(true);
  });

  it("flags possible duplicate payments", () => {
    const t = new Trip();
    t.expense({ title: "Dinner", amountPaise: 4_000_00, payer: "Aarav", people: NAMES, category: "Food" });
    t.expense({ title: "Dinner", amountPaise: 4_000_00, payer: "Rohan", people: NAMES, category: "Food" });
    expect(findAnomalies(t.state, t.ledger).some((a) => a.id.startsWith("dup-"))).toBe(true);
  });

  it("trip health summarises the demo", () => {
    const state = reduceEvents(buildGoaEvents(now))!;
    const ledger = computeLedger(state);
    const h = tripHealth(state, ledger, findAnomalies(state, ledger));
    expect(h.members).toBe(6);
    expect(h.bookings).toBe(6);
    expect(h.cancelledBookings).toBe(1);
    expect(h.pendingSettlements).toBe(1);
    expect(h.settledFraction).toBeGreaterThan(0);
    expect(h.settledFraction).toBeLessThan(1);
  });
});

describe("conservation under random change sequences (seeded fuzz)", () => {
  it("Σ balances = ₹0 after every one of 300 random scenarios", () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const now = new Date(2026, 8, 26, 12).getTime();
    const base = buildGoaEvents(now);
    const state = reduceEvents(base)!;
    const people = state.participants.map((p) => p.id);
    const expenses = state.expenses.map((e) => e.id);
    const dates = ["2026-09-20", "2026-09-26", "2026-10-03", "2026-10-08", "2026-10-12"];
    let ok = 0;
    for (let run = 0; run < 300; run++) {
      const changes: Change[] = [];
      const n = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < n; i++) {
        const kind = pick(["leave-trip", "withdraw", "join-booking", "cancel-booking"] as const);
        if (kind === "leave-trip") changes.push({ kind, participantId: pick(people), date: pick(dates), rule: pick(["redistribute", "leaver-pays"] as const) });
        if (kind === "withdraw") changes.push({ kind, participantId: pick(people), expenseId: pick(expenses), date: pick(dates), rule: pick(["redistribute", "leaver-pays"] as const) });
        if (kind === "join-booking") changes.push({ kind, participantId: pick(people), expenseId: pick(expenses) });
        if (kind === "cancel-booking") changes.push({ kind, expenseId: pick(expenses), date: pick(dates) });
      }
      const sim = simulate(base, changes, { actor: "system", now });
      if (!sim.ok) continue; // invalid combinations are rejected by the commands, never half-applied
      ok++;
      expect(sim.after.ledger.reconciliationPaise).toBe(0);
      for (const c of sim.after.ledger.expenses) expect(sumPaise(Object.values(c.shares))).toBe(c.effectivePaise);
      for (const p of sim.diff.people) expect(sumPaise(p.lines.map((l) => l.deltaPaise))).toBe(p.deltaPaise);
    }
    expect(ok).toBeGreaterThan(100);
  });
});

describe("price changes and plan edits in the simulator", () => {
  const now = new Date(2026, 8, 26, 12).getTime();
  const base = buildGoaEvents(now);

  it("villa +₹6,000: payer settles the difference, every share re-derives (₹9,000 → ₹10,000)", () => {
    const sim = simulate(base, [{ kind: "reprice", expenseId: "x_villa", newAmountPaise: 60_000_00 }], { actor: GOA.aarav, now });
    if (!sim.ok) throw new Error(sim.error);
    for (const id of Object.values(GOA)) expect(sim.after.ledger.byExpenseId.x_villa.shares[id]).toBe(10_000_00);
    // Rohan paid ₹6,000 more and bears ₹1,000 more: +₹5,000.
    expect(sim.diff.people.find((p) => p.participantId === GOA.rohan)!.deltaPaise).toBe(5_000_00);
    expect(sim.diff.spendAfter - sim.diff.spendBefore).toBe(6_000_00);
    expect(sim.diff.reconciliationAfter).toBe(0);
  });

  it("a planned item's estimate moves only the plan, not balances", () => {
    const sim = simulate(base, [{ kind: "reprice", itemId: "it_dinner", newAmountPaise: 10_000_00 }], { actor: GOA.aarav, now });
    if (!sim.ok) throw new Error(sim.error);
    expect(sim.diff.budget.deltaPaise).toBe(2_000_00);
    expect(sim.diff.people.every((p) => p.deltaPaise === 0)).toBe(true);
  });

  it("two people dropping the scuba stack and each get their seat refunded", () => {
    const sim = simulate(
      base,
      [
        { kind: "withdraw", participantId: GOA.aarav, expenseId: "x_scuba", date: "2026-09-26" },
        { kind: "withdraw", participantId: GOA.kavya, expenseId: "x_scuba", date: "2026-09-26" },
      ],
      { actor: GOA.aarav, now },
    );
    if (!sim.ok) throw new Error(sim.error);
    expect(sim.after.ledger.byExpenseId.x_scuba.refundedPaise).toBe(7_000_00);
    expect(sim.after.ledger.byExpenseId.x_scuba.shares[GOA.siya]).toBe(3_500_00);
  });

  it("dropping a paid item is refused — cancel it instead", () => {
    const sim = simulate(base, [{ kind: "drop-item", itemId: "it_villa" }], { actor: GOA.aarav, now });
    expect(sim.ok).toBe(false);
  });
});

describe("one-sentence explanation", () => {
  it("names the total and each booking's share change, using ledger figures only", () => {
    const now = new Date(2026, 8, 26, 12).getTime();
    const sim = simulate(buildGoaEvents(now), [{ kind: "leave-trip", participantId: GOA.siya, date: "2026-09-26" }], { actor: GOA.aarav, now });
    if (!sim.ok) throw new Error(sim.error);
    const kavya = sim.diff.people.find((p) => p.participantId === GOA.kavya)!;
    const text = summariseDelta("Kavya", kavya.deltaPaise, kavya.lines);
    expect(text).toMatch(/^Kavya's balance went down by ₹1,950 because: /);
    expect(text).toContain("Villa Azul · 4 nights share up ₹1,800");
    expect(text).toContain("Airport pickup · Innova share up ₹150");
  });
});
