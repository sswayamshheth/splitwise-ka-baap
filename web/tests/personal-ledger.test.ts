import { describe, expect, it } from "vitest";

import { buildGoaEvents, GOA } from "@/lib/ledger/demo-goa";
import { computeLedger } from "@/lib/ledger/engine";
import { balanceBreakdown } from "@/lib/ledger/explain";
import { personalLedger } from "@/lib/ledger/personal";
import { reduceEvents } from "@/lib/ledger/reduce";

const NOW = new Date(2026, 8, 26, 12).getTime();
const state = reduceEvents(buildGoaEvents(NOW))!;
const ledger = computeLedger(state);

describe("personal ledger", () => {
  for (const [name, pid] of Object.entries(GOA)) {
    it(`${name}: categories sum to their share, paid matches the balance breakdown`, () => {
      const p = personalLedger(state, ledger, pid);
      const b = balanceBreakdown(state, ledger, pid);
      const catShare = p.categories.reduce((s, c) => s + c.sharePaise, 0);
      const catPaid = p.categories.reduce((s, c) => s + c.paidPaise, 0);
      expect(catShare).toBe(p.totalSharePaise);
      expect(p.totalSharePaise).toBe(b.sharePaise);
      expect(p.totalSharePaise).toBe(ledger.balances[pid].sharePaise);
      expect(catPaid).toBe(b.paidPaise);
      expect(p.paidPaise).toBe(b.paidPaise);
      expect(p.netPaise).toBe(ledger.balances[pid].netPaise);
      for (const c of p.categories) {
        expect(c.items.reduce((s, i) => s + i.sharePaise, 0)).toBe(c.sharePaise);
        expect(c.sharePaise !== 0 || c.paidPaise !== 0).toBe(true);
      }
      // categories are sorted by share, largest first
      for (let i = 1; i < p.categories.length; i++) expect(p.categories[i - 1].sharePaise).toBeGreaterThanOrEqual(p.categories[i].sharePaise);
      expect(p.settlements).toEqual(b.settlements);
    });
  }

  it("a cancelled booking shows up as cancelled, carrying only the non-refunded loss", () => {
    const c = ledger.byExpenseId["x_safari"];
    expect(c.expense.status).toBe("cancelled");
    const dev = personalLedger(state, ledger, GOA.dev);
    const item = dev.categories.flatMap((x) => x.items).find((i) => i.expenseId === "x_safari")!;
    expect(item.status).toBe("cancelled");
    expect(item.refundedPaise).toBe(5_400_00);
    expect(item.sharePaise).toBe(c.shares[GOA.dev]);
    expect(item.paidPaise).toBe(7_200_00 - 5_400_00);
    // Aarav was never on the safari
    const aarav = personalLedger(state, ledger, GOA.aarav);
    expect(aarav.categories.flatMap((x) => x.items).some((i) => i.expenseId === "x_safari")).toBe(false);
  });
});
