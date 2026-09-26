import { describe, expect, it } from "vitest";

import { pageOfferSaving, parseOfferText } from "@/lib/ext-offers";

describe("reading bank offers from a checkout page", () => {
  it("parses the common MakeMyTrip / airline offer formats", () => {
    const a = parseOfferText("Get 12% Instant Discount up to ₹5,000 on HDFC Bank Credit Cards. Min. booking value ₹10,000. Use code MMTHDFC")!;
    expect(a).toMatchObject({ bank: "HDFC Bank", cardKind: "credit-card", percent: 12, capPaise: 5_000_00, minPaise: 10_000_00, code: "MMTHDFC" });
    const b = parseOfferText("Flat ₹1,000 off on ICICI Bank cards")!;
    expect(b).toMatchObject({ bank: "ICICI Bank", flatPaise: 1_000_00 });
    expect(parseOfferText("Get 10% off with code SUMMER")).toBeNull(); // not a card offer
    expect(parseOfferText("Free cancellation")).toBeNull();
  });

  it("computes the saving for a card, respecting bank, card type, minimum and cap", () => {
    const o = parseOfferText("12% instant discount up to Rs. 5000 on HDFC credit cards, min txn value Rs 10000")!;
    const regalia = { bank: "HDFC Bank", network: "Visa", kind: "credit-card" };
    expect(pageOfferSaving(o, regalia, 54_000_00)).toBe(5_000_00); // capped
    expect(pageOfferSaving(o, regalia, 20_000_00)).toBe(2_400_00);
    expect(pageOfferSaving(o, regalia, 8_000_00)).toBe(0); // below minimum
    expect(pageOfferSaving(o, { bank: "HDFC Bank", kind: "debit-card" }, 20_000_00)).toBe(0); // credit only
    expect(pageOfferSaving(o, { bank: "Axis Bank", kind: "credit-card" }, 20_000_00)).toBe(0);
  });
});
