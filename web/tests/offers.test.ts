import { describe, expect, it } from "vitest";

import { analysePayments, bestOfferForMethod, discountFor, optimisePayment, BANK_OFFERS } from "../lib/ledger/offers";
import { buildDemoEvents } from "../lib/ledger/demo";
import { reduceEvents } from "../lib/ledger/reduce";
import type { ParticipantData, PaymentMethod } from "../lib/ledger/types";

const card = (id: string, label: string, bank: string, network: PaymentMethod["network"], headroomPaise?: number): PaymentMethod => ({
  id,
  kind: "credit-card",
  label,
  bank,
  network,
  headroomPaise,
});

const people: ParticipantData[] = [
  { id: "rohit", name: "Rohit", paymentMethods: [card("m_regalia", "HDFC Regalia", "HDFC Bank", "Visa", 2_50_000_00)] },
  { id: "aisha", name: "Aisha", paymentMethods: [card("m_atlas", "Axis Atlas", "Axis Bank", "Mastercard", 1_00_000_00)] },
  { id: "priya", name: "Priya", paymentMethods: [card("m_idfc", "IDFC FIRST Select", "IDFC FIRST", "RuPay", 80_000_00)] },
  { id: "neha", name: "Neha", paymentMethods: [] },
];

describe("payment optimiser", () => {
  it("names the card with the biggest eligible discount (the brief's homestay case)", () => {
    const result = optimisePayment(people, { amountPaise: 62_000_00, category: "Stay", vendor: "Himalayan Nest Homestay" });
    expect(result.best?.participantId).toBe("rohit");
    expect(result.best?.method.label).toBe("HDFC Regalia");
    // 12% of ₹62,000 = ₹7,440, under the ₹10,000 cap.
    expect(result.best?.discountPaise).toBe(7_440_00);
    expect(result.best?.offer?.percentOff).toBe(12);
    expect(result.edgePaise).toBeGreaterThan(0);
  });

  it("respects minimum spend, the offer cap and credit headroom", () => {
    // Below the ₹25,000 minimum, the Regalia stay offer does not apply.
    const small = optimisePayment([people[0]], { amountPaise: 10_000_00, category: "Stay" });
    expect(small.best?.discountPaise).toBe(0);

    // Capped: 12% of ₹2,00,000 is ₹24,000 but the cap is ₹10,000.
    const capped = optimisePayment([people[0]], { amountPaise: 2_00_000_00, category: "Stay" });
    expect(capped.best?.discountPaise).toBe(10_000_00);

    // Not enough headroom: the card can't take the bill at all.
    const broke = optimisePayment([{ ...people[1], paymentMethods: [card("m_small", "Axis Atlas", "Axis Bank", "Mastercard", 5_000_00)] }], {
      amountPaise: 50_000_00,
      category: "Transport",
    });
    expect(broke.best).toBeUndefined();
    expect(broke.options[0].affordable).toBe(false);
    expect(broke.options[0].blocked).toBeDefined();
  });

  it("picks the right card per category", () => {
    expect(optimisePayment(people, { amountPaise: 20_000_00, category: "Transport" }).best?.participantId).toBe("aisha");
    expect(optimisePayment(people, { amountPaise: 5_000_00, category: "Local travel" }).best?.participantId).toBe("priya");
  });

  it("returns no recommendation when nobody has a card", () => {
    const result = optimisePayment([people[3]], { amountPaise: 5_000_00, category: "Stay" });
    expect(result.options).toHaveLength(0);
    expect(result.best).toBeUndefined();
  });

  it("is deterministic", () => {
    const input = { amountPaise: 62_000_00, category: "Stay" as const };
    const a = optimisePayment(people, input);
    const b = optimisePayment(people, input);
    expect(a.options.map((o) => o.method.id)).toEqual(b.options.map((o) => o.method.id));
  });

  it("never returns a discount above the cap or the bill", () => {
    for (const offer of BANK_OFFERS) {
      for (const amount of [offer.minSpendPaise, offer.minSpendPaise * 10, 99_99_999_00]) {
        const d = discountFor(offer, amount);
        expect(d).toBeLessThanOrEqual(offer.maxDiscountPaise);
        expect(d).toBeLessThanOrEqual(amount);
        expect(Number.isInteger(d)).toBe(true);
      }
    }
  });

  it("matches a single card against the same rules", () => {
    const { offer, discountPaise } = bestOfferForMethod(people[0].paymentMethods![0], { amountPaise: 62_000_00, category: "Stay" });
    expect(offer?.id).toBe("of_hdfc_regalia_hotel");
    expect(discountPaise).toBe(7_440_00);
  });
});

describe("payment analyser", () => {
  const state = reduceEvents(buildDemoEvents(new Date("2026-09-09T12:00:00").getTime()))!;
  const analysis = analysePayments(state);

  it("reports what each payment captured", () => {
    expect(analysis.payments.length).toBeGreaterThan(0);
    const homestay = analysis.payments.find((p) => p.expense.id === "x_homestay")!;
    expect(homestay.capturedPaise).toBe(7_440_00);
    expect(homestay.method?.label).toBe("HDFC Regalia");
    // Compared against the pre-discount bill, the best card was in fact used.
    expect(homestay.bestPossiblePaise).toBe(7_440_00);
    expect(homestay.missedPaise).toBe(0);
  });

  it("never claims more was captured than was available", () => {
    for (const p of analysis.payments) {
      expect(p.capturedPaise).toBeLessThanOrEqual(p.bestPossiblePaise);
      expect(p.missedPaise).toBe(Math.max(0, p.bestPossiblePaise - p.capturedPaise));
    }
    expect(analysis.capturedPaise).toBeLessThanOrEqual(analysis.potentialPaise);
  });

  it("groups savings by member and by card", () => {
    expect(analysis.byMember.length).toBeGreaterThan(0);
    expect(analysis.byCard.some((c) => c.label === "HDFC Regalia")).toBe(true);
    const total = analysis.byMember.reduce((s, m) => s + m.capturedPaise, 0);
    expect(total).toBe(analysis.capturedPaise);
  });

  it("flags a payment where another card would have done better", () => {
    const cabs = analysis.payments.find((p) => p.expense.id === "x_cabs")!;
    expect(cabs.capturedPaise).toBe(0);
    // Priya's IDFC card carries a local-travel offer that nobody used.
    expect(cabs.bestPossiblePaise).toBeGreaterThan(0);
    expect(cabs.missedPaise).toBe(cabs.bestPossiblePaise);
  });
});
