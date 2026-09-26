/**
 * Anti-hallucination check. Every rupee figure in the model's answer must
 * appear, exactly, in the output of an engine tool it called this turn.
 * Strict on purpose: a figure the model added up itself is flagged too, so
 * the only numbers shown as verified are numbers the ledger produced.
 */

export type Verification = { verified: string[]; unverified: string[] };

// ₹1,234.50 · Rs 1234 · INR 1,234 · −₹2,880 · ₹-2,880
const AMOUNT_RE = /(?:₹|\bRs\.?|\bINR)\s?[−-]?\s?(\d+(?:,\d+)*(?:\.\d{1,2})?)/g;

function toPaise(digits: string): number | null {
  const clean = digits.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [r, f = ""] = clean.split(".");
  return Number(r) * 100 + Number((f + "00").slice(0, 2));
}

/** Every rupee amount written in a piece of text, as absolute paise. */
export function extractAmounts(text: string): { raw: string; paise: number }[] {
  const out: { raw: string; paise: number }[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const paise = toPaise(m[1]);
    if (paise !== null) out.push({ raw: m[0].trim(), paise });
  }
  return out;
}

/** Collects every amount a tool output contains: ₹ strings and *paise fields. */
export function amountsInToolOutput(value: unknown, into = new Set<number>()): Set<number> {
  if (typeof value === "string") {
    for (const a of extractAmounts(value)) into.add(a.paise);
  } else if (Array.isArray(value)) {
    for (const v of value) amountsInToolOutput(v, into);
  } else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "number" && /paise$/i.test(key) && Number.isFinite(v)) into.add(Math.abs(Math.round(v)));
      else amountsInToolOutput(v, into);
    }
  }
  return into;
}

export function verifyAnswer(text: string, toolOutputs: unknown[]): Verification {
  const allowed = new Set<number>();
  for (const o of toolOutputs) amountsInToolOutput(o, allowed);
  const verified: string[] = [];
  const unverified: string[] = [];
  for (const a of extractAmounts(text)) (allowed.has(a.paise) ? verified : unverified).push(a.raw);
  return { verified, unverified };
}
