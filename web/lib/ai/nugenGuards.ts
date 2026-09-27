/**
 * Checks applied to anything NuGen writes before a user sees it. NuGen may only
 * reword what code already decided: it can't introduce a number, can't add
 * alerts or ideas, and anything that fails a check is dropped in favour of the
 * code's own text.
 */

/** Every number in a text, normalised ("₹1,275" → "1275", "8.5" → "8.5"). */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/,/g, "").replace(/\.0+$/, "");
    out.add(n);
  }
  return out;
}

/** True when `candidate` uses no number that isn't already in `source`. */
export function introducesNoNumbers(candidate: string, source: string): boolean {
  const allowed = numbersIn(source);
  for (const n of numbersIn(candidate)) if (!allowed.has(n)) return false;
  return true;
}

/** True when every number in `source` is still in `candidate` (nothing was dropped). */
export function keepsAllNumbers(candidate: string, source: string): boolean {
  const kept = numbersIn(candidate);
  for (const n of numbersIn(source)) if (!kept.has(n)) return false;
  return true;
}

/** Cleans a model reply down to plain text of bounded length. */
export function cleanReply(text: string, max = 700): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#>`]/g, "")
    .replace(/\s+\n/g, "\n")
    .trim()
    .slice(0, max);
}

/** First line of a reply, unquoted — for "rewrite this request as one planner command". */
export function extractCommand(text: string): string {
  const line = cleanReply(text, 300).split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.replace(/^(?:command|instruction)\s*:\s*/i, "").replace(/^["'“”‘’]+|["'“”‘’.]+$/g, "").trim().slice(0, 200);
}

export type WeatherNoteInput = {
  days: { date: string; alerts: { label: string; reason: string }[]; atRisk: { itemId: string; title: string; reasons: string[] }[]; alternatives: string[] }[];
};

export type WeatherNotes = {
  /** One friendly line per at-risk item id. */
  notes: Record<string, string>;
  /** Per date: the code-provided alternatives, reordered (a subset in a new order; never new ones). */
  order: Record<string, string[]>;
};

/**
 * Keeps only what's allowed from NuGen's JSON: notes for known at-risk items
 * that add no numbers beyond that item's code-decided reasons, and orderings
 * made only of the code's own alternatives.
 */
export function sanitizeWeatherNotes(raw: unknown, input: WeatherNoteInput): WeatherNotes {
  const out: WeatherNotes = { notes: {}, order: {} };
  const r = (raw ?? {}) as { notes?: Record<string, unknown>; order?: Record<string, unknown> };
  const risks = new Map(input.days.flatMap((d) => d.atRisk.map((a) => [a.itemId, a] as const)));
  for (const [itemId, note] of Object.entries(r.notes ?? {})) {
    const risk = risks.get(itemId);
    if (!risk || typeof note !== "string") continue;
    const line = cleanReply(note, 200).split("\n")[0];
    if (line.length < 8) continue;
    if (!introducesNoNumbers(line, `${risk.title} ${risk.reasons.join(" ")}`)) continue;
    out.notes[itemId] = line;
  }
  for (const day of input.days) {
    const proposed = r.order?.[day.date];
    if (!Array.isArray(proposed)) continue;
    const allowed = new Set(day.alternatives);
    const picked = [...new Set(proposed.filter((t): t is string => typeof t === "string" && allowed.has(t)))];
    if (picked.length) out.order[day.date] = [...picked, ...day.alternatives.filter((t) => !picked.includes(t))];
  }
  return out;
}

/** Pulls the first JSON object out of a reply (models sometimes wrap it in prose or code fences). */
export function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
