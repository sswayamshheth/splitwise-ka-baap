import { describe, expect, it } from "vitest";

import { minimiseSettlement } from "../lib/ledger/settlement";

function check(balances: Record<string, number>) {
  const transfers = minimiseSettlement(balances);
  const net: Record<string, number> = { ...balances };
  for (const t of transfers) {
    expect(t.amountPaise).toBeGreaterThan(0);
    expect(t.from).not.toBe(t.to);
    net[t.from] += t.amountPaise;
    net[t.to] -= t.amountPaise;
  }
  for (const v of Object.values(net)) expect(v).toBe(0);
  return transfers;
}

describe("minimiseSettlement", () => {
  it("returns nothing when everyone is settled", () => {
    expect(minimiseSettlement({ a: 0, b: 0 })).toEqual([]);
    expect(minimiseSettlement({})).toEqual([]);
  });

  it("settles two people with one transfer", () => {
    expect(check({ a: -500, b: 500 })).toEqual([{ from: "a", to: "b", amountPaise: 500 }]);
  });

  it("collapses a cycle A→B→C→A into direct payments", () => {
    // A owes B 10, B owes C 10, C owes A 4  ⇒ nets: A -6, B 0, C +6
    const t = check({ a: -600, b: 0, c: 600 });
    expect(t).toEqual([{ from: "a", to: "c", amountPaise: 600 }]);
  });

  it("finds exactly-cancelling pairs instead of chaining", () => {
    // Greedy alone would produce 3 transfers here; the partition finds two pairs.
    const t = check({ a: -1000, b: 1000, c: -700, d: 700 });
    expect(t).toHaveLength(2);
    expect(t).toContainEqual({ from: "a", to: "b", amountPaise: 1000 });
    expect(t).toContainEqual({ from: "c", to: "d", amountPaise: 700 });
  });

  it("uses at most n−1 transfers for a connected group", () => {
    const t = check({ a: -124000, b: 150000, c: -76000, d: 50000 });
    expect(t.length).toBeLessThanOrEqual(3);
  });

  it("handles a realistic six-person trip and reconciles to the paise", () => {
    const t = check({
      aisha: -1234567,
      rohit: 4620033,
      priya: -882100,
      amit: 1099000,
      neha: -2350000,
      karan: -1252366,
    });
    expect(t.length).toBeLessThanOrEqual(5);
  });

  it("is deterministic for the same input", () => {
    const input = { a: -300, b: 100, c: 200, d: -50, e: 50 };
    expect(minimiseSettlement(input)).toEqual(minimiseSettlement(input));
  });

  it("falls back to greedy for large groups", () => {
    const balances: Record<string, number> = {};
    for (let i = 0; i < 20; i++) balances[`p${i}`] = i % 2 === 0 ? 1000 + i : -(1000 + i - 1);
    const t = check(balances);
    expect(t.length).toBeLessThanOrEqual(19);
  });

  it("refuses balances that do not sum to zero", () => {
    expect(() => minimiseSettlement({ a: 1, b: 0 })).toThrow(/sum to zero/);
  });
});
