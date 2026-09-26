import { describe, expect, it } from "vitest";

import { buildDemoEvents } from "../lib/ledger/demo";
import { computeLedger } from "../lib/ledger/engine";
import { analysePayments, optimisePayment } from "../lib/ledger/offers";
import { reduceEvents } from "../lib/ledger/reduce";
import { sumPaise } from "../lib/money";

/** The demo is the brief's scenario; these assertions are the demo script. */
describe("Manali demo", () => {
  const state = reduceEvents(buildDemoEvents(new Date("2026-09-09T12:00:00").getTime()))!;
  const ledger = computeLedger(state);

  it("replays into six travellers and a full itinerary", () => {
    expect(state.participants).toHaveLength(6);
    expect(state.itinerary).toHaveLength(10);
    expect(state.expenses).toHaveLength(9);
    expect(state.refunds).toHaveLength(1);
    expect(state.settlements).toHaveLength(2);
    expect(state.contributions).toHaveLength(3);
    expect(state.participants.every((p) => (p.paymentMethods?.length ?? 0) > 0)).toBe(true);
  });

  it("plans roughly ₹1.8 lakh and tracks what has actually been spent", () => {
    expect(ledger.budget.estimatedPaise).toBe(1_78_700_00);
    expect(ledger.budget.actualPaise).toBeLessThan(ledger.budget.estimatedPaise);
    expect(ledger.totals.spendPaise).toBe(ledger.totals.grossPaise - ledger.totals.refundedPaise);
    // Categories and per-person estimates both reconstruct the total.
    expect(sumPaise(ledger.budget.categories.map((c) => c.estimatedPaise))).toBe(1_78_700_00);
    expect(sumPaise(Object.values(ledger.budget.estimatedPerParticipant))).toBe(1_78_700_00);
  });

  it("reconciles to the paisa", () => {
    expect(ledger.reconciliationPaise).toBe(0);
    const nets = Object.values(ledger.balances).map((b) => b.netPaise);
    expect(sumPaise(nets)).toBe(0);
    expect(sumPaise(nets.filter((n) => n > 0)) + sumPaise(nets.filter((n) => n < 0))).toBe(0);
  });

  it("collapses the debts into far fewer transfers", () => {
    expect(ledger.transfers.length).toBeGreaterThan(0);
    expect(ledger.transfers.length).toBeLessThanOrEqual(5);
    expect(ledger.naiveTransferCount).toBeGreaterThan(ledger.transfers.length);
  });

  it("Rohit's HDFC Regalia wins the ₹62,000 homestay at 12%", () => {
    const result = optimisePayment(state.participants, { amountPaise: 62_000_00, category: "Stay", vendor: "Himalayan Nest Homestay" });
    expect(result.best?.participantName).toBe("Rohit Mehra");
    expect(result.best?.method.label).toBe("HDFC Regalia");
    expect(result.best?.discountPaise).toBe(7_440_00);
    // And that is what actually got recorded: a ₹62,000 bill charged at ₹54,560.
    const homestay = state.expenses.find((e) => e.id === "x_homestay")!;
    expect(homestay.discountPaise).toBe(7_440_00);
    expect(homestay.amountPaise + homestay.discountPaise!).toBe(62_000_00);
  });

  it("Priya dropped out of the rafting and her share went with her", () => {
    const rafting = state.expenses.find((e) => e.id === "x_rafting")!;
    expect(rafting.participants.map((p) => p.participantId)).not.toContain("p_priya");
    expect(rafting.participants).toHaveLength(5);
    expect(ledger.byExpenseId["x_rafting"].shares["p_priya"]).toBeUndefined();
  });

  it("routes the paragliding refund to the four who bore the cost, not just the payer", () => {
    const c = ledger.byExpenseId["x_paragliding"];
    expect(c.refundedPaise).toBe(4_140_00);
    expect(c.effectivePaise).toBe(16_560_00 - 4_140_00);
    // Each of the four sharers is credited a quarter of the refund.
    for (const pid of ["p_aisha", "p_rohit", "p_amit", "p_karan"]) {
      expect(c.grossShares[pid] - c.shares[pid]).toBe(4_140_00 / 4);
    }
    // Amit received the cash, so what he is owed by the others drops by the same amount.
    expect(c.netPaidByPayer["p_amit"]).toBe(16_560_00 - 4_140_00);
  });

  it("keeps the vendor ledger separate from what members owe each other", () => {
    expect(ledger.vendors.length).toBeGreaterThan(0);
    const homestayVendor = ledger.vendors.find((v) => v.vendor === "Himalayan Nest Homestay")!;
    expect(homestayVendor.committedPaise).toBeGreaterThan(homestayVendor.paidPaise);
    expect(homestayVendor.outstandingPaise).toBe(homestayVendor.committedPaise - homestayVendor.paidPaise);
    expect(ledger.budget.vendorOutstandingPaise).toBeGreaterThan(0);
    expect(ledger.vendors.every((v) => v.vendor.trim().length > 0)).toBe(true);
  });

  it("has one confirmed and one pending settlement", () => {
    expect(ledger.confirmedSettlements).toHaveLength(1);
    expect(ledger.pendingSettlements).toHaveLength(1);
    // A pending payment shifts the recommendation without moving the balance.
    const karan = ledger.balances["p_karan"];
    expect(karan.provisionalNetPaise).toBe(karan.netPaise + 3_000_00);
  });

  it("captured real card savings and never overstates them", () => {
    const analysis = analysePayments(state);
    expect(analysis.capturedPaise).toBe(12_228_00);
    expect(analysis.capturedPaise).toBeLessThanOrEqual(analysis.potentialPaise);
    expect(analysis.byCard.some((c) => c.label === "HDFC Regalia")).toBe(true);
  });

  it("tracks the trip kitty separately from the ledger", () => {
    expect(ledger.totals.contributionsPaise).toBe(50_000_00);
    expect(ledger.balances["p_rohit"].contributedPaise).toBe(20_000_00);
  });
});
