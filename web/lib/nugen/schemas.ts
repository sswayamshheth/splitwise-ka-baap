import { validateScenario, type Scenario } from "@/lib/twin/scenario";
import type { TripState } from "@/lib/ledger/types";

/**
 * Structured-output contracts for GroupTrip Intelligence. The model's text is
 * never trusted: it must parse as JSON, match the shape, and every id it
 * mentions must exist in the data we gave it. Anything else is rejected and
 * the deterministic engine's answer is used instead.
 */

export type Validated<T> = { ok: true; value: T; repaired: string[] } | { ok: false; error: string };

/** Pulls the first JSON object out of model text (models sometimes wrap it in prose or ```json fences). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  if (start < 0) throw new Error("No JSON object in the response");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(body.slice(start, i + 1));
  }
  throw new Error("Unterminated JSON object in the response");
}

// ---------------------------------------------------------------- B: weather adaptation

export type AdaptationPick = { itemId: string; candidateId: string; reason: string };
export type Shortlist = Record<string, string[]>;

export function validateAdaptation(raw: unknown, shortlist: Shortlist): Validated<AdaptationPick[]> {
  const picks = (raw as { picks?: unknown } | null)?.picks;
  if (!Array.isArray(picks)) return { ok: false, error: "Expected {\"picks\": [...]}" };
  const repaired: string[] = [];
  const out: AdaptationPick[] = [];
  const seen = new Set<string>();
  for (const p of picks as Record<string, unknown>[]) {
    const itemId = typeof p?.itemId === "string" ? p.itemId : "";
    const candidateId = typeof p?.candidateId === "string" ? p.candidateId : "";
    if (!shortlist[itemId]) {
      repaired.push(`dropped pick for unknown item "${itemId}"`);
      continue;
    }
    if (!shortlist[itemId].includes(candidateId)) {
      repaired.push(`dropped pick "${candidateId}" — not in ${itemId}'s shortlist`);
      continue;
    }
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    out.push({ itemId, candidateId, reason: typeof p.reason === "string" ? p.reason.slice(0, 300) : "" });
  }
  if (!out.length) return { ok: false, error: repaired.join("; ") || "No valid picks" };
  return { ok: true, value: out, repaired };
}

// ---------------------------------------------------------------- C: What-If language → scenario

export function validateScenarioOutput(raw: unknown, state: TripState): Validated<Scenario> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Expected a scenario object" };
  const r = raw as Record<string, unknown>;
  const s = (r.scenario && typeof r.scenario === "object" ? r.scenario : r) as Record<string, unknown>;
  const { scenario, warnings } = validateScenario(s, state);
  const meaningful = scenario.rainfallMm !== undefined || scenario.temperatureC !== undefined || scenario.windKmh !== undefined || !!scenario.stormExtraHours || scenario.unavailableItemIds.length > 0 || scenario.skippingParticipantIds.length > 0 || scenario.hotelRemoved;
  if (!meaningful) return { ok: false, error: `Scenario has no usable change${warnings.length ? ` (${warnings.join("; ")})` : ""}` };
  return { ok: true, value: scenario, repaired: warnings };
}

// ---------------------------------------------------------------- D: grounded explanation

export type Explanation = { answer: string; citedFacts: string[] };

/** Every number in the answer must appear in the facts we supplied — the model may not invent figures. */
export function ungroundedNumbers(answer: string, facts: string): string[] {
  const norm = (s: string) => s.replace(/,/g, "");
  const factNums = new Set((norm(facts).match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n))));
  const found = norm(answer).match(/\d+(?:\.\d+)?/g) ?? [];
  return [...new Set(found.filter((n) => !factNums.has(String(Number(n)))))].filter((n) => Number(n) > 10 || n.includes("."));
}

export function validateExplanation(raw: unknown, facts: string): Validated<Explanation> {
  const r = raw as Record<string, unknown> | null;
  const answer = typeof r?.answer === "string" ? r.answer.trim() : "";
  if (answer.length < 10) return { ok: false, error: "Explanation is empty" };
  const bad = ungroundedNumbers(answer, facts);
  if (bad.length) return { ok: false, error: `Explanation used numbers not in the data: ${bad.slice(0, 5).join(", ")}` };
  const cited = Array.isArray(r?.citedFacts) ? (r!.citedFacts as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 8) : [];
  return { ok: true, value: { answer: answer.slice(0, 1200), citedFacts: cited }, repaired: [] };
}
