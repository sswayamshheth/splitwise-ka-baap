import { describe, expect, it } from "vitest";

import { askClaude } from "@/lib/ai/agent";
import { answerOffline } from "@/lib/ai/offline";
import { resolveBooking, resolvePerson, runTool, type ToolContext } from "@/lib/ai/tools";
import { extractAmounts, verifyAnswer } from "@/lib/ai/verify";
import { buildGoaEvents, GOA } from "@/lib/ledger/demo-goa";
import { computeLedger } from "@/lib/ledger/engine";
import { reduceEvents } from "@/lib/ledger/reduce";
import { simulate } from "@/lib/ledger/simulate";
import { formatMoney } from "@/lib/money";

const NOW = new Date(2026, 8, 26, 12).getTime();

function goa(): ToolContext {
  const events = buildGoaEvents(NOW);
  const state = reduceEvents(events)!;
  return { state, ledger: computeLedger(state), events, viewerId: GOA.aarav, today: "2026-09-26", now: NOW };
}

type D = Record<string, any>;
const data = (r: ReturnType<typeof runTool>) => {
  if (!r.ok) throw new Error(r.error);
  return r.data as D;
};

describe("15 · AI tools query the real ledger", () => {
  it("get_balances names the biggest debtor straight from the engine", () => {
    const ctx = goa();
    const d = data(runTool("get_balances", {}, ctx));
    const nets = ctx.state.participants.map((p) => ({ p, net: ctx.ledger.balances[p.id].netPaise })).sort((a, b) => a.net - b.net);
    expect(d.owesTheMost.name).toBe(nets[0].p.name);
    expect(d.owesTheMost.amount.paise).toBe(-nets[0].net);
    expect(d.sumOfAllBalances.paise).toBe(0);
  });

  it("explain_balance totals equal the engine balance", () => {
    const ctx = goa();
    const d = data(runTool("explain_balance", { person: "meera" }, ctx));
    expect(d.person).toBe("Meera Joshi");
    expect(d.net.paise).toBe(ctx.ledger.balances[GOA.meera].netPaise);
    expect(d.bookings.length).toBeGreaterThan(0);
  });

  it("get_spending resolves synonyms (accommodation → Stay)", () => {
    const d = data(runTool("get_spending", { category: "accommodation" }, goa()));
    expect(d.categories).toHaveLength(1);
    expect(d.categories[0].category).toBe("Stay");
    expect(d.categories[0].paidToVendors.paise).toBe(54_000_00);
  });

  it("list_bookings filters by person", () => {
    const d = data(runTool("list_bookings", { person: "Meera" }, goa()));
    expect(d.bookings.map((b: D) => b.booking)).not.toContain("IndiGo 6E-5312 · Mumbai → Goa");
    expect(d.bookings.map((b: D) => b.booking)).toContain("Villa Azul · 4 nights");
  });

  it("settlement plan and anomalies come from the engine", () => {
    const ctx = goa();
    expect(data(runTool("get_settlement_plan", {}, ctx)).transferCount).toBe(ctx.ledger.transfers.length);
    const a = data(runTool("get_anomalies", {}, ctx));
    expect(a.anomalies.some((x: D) => x.title.includes("Airport pickup"))).toBe(true);
  });

  it("rejects unknown and ambiguous names instead of guessing", () => {
    const ctx = goa();
    const r = runTool("explain_balance", { person: "Zoya" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.candidates).toContain("Siya Kapoor");
    expect(resolvePerson(ctx, "me")).toEqual({ ok: true, value: GOA.aarav });
    expect(resolveBooking(ctx, "the villa")).toEqual({ ok: true, value: "x_villa" });
    expect(resolveBooking(ctx, "scuba")).toEqual({ ok: true, value: "x_scuba" });
    expect(runTool("delete_everything", {}, ctx).ok).toBe(false);
  });
});

describe("16 · AI what-if goes through the simulator and never applies", () => {
  it("simulate_change for Aarav leaving matches simulate() exactly", () => {
    const ctx = goa();
    const before = JSON.stringify(ctx.events);
    const d = data(runTool("simulate_change", { kind: "leave-trip", person: "Aarav" }, ctx));
    const sim = simulate(ctx.events, [{ kind: "leave-trip", participantId: GOA.aarav, date: "2026-09-26", rule: "redistribute" }], { actor: GOA.aarav, now: NOW });
    if (!sim.ok) throw new Error(sim.error);
    expect(d.applied).toBe(false);
    expect(d.tripSpend.after.paise).toBe(sim.diff.spendAfter);
    const siya = d.people.find((p: D) => p.name === "Siya Kapoor");
    expect(siya.change.paise).toBe(sim.diff.people.find((p) => p.participantId === GOA.siya)!.deltaPaise);
    expect(d.settlement.transfersAfter).toBe(sim.diff.transfersAfter.length);
    expect(d.changeSpec).toEqual({ kind: "leave-trip", participantId: GOA.aarav, date: "2026-09-26", rule: "redistribute" });
    expect(JSON.stringify(ctx.events)).toBe(before);
  });

  it("invalid what-ifs are reported, not guessed", () => {
    const ctx = goa();
    expect(runTool("simulate_change", { kind: "withdraw", person: "Rohan", booking: "scuba" }, ctx).ok).toBe(false);
    expect(runTool("simulate_change", { kind: "leave-trip", person: "Siya", date: "tomorrow" }, ctx).ok).toBe(false);
    expect(runTool("simulate_change", { kind: "teleport", person: "Siya" }, ctx).ok).toBe(false);
  });
});

describe("verification of ₹ figures", () => {
  it("extracts rupee amounts in the usual spellings", () => {
    expect(extractAmounts("₹10,800 and −₹1,800, Rs 500 or INR 2,880.50").map((a) => a.paise)).toEqual([10_800_00, 1_800_00, 500_00, 2_880_50]);
  });

  it("flags a fabricated figure and passes real ones", () => {
    const ctx = goa();
    const out = data(runTool("get_balances", {}, ctx));
    const real = out.owesTheMost.amount.text;
    const v = verifyAnswer(`${out.owesTheMost.name} owes ${real}, roughly ₹12,345 more than last week.`, [out]);
    expect(v.verified).toEqual([real]);
    expect(v.unverified).toEqual(["₹12,345"]);
  });
});

describe("offline mode answers from the same tools", () => {
  it("who owes the most", () => {
    const ctx = goa();
    const turn = answerOffline("Who owes the most?", ctx);
    const top = data(runTool("get_balances", {}, ctx)).owesTheMost;
    expect(turn.calls.map((c) => c.name)).toEqual(["get_balances"]);
    expect(turn.text).toContain(top.name);
    expect(turn.text).toContain(top.amount.text);
    expect(turn.verification.unverified).toEqual([]);
  });

  it("what if Siya leaves", () => {
    const turn = answerOffline("What if Siya leaves today?", goa());
    expect(turn.calls[0].name).toBe("simulate_change");
    expect(turn.calls[0].result.ok).toBe(true);
    expect(turn.text).toMatch(/Simulation only/);
    expect(turn.verification.unverified).toEqual([]);
  });

  it("the other suggested questions route to the right tools with verified figures", () => {
    const ctx = goa();
    const cases: [string, string][] = [
      ["Why does Meera owe money?", "explain_balance"],
      ["How much have we spent on stays?", "get_spending"],
      ["Which bookings would be affected if Rohan leaves?", "simulate_change"],
      ["Is anything inconsistent?", "get_anomalies"],
      ["How do we settle with fewest payments?", "get_settlement_plan"],
    ];
    for (const [q, tool] of cases) {
      const turn = answerOffline(q, ctx);
      expect(turn.calls[0]?.name, q).toBe(tool);
      expect(turn.calls[0].result.ok, q).toBe(true);
      expect(turn.verification.unverified, q).toEqual([]);
    }
  });

  it("says so when it can't answer", () => {
    const turn = answerOffline("Book me a table at Thalassa", goa());
    expect(turn.calls).toHaveLength(0);
    expect(turn.text).toMatch(/can't answer that in offline mode/);
  });
});

describe("agent loop (proxy stubbed)", () => {
  it("runs tools locally, sends results back, and verifies the answer", async () => {
    const ctx = goa();
    const top = data(runTool("get_balances", {}, ctx)).owesTheMost;
    const sent: D[] = [];
    let round = 0;
    const post = async (body: unknown) => {
      sent.push(body as D);
      round++;
      if (round === 1) {
        return { id: "m1", type: "message", role: "assistant", model: "claude-opus-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "get_balances", input: {} }] } as never;
      }
      return { id: "m2", type: "message", role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: `${top.name} owes the most: ${top.amount.text}.` }] } as never;
    };
    const { turn, state } = await askClaude({ messages: [] }, "Who owes the most?", ctx, post);
    expect(turn.calls).toHaveLength(1);
    expect(turn.verification.unverified).toEqual([]);
    expect(turn.verification.verified).toEqual([top.amount.text]);
    const toolResult = (sent[1].messages as D[]).at(-1)!.content[0];
    expect(toolResult.type).toBe("tool_result");
    expect(JSON.parse(toolResult.content).owesTheMost.amount.text).toBe(formatMoney(top.amount.paise));
    expect(state.messages).toHaveLength(4);
  });
});

describe("budget targets, price changes and applying from chat", () => {
  it("check_budget_target: ₹1,00,000 vs the Goa plan is over by exactly planned − target", () => {
    const ctx = goa();
    const d = data(runTool("check_budget_target", { target: "1,00,000" }, ctx));
    expect(d.target.paise).toBe(1_00_000_00);
    expect(d.planned.amount.paise).toBe(ctx.ledger.budget.estimatedPaise);
    expect(d.planned.within).toBe(false);
    expect(d.planned.overBy.paise).toBe(ctx.ledger.budget.estimatedPaise - 1_00_000_00);
    expect(d.spentNetOfRefunds.amount.paise).toBe(ctx.ledger.totals.spendPaise);
    expect(d.spentNetOfRefunds.within).toBe(true);
    expect(d.spentNetOfRefunds.headroom.paise).toBe(1_00_000_00 - ctx.ledger.totals.spendPaise);
    expect(d.biggestPlannedItems[0].item).toBe("Villa Azul · 4 nights");
    // Units: 75k / 1.2 lakh parse deterministically.
    expect(data(runTool("check_budget_target", { target: "75k" }, ctx)).target.paise).toBe(75_000_00);
    expect(data(runTool("check_budget_target", { target: "1.2 lakh" }, ctx)).target.paise).toBe(1_20_000_00);
    expect(runTool("check_budget_target", { target: "lots" }, ctx).ok).toBe(false);
  });

  it('"hotel" resolves to the villa', () => {
    const r = resolveBooking(goa(), "hotel");
    expect(r.ok && r.value).toBe("x_villa");
  });

  it("reprice via the tool (change_by) matches simulate() exactly", () => {
    const ctx = goa();
    const d = data(runTool("simulate_change", { kind: "reprice", booking: "hotel", change_by: "₹5,000" }, ctx));
    expect(d.changeSpec).toEqual({ kind: "reprice", expenseId: "x_villa", newAmountPaise: 59_000_00 });
    const sim = simulate(ctx.events, [d.changeSpec], { actor: GOA.aarav, now: NOW });
    if (!sim.ok) throw new Error(sim.error);
    for (const p of d.people) {
      const pid = ctx.state.participants.find((x) => x.name === p.name)!.id;
      expect(p.balanceAfter.paise).toBe(sim.after.ledger.balances[pid].netPaise);
    }
    expect(d.tripSpend.after.paise).toBe(sim.after.ledger.totals.spendPaise);
  });

  it("reprice with new_amount, and a plan-only item falls back to the itinerary", () => {
    const ctx = goa();
    expect(data(runTool("simulate_change", { kind: "reprice", booking: "villa", new_amount: 60000 }, ctx)).changeSpec.newAmountPaise).toBe(60_000_00);
    const dinner = data(runTool("simulate_change", { kind: "reprice", booking: "Thalassa dinner", change_by: 2000 }, ctx));
    expect(dinner.changeSpec).toEqual({ kind: "reprice", itemId: "it_dinner", newAmountPaise: 10_000_00 });
    expect(dinner.plan.change.paise).toBe(2_000_00);
  });

  it("applying the tool's changeSpec gives exactly the simulated ledger", () => {
    const ctx = goa();
    const d = data(runTool("simulate_change", { kind: "leave-trip", person: "Siya" }, ctx));
    const sim = simulate(ctx.events, [d.changeSpec], { actor: GOA.aarav, now: NOW });
    if (!sim.ok) throw new Error(sim.error);
    expect(sim.events.length).toBe(d.ledgerEventsToWrite);
    const applied = computeLedger(reduceEvents([...ctx.events, ...sim.events])!);
    for (const p of d.people) {
      const pid = ctx.state.participants.find((x) => x.name === p.name)!.id;
      expect(applied.balances[pid].netPaise).toBe(p.balanceAfter.paise);
    }
  });

  it("offline router: price change and budget questions are answered from tools and fully verified", () => {
    const ctx = goa();
    const price = answerOffline("What if the hotel price increases by ₹5,000?", ctx);
    expect(price.calls[0].name).toBe("simulate_change");
    expect(price.text).toContain("Simulation only");
    expect(price.verification.unverified).toEqual([]);
    const budget = answerOffline("Can we keep the trip below ₹1,00,000?", ctx);
    expect(budget.calls[0].name).toBe("check_budget_target");
    expect(budget.text).toContain("over target by");
    expect(budget.verification.unverified).toEqual([]);
    const costs = answerOffline("What if the villa costs ₹60,000?", ctx);
    expect((costs.calls[0].result as { data: D }).data.changeSpec.newAmountPaise).toBe(60_000_00);
  });
});
