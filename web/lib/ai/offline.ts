import { runTool, type ToolContext, type ToolResult } from "./tools";
import type { AgentTurn, ToolCallRecord } from "./agent";
import { verifyAnswer } from "./verify";

/**
 * Offline mode — rule-based, no LLM. Used when the AI proxy or API key is
 * unavailable (e.g. venue Wi-Fi). It recognises a handful of question
 * shapes, calls the SAME engine tools the model would, and fills fixed
 * templates from their output. It never invents an answer: anything it
 * doesn't recognise gets "I can't answer that offline".
 */

type Money = { text: string; paise: number };
type D = Record<string, any>; // tool payloads are plain JSON built in tools.ts

const SELF_RE = /\b(i|me|my|mine)\b/i;

function peopleIn(text: string, ctx: ToolContext): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();
  for (const p of ctx.state.participants) {
    const first = p.name.split(" ")[0].toLowerCase();
    if (new RegExp(`\\b${first}\\b`).test(lower) || lower.includes(p.name.toLowerCase())) found.push(p.name.split(" ")[0]);
  }
  if (!found.length && SELF_RE.test(text)) found.push("me");
  return found;
}

function dateIn(text: string, ctx: ToolContext): string | undefined {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (iso) return iso[1];
  if (/\btomorrow\b/i.test(text)) {
    const base = ctx.today ? new Date(`${ctx.today}T12:00:00`) : new Date();
    base.setDate(base.getDate() + 1);
    return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(base.getDate()).padStart(2, "0")}`;
  }
  return undefined;
}

const m = (x: Money) => x.text;

function bullets(lines: string[]) {
  return lines.map((l) => `• ${l}`).join("\n");
}

export function answerOffline(question: string, ctx: ToolContext): AgentTurn {
  const calls: ToolCallRecord[] = [];
  const call = (name: string, input: Record<string, unknown> = {}): ToolResult => {
    const result = runTool(name, input, ctx);
    calls.push({ id: `offline_${calls.length + 1}`, name, input, result });
    return result;
  };
  const q = question.trim();
  const lower = q.toLowerCase();
  const people = peopleIn(q, ctx);
  let text: string;

  const errorText = (r: ToolResult) => (r.ok ? "" : `${r.error}${r.candidates?.length ? ` Try one of: ${r.candidates.join(", ")}.` : ""}`);

  // Amounts in the question (dates stripped first so "2026-10-01" isn't read as rupees).
  const amountMatch = /(?:₹|rs\.?\s*|inr\s*)?(\d[\d,]*(?:\.\d+)?)\s*(k|lakhs?|lac|l)?\b/i.exec(q.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ""));
  const amountText = amountMatch ? `${amountMatch[1]}${amountMatch[2] ? ` ${amountMatch[2]}` : ""}` : null;
  const repriceWords = /\b(costs?|price[sd]?|pricier|cheaper|increases?|decreases?|goes up|goes down|rises?|more expensive)\b/;

  if (amountText && /\b(below|under|within|stay under|budget of|keep)\b/.test(lower) && !/\bwhat if\b/.test(lower)) {
    const r = call("check_budget_target", { target: amountText });
    if (!r.ok) text = errorText(r);
    else {
      const d = r.data as D;
      const line = (label: string, x: D) => `${label} ${m(x.amount)}: ${x.within ? `within target, ${m(x.headroom)} to spare` : `over target by ${m(x.overBy)}`}`;
      text = [
        `Target ${m(d.target)} (${m(d.targetPerPerson)} each for ${d.members}).`,
        bullets([line("Planned", d.planned), line("Committed with vendors", d.committedWithVendors), line("Spent so far (net of refunds)", d.spentNetOfRefunds)]),
        d.planned.within ? "The current plan fits." : `Biggest planned items to look at:\n${bullets(d.biggestPlannedItems.map((i: D) => `${i.item}: ${m(i.planned)} (${i.people} people, ${i.status})`))}`,
      ].join("\n\n");
    }
  } else if (amountText && repriceWords.test(lower) && !/\b(leaves?|drops? out of|quits?)\b/.test(lower)) {
    const booking = /(?:if|the)\s+(?:the\s+)?([a-z0-9 ]+?)\s+(?:price|cost|costs|rate|goes|gets|is|becomes|increases|decreases|rises)\b/.exec(lower)?.[1]?.replace(/^the /, "") ?? "";
    const isDelta = /\b(more|less|by|increases?|decreases?|goes up|goes down|rises?|extra|cheaper|pricier)\b/.test(lower);
    const down = /\b(less|decreases?|goes down|cheaper|reduced?)\b/.test(lower);
    const r = call("simulate_change", isDelta ? { kind: "reprice", booking, change_by: `${down ? "-" : ""}${amountText}` } : { kind: "reprice", booking, new_amount: amountText });
    if (!r.ok) text = errorText(r);
    else {
      const d = r.data as D;
      const people2 = d.people.map((p: D) => `${p.name}: ${m(p.balanceBefore)} → ${m(p.balanceAfter)} (${m(p.change)})`);
      text = [
        `Simulation only — nothing has changed. ${d.change}.`,
        d.affectedBookings.length ? `Affected bookings:\n${bullets(d.affectedBookings.map((b: D) => `${b.booking}: ${m(b.costBefore)} → ${m(b.costAfter)} — ${b.what}`))}` : "",
        d.plan.change.paise !== 0 ? `Plan estimate ${m(d.plan.estimateBefore)} → ${m(d.plan.estimateAfter)} (${m(d.plan.change)}).` : "",
        people2.length ? `Balances:\n${bullets(people2)}` : "No member balances change — this only moves the plan estimate.",
        `Trip spend ${m(d.tripSpend.before)} → ${m(d.tripSpend.after)}. Settlement: ${d.settlement.transfersBefore} → ${d.settlement.transfersAfter} transfers.`,
        "Press Apply below to commit it, or open it in the simulator to see every line first.",
      ]
        .filter(Boolean)
        .join("\n\n");
    }
  } else if (/\b(what if|what happens if|suppose|simulate|affected if|impact if)\b/.test(lower) || /\b(leaves?|drops? out|quits?|cancel(?:s|led)?)\b/.test(lower)) {
    const cancel = /\bcancel/.exec(lower) && !/\b(leaves?|drops? out|quits?)\b/.test(lower);
    const dropMatch = /drops? out of (?:the )?([a-z0-9 ]+?)(?:\?|$| on | tomorrow| today)/.exec(lower);
    const date = dateIn(q, ctx);
    let r: ToolResult;
    if (cancel) {
      const booking = /cancel(?:s|led)?\s+(?:the\s+)?([a-z0-9 ]+?)(?:\?|$| on | tomorrow| today)/.exec(lower)?.[1] ?? "";
      r = call("simulate_change", { kind: "cancel-booking", booking, ...(date ? { date } : {}) });
    } else if (!people.length) {
      return { text: "Who is leaving? Name a member, e.g. \"What if Siya leaves today?\"", calls, verification: { verified: [], unverified: [] }, stopReason: null };
    } else if (dropMatch) {
      r = call("simulate_change", { kind: "withdraw", person: people[0], booking: dropMatch[1], ...(date ? { date } : {}) });
    } else {
      r = call("simulate_change", { kind: "leave-trip", person: people[0], ...(date ? { date } : {}) });
    }
    if (!r.ok) text = errorText(r);
    else {
      const d = r.data as D;
      const onlyAffected = /\b(which|what) bookings\b/.test(lower);
      const lines: string[] = [];
      for (const b of d.affectedBookings) lines.push(`${b.booking}: ${b.what}`);
      const refunds = d.vendorRefunds.map((x: D) => `${m(x.amount)} back from ${x.booking} to ${x.paidBackTo}`);
      const people2 = d.people.map((p: D) => `${p.name}: ${m(p.balanceBefore)} → ${m(p.balanceAfter)} (${m(p.change)})`);
      text = [
        `Simulation only — nothing has changed. ${d.change}.`,
        `Affected bookings (${d.affectedBookings.length}):\n${bullets(lines)}`,
        d.unaffectedBookings.length ? `Unaffected: ${d.unaffectedBookings.map((b: D) => `${b.booking} (${b.why})`).join("; ")}.` : "",
        !onlyAffected && refunds.length ? `Vendor refunds:\n${bullets(refunds)}` : "",
        !onlyAffected ? `Balances:\n${bullets(people2)}` : "",
        !onlyAffected ? `Trip spend ${m(d.tripSpend.before)} → ${m(d.tripSpend.after)}. Settlement: ${d.settlement.transfersBefore} → ${d.settlement.transfersAfter} transfers.` : "",
        "Press Apply below to commit it, or open it in the simulator to see every line first.",
      ]
        .filter(Boolean)
        .join("\n\n");
    }
  } else if (/\b(owes?|owed|owing|balances?|in the red|who pays)\b/.test(lower) && /\bwhy\b|\bexplain\b|\bhow come\b/.test(lower)) {
    const r = call("explain_balance", { person: people[0] ?? "me" });
    if (!r.ok) text = errorText(r);
    else {
      const d = r.data as D;
      const lines = d.bookings.map((b: D) => `${b.booking}: paid ${m(b.paid)}, share ${m(b.share)} (${b.howShareIsComputed})`);
      const settle = d.settlements.map((s: D) => `${s.direction === "sent" ? "Sent" : "Received"} ${m(s.amount)} ${s.direction === "sent" ? "to" : "from"} ${s.with} (${s.status})`);
      text = [`${d.person} ${d.position}${d.position === "settled" ? "" : ` ${m(d.amount)}`}.`, bullets([...lines, ...settle]), `Paid ${m(d.totals.paid)} − share ${m(d.totals.share)} + settlements ${m(d.totals.settledNet)} = ${m(d.totals.net)}.`].join("\n\n");
    }
  } else if (/\b(owes?|owed|owing|balances?|debt|who pays)\b/.test(lower)) {
    const r = call("get_balances");
    const d = (r as { data: D }).data;
    const lines = d.balances.map((b: D) => `${b.name}: ${b.position}${b.position === "settled" ? "" : ` ${m(b.amount)}`}`);
    text = [
      d.owesTheMost ? `${d.owesTheMost.name} owes the most: ${m(d.owesTheMost.amount)}.` : "Nobody owes anything.",
      d.isOwedTheMost ? `${d.isOwedTheMost.name} is owed the most: ${m(d.isOwedTheMost.amount)}.` : "",
      bullets(lines),
      d.paymentsAwaitingConfirmation.length ? `Awaiting confirmation: ${d.paymentsAwaitingConfirmation.map((p: D) => `${p.from} → ${p.to} ${m(p.amount)}`).join("; ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  } else if (/\b(settle|settlement|transfers?|fewest|minimi[sz]e|pay back)\b/.test(lower)) {
    const r = call("get_settlement_plan");
    const d = (r as { data: D }).data;
    text = d.transferCount
      ? [`${d.transferCount} transfers settle everything (instead of ${d.naivePairwiseDebts} pairwise debts):`, bullets(d.transfers.map((t: D) => `${t.from} → ${t.to} ${m(t.amount)}`)), d.algorithm].join("\n\n")
      : "Everyone is settled — no transfers needed.";
  } else if (/\b(spent|spend|spending|cost|budget)\b/.test(lower)) {
    const catMatch = /\bon (?:the )?([a-z ]+?)(?:\?|$)/.exec(lower)?.[1]?.trim();
    const r = call("get_spending", catMatch ? { category: catMatch } : {});
    if (!r.ok) text = errorText(r);
    else {
      const d = r.data as D;
      const lines = d.categories.map((c: D) => `${c.category}: paid ${m(c.paidToVendors)}, refunded ${m(c.refunded)}, net ${m(c.netSpend)} (planned ${m(c.planned)})`);
      text = [bullets(lines), d.totals ? `Total net spend ${m(d.totals.netSpend)} against ${m(d.totals.planned)} planned.` : ""].filter(Boolean).join("\n\n");
    }
  } else if (/\b(bookings?|activities|part of|going to|signed up)\b/.test(lower)) {
    const r = call("list_bookings", people[0] ? { person: people[0] } : {});
    if (!r.ok) text = errorText(r);
    else {
      const d = r.data as D;
      const lines = d.bookings.map((b: D) => `${b.booking} (${b.status}, ${b.pricing}) — ${b.participants.length} people${b.shareOf ? `, ${b.shareOf.name}'s share ${m(b.shareOf.share)}` : ""}`);
      text = [`${d.person ? `${d.person} is on` : "Bookings"} (${d.bookings.length}):`, bullets(lines), d.plannedNotYetPaid.length ? `Planned, not yet paid: ${d.plannedNotYetPaid.map((i: D) => i.item).join(", ")}.` : ""].filter(Boolean).join("\n\n");
    }
  } else if (/\b(wrong|inconsisten\w*|anomal\w*|mismatch\w*|problems?|issues?|errors?|check)\b/.test(lower)) {
    const r = call("get_anomalies");
    const d = (r as { data: D }).data;
    text = d.count ? [`${d.count} thing${d.count === 1 ? "" : "s"} to check (found by deterministic rules):`, bullets(d.anomalies.map((a: D) => `[${a.severity}] ${a.title} — ${a.detail}`))].join("\n\n") : "No inconsistencies found.";
  } else if (/\b(health|overview|status|summary|how are we|how is the trip)\b/.test(lower)) {
    const r = call("get_trip_health");
    const d = (r as { data: D }).data;
    text = bullets([
      `Planned ${m(d.budgetPlanned)}, committed ${m(d.committed)}, spent ${m(d.spentNetOfRefunds)} after ${m(d.refunded)} refunds`,
      `${d.settledPercent}% settled between members, ${m(d.outstandingBetweenMembers)} outstanding`,
      `${d.members} members, ${d.activeBookings} active bookings, ${d.cancelledBookings} cancelled`,
      `${d.warnings.length} warning${d.warnings.length === 1 ? "" : "s"}`,
    ]);
  } else {
    text = "I can't answer that in offline mode. Try: who owes the most, what if <name> leaves, what if the villa costs ₹5,000 more, why does <name> owe money, how much have we spent on stays, can we keep the trip below ₹1,00,000, which bookings is <name> in, is anything inconsistent, or how do we settle.";
  }

  const verification = verifyAnswer(text, calls.filter((c) => c.result.ok).map((c) => (c.result as { data: unknown }).data));
  return { text, calls, verification, stopReason: null };
}
