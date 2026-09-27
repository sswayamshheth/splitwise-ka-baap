import { formatMoney } from "@/lib/money";
import { primaryPerItem, type Twin } from "./twin";

/**
 * Grounded explanations. `factsFor` collects the exact data behind a
 * recommendation / removal / cost change from the twin (which got its money
 * from the ledger). The deterministic answer is written only from those
 * facts; a model answer is accepted only if every number in it is in them.
 */

export type Intent = "why-recommended" | "why-removed" | "why-cost" | "why-better" | "general";

export function intentOf(question: string): Intent {
  const q = question.toLowerCase();
  if (/cost|money|price|pay|refund|balance|share|₹|rupee|budget|expensive|cheaper/.test(q)) return "why-cost";
  if (/remov|drop|cancel|unavailable|affected|risk|why not|taken out/.test(q)) return "why-removed";
  if (/better|instead|compare|versus|vs\.?/.test(q)) return "why-better";
  if (/recommend|suggest|pick|chose|choose|alternative|why this/.test(q)) return "why-recommended";
  return "general";
}

export type Facts = Record<string, unknown>;

export function factsFor(twin: Twin, focusItemId?: string): Facts {
  const recs = primaryPerItem(twin.recommendations);
  const rec = (focusItemId ? recs.find((r) => r.forItemId === focusItemId) : undefined) ?? recs[0];
  const item = twin.items.find((t) => t.id === (rec?.forItemId ?? focusItemId ?? twin.headline.itemId));
  const others = rec ? twin.recommendations.filter((r) => r.forItemId === rec.forItemId && r.id !== rec.id) : [];
  return {
    mode: twin.mode === "simulated" ? "SIMULATED digital twin (real trip unchanged)" : twin.worldMode === "replay" ? "REAL trip with a RECORDED (not live) forecast capture" : "REAL trip with live forecast",
    scenario: twin.scenario ?? undefined,
    item: item
      ? {
          title: item.title,
          date: item.date,
          paid: item.paid,
          availability: item.assessment.availability,
          impactScore: item.assessment.impactScore,
          level: item.assessment.level,
          suitability: item.assessment.suitability,
          drivers: item.assessment.drivers,
          weatherSource: item.conditions.source,
          components: item.assessment.components.map((c) => `${c.label} ${c.value} (${c.detail})`),
        }
      : undefined,
    recommendation: rec
      ? {
          kind: rec.kind,
          strategy: rec.strategy,
          alternative: rec.alternative?.candidate.name ?? rec.stayIn?.title,
          newTime: rec.newDate ? `${rec.newDate}${rec.newTime ? ` ${rec.newTime}` : ""}` : rec.newTime,
          score: rec.score,
          breakdown: rec.breakdown.map((b) => `${b.label}: ${b.value < 0 ? "no data" : b.value} — ${b.detail}`),
          evidence: rec.evidence.map((e) => `${e.label}: ${e.text} [${e.source ?? ""}]`),
          rationale: rec.rationale,
          chain: rec.chain,
          chosenBy: rec.chosenBy,
        }
      : undefined,
    runnerUps: others.map((o) => ({ kind: o.kind, strategy: o.strategy, alternative: o.alternative?.candidate.name ?? o.stayIn?.title, newTime: o.newDate ?? o.newTime, score: o.score })),
    money: rec?.finance?.ok
      ? {
          changes: rec.finance.lines,
          refunds: rec.finance.refunds.map((r) => `${formatMoney(r.amountPaise)} to ${r.to} for ${r.expense}`),
          planBefore: formatMoney(rec.finance.plannedBefore),
          planAfter: formatMoney(rec.finance.plannedAfter),
          people: rec.finance.people.map((p) => `${p.name}: ${formatMoney(p.before, { signed: true })} → ${formatMoney(p.after, { signed: true })}`),
          computedBy: "ledger simulate() on a copy of the event log",
        }
      : undefined,
    effects: twin.effects.filter((e) => !item || !e.itemId || e.itemId === item.id).map((e) => `${e.kind}: ${e.text}`).slice(0, 8),
  };
}

/** The deterministic, fully grounded answer. */
export function explainDeterministic(question: string, facts: Facts): string {
  const intent = intentOf(question);
  const item = facts.item as { title: string; availability: string; impactScore: number; level: string; drivers: string[]; weatherSource: string; paid: boolean } | undefined;
  const rec = facts.recommendation as { kind: string; alternative?: string; newTime?: string; score: number; breakdown: string[]; rationale: string } | undefined;
  const money = facts.money as { changes: string[]; refunds: string[]; planBefore: string; planAfter: string; people: string[] } | undefined;
  const runnerUps = (facts.runnerUps as { kind: string; alternative?: string; newTime?: string; score: number }[] | undefined) ?? [];
  const src = item?.weatherSource === "simulated" ? "In this simulated scenario" : "On the live forecast";
  if (!item) return "Nothing in the plan is affected right now, so there is nothing to explain — try a What-If scenario.";
  if (intent === "why-removed") {
    return `${src}, ${item.title} is ${item.availability} with an impact score of ${item.impactScore}/100 (${item.level}). Drivers: ${item.drivers.join("; ")}.${item.paid ? " It is already paid, so replacing it goes through the vendor's cancellation policy in the ledger." : " It is not paid yet, so it can be swapped with no money lost."}`;
  }
  if (intent === "why-cost") {
    if (!money) return `${item.title}'s swap has no ledger consequence to explain.`;
    return `The ledger re-ran the plan with these changes: ${money.changes.join("; ")}. ${money.refunds.length ? `Vendor refunds: ${money.refunds.join("; ")}. ` : ""}Planned total goes from ${money.planBefore} to ${money.planAfter}.${money.people.length ? ` Balances: ${money.people.join("; ")}.` : " Nobody's balance moves."} These figures come from the deterministic ledger, not the AI.`;
  }
  if (!rec) return `${item.title} is ${item.availability} (${item.drivers[0]}), but no suitable nearby alternative was found in OpenStreetMap for that time.`;
  if (intent === "why-better" && runnerUps.length) {
    const r = runnerUps[0];
    return `${rec.kind === "replace" ? rec.alternative : `Moving to ${rec.newTime}`} scores ${rec.score}/100 against ${r.kind === "replace" ? r.alternative : `moving to ${r.newTime}`} at ${r.score}/100. ${rec.rationale} Score parts: ${rec.breakdown.join("; ")}.`;
  }
  return `${rec.rationale} Score ${rec.score}/100 — ${rec.breakdown.join("; ")}.`;
}
