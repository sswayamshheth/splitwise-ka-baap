import { describe, expect, it } from "vitest";

import { allocate, formatMoney, formatMoneyCompact, parseAmount, splitEqual, sumPaise } from "../lib/money";

describe("parseAmount", () => {
  it("parses rupees and paise into integer paise", () => {
    expect(parseAmount("1500")).toEqual({ paise: 150000 });
    expect(parseAmount("1500.50")).toEqual({ paise: 150050 });
    expect(parseAmount("1,500.5")).toEqual({ paise: 150050 });
    expect(parseAmount("₹ 12,000")).toEqual({ paise: 1200000 });
    expect(parseAmount("0.01")).toEqual({ paise: 1 });
    expect(parseAmount(".5")).toEqual({ paise: 50 });
  });

  it("rejects invalid input with a message", () => {
    expect(parseAmount("").error).toBeDefined();
    expect(parseAmount("-5").error).toMatch(/negative/);
    expect(parseAmount("12.345").error).toMatch(/two decimal/);
    expect(parseAmount("abc").error).toBeDefined();
    expect(parseAmount("1e5").error).toBeDefined();
    expect(parseAmount("99999999999999").error).toMatch(/too large/);
  });
});

describe("formatMoney", () => {
  it("uses Indian digit grouping", () => {
    expect(formatMoney(150050)).toBe("₹1,500.50");
    expect(formatMoney(15005000)).toBe("₹1,50,050");
    expect(formatMoney(1234567890)).toBe("₹1,23,45,678.90");
    expect(formatMoney(0)).toBe("₹0");
    expect(formatMoney(5)).toBe("₹0.05");
  });
  it("handles sign and paise modes", () => {
    expect(formatMoney(-240000)).toBe("−₹2,400");
    expect(formatMoney(240000, { signed: true })).toBe("+₹2,400");
    expect(formatMoney(240000, { paise: "always" })).toBe("₹2,400.00");
    expect(formatMoney(240050, { paise: "never" })).toBe("₹2,401");
    expect(formatMoney(1200, { bare: true })).toBe("12");
  });
  it("compacts large values", () => {
    expect(formatMoneyCompact(12785050)).toBe("₹1.28L");
    expect(formatMoneyCompact(6200000)).toBe("₹62K");
    expect(formatMoneyCompact(840000)).toBe("₹8,400");
  });
});

describe("allocate", () => {
  it("always sums to the total", () => {
    for (const [total, weights] of [
      [800000, [1, 1, 1]],
      [100, [1, 1, 1]],
      [1, [1, 1, 1, 1]],
      [315050, [1, 1, 1]],
      [999999, [3, 2, 2, 1, 1, 7]],
      [240000, [140000, 100000]],
    ] as [number, number[]][]) {
      const parts = allocate(total, weights);
      expect(sumPaise(parts)).toBe(total);
      expect(parts.every(Number.isInteger)).toBe(true);
    }
  });
  it("distributes leftover paise deterministically", () => {
    expect(allocate(800000, [1, 1, 1])).toEqual([266667, 266667, 266666]);
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(splitEqual(1, 3)).toEqual([1, 0, 0]);
  });
  it("gives zero to zero weights and never splits a zero total", () => {
    expect(allocate(1000, [0, 1, 0])).toEqual([0, 1000, 0]);
    expect(allocate(1000, [0, 0])).toEqual([0, 0]);
    expect(allocate(0, [1, 2])).toEqual([0, 0]);
    expect(allocate(1000, [])).toEqual([]);
  });
  it("allocates negative totals symmetrically", () => {
    expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
  });
});
