import { toIso } from "@/lib/dates";
import { parseAmount, type Paise } from "@/lib/money";
import type { ExpenseCategory } from "@/lib/ledger/types";

/**
 * Turns the text of an itinerary — from a PDF's text layer, a pasted email,
 * or a .txt file — into structured draft items.
 *
 * Everything here is deterministic pattern matching, never a language model:
 * a judge (or an accountant) can point at any extracted number and see the
 * line it came from. Nothing is committed without the user reviewing it.
 */

export type DraftItem = {
  title: string;
  category: ExpenseCategory;
  date?: string;
  endDate?: string;
  vendor?: string;
  location?: string;
  estimatedPaise: Paise;
  /** The source line, shown in the review screen so the user can check it. */
  evidence: string;
  confidence: "high" | "medium" | "low";
};

export type ParsedItinerary = {
  destination?: string;
  startDate?: string;
  endDate?: string;
  travellers?: number;
  items: DraftItem[];
  /** Lines with money we could not confidently classify. */
  unmatched: string[];
  textLength: number;
};

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4,
  jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const CATEGORY_RULES: { category: ExpenseCategory; words: string[] }[] = [
  { category: "Stay", words: ["hotel", "homestay", "resort", "stay", "lodge", "villa", "cottage", "hostel", "guest house", "guesthouse", "accommodation", "room", "night", "check-in", "airbnb"] },
  { category: "Transport", words: ["flight", "airline", "indigo", "vistara", "air india", "train", "railway", "irctc", "bus", "volvo", "coach", "ferry", "transfer", "airport"] },
  { category: "Local travel", words: ["taxi", "cab", "auto", "rickshaw", "local travel", "car rental", "self drive", "scooter", "bike rental", "uber", "ola"] },
  { category: "Activity", words: ["trek", "trekking", "rafting", "paragliding", "safari", "tour", "sightseeing", "ticket", "entry", "adventure", "skiing", "diving", "cruise", "activity", "excursion", "zipline"] },
  { category: "Food", words: ["meal", "meals", "breakfast", "lunch", "dinner", "food", "restaurant", "cafe", "buffet"] },
  { category: "Shopping", words: ["shopping", "souvenir", "market", "gift"] },
];

/**
 * Whole-word keyword match. Substring matching is wrong here: "Solang"
 * contains "ola", "breakfast" contains "fast", and a single false hit sends
 * the whole line into the wrong category.
 */
function hasWord(haystack: string, word: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(word, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : haystack[at - 1];
    const after = haystack[at + word.length] ?? "";
    const isLetter = (c: string) => c >= "a" && c <= "z";
    if (!isLetter(before) && !isLetter(after)) return true;
    from = at + 1;
  }
}

function matchCategory(text: string): ExpenseCategory | null {
  const lower = text.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.words.some((w) => hasWord(lower, w))) return rule.category;
  }
  return null;
}

/**
 * The line's own words decide the category. The line above is only consulted
 * when the line itself says nothing — a price under a heading, say.
 */
function categoryOf(ownLine: string, contextLine = ""): { category: ExpenseCategory; confident: boolean } {
  const own = matchCategory(ownLine);
  if (own) return { category: own, confident: true };
  const fromContext = contextLine ? matchCategory(contextLine) : null;
  if (fromContext) return { category: fromContext, confident: true };
  return { category: "Other", confident: false };
}

/** ₹12,000 / Rs. 12000 / INR 12,000 / 12,000/- — returns paise. */
function findAmount(line: string): Paise | null {
  const patterns = [
    /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i,
    /([\d,]+(?:\.\d{1,2})?)\s*\/-/,
    /([\d,]+(?:\.\d{1,2})?)\s*(?:rupees|rs\b)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(line);
    if (!m) continue;
    const parsed = parseAmount(m[1]);
    if (parsed.paise !== undefined && parsed.paise > 0) return parsed.paise;
  }
  return null;
}

function makeDate(year: number, month: number, day: number): string | undefined {
  if (month < 0 || month > 11 || day < 1 || day > 31) return undefined;
  const d = new Date(year, month, day);
  if (d.getMonth() !== month || d.getDate() !== day) return undefined;
  return toIso(d);
}

/** Finds one date, or a range like "12–16 December 2026" / "12 Dec - 16 Dec". */
export function findDates(text: string, fallbackYear = new Date().getFullYear()): { start?: string; end?: string } {
  const monthNames = Object.keys(MONTHS).join("|");

  // 12–16 December 2026
  const range = new RegExp(`\\b(\\d{1,2})\\s*(?:-|–|—|to)\\s*(\\d{1,2})\\s+(${monthNames})\\.?\\s*(\\d{4})?`, "i").exec(text);
  if (range) {
    const month = MONTHS[range[3].toLowerCase()];
    const year = range[4] ? Number(range[4]) : fallbackYear;
    return { start: makeDate(year, month, Number(range[1])), end: makeDate(year, month, Number(range[2])) };
  }
  // 12 Dec 2026 - 16 Dec 2026
  const twoDates = new RegExp(
    `\\b(\\d{1,2})\\s+(${monthNames})\\.?\\s*(\\d{4})?\\s*(?:-|–|—|to)\\s*(\\d{1,2})\\s+(${monthNames})\\.?\\s*(\\d{4})?`,
    "i",
  ).exec(text);
  if (twoDates) {
    const y1 = twoDates[3] ? Number(twoDates[3]) : fallbackYear;
    const y2 = twoDates[6] ? Number(twoDates[6]) : y1;
    return {
      start: makeDate(y1, MONTHS[twoDates[2].toLowerCase()], Number(twoDates[1])),
      end: makeDate(y2, MONTHS[twoDates[5].toLowerCase()], Number(twoDates[4])),
    };
  }
  // ISO or dd/mm/yyyy range
  const numeric = /\b(\d{4})-(\d{2})-(\d{2})\b(?:\s*(?:-|–|—|to)\s*\b(\d{4})-(\d{2})-(\d{2})\b)?/.exec(text);
  if (numeric) {
    return {
      start: makeDate(Number(numeric[1]), Number(numeric[2]) - 1, Number(numeric[3])),
      end: numeric[4] ? makeDate(Number(numeric[4]), Number(numeric[5]) - 1, Number(numeric[6])) : undefined,
    };
  }
  const slash = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b(?:\s*(?:-|–|—|to)\s*\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b)?/.exec(text);
  if (slash) {
    return {
      start: makeDate(Number(slash[3]), Number(slash[2]) - 1, Number(slash[1])),
      end: slash[4] ? makeDate(Number(slash[6]), Number(slash[5]) - 1, Number(slash[4])) : undefined,
    };
  }
  // Single "12 December 2026"
  const single = new RegExp(`\\b(\\d{1,2})\\s+(${monthNames})\\.?\\s*(\\d{4})?`, "i").exec(text);
  if (single) {
    return { start: makeDate(single[3] ? Number(single[3]) : fallbackYear, MONTHS[single[2].toLowerCase()], Number(single[1])) };
  }
  return {};
}

function findDestination(lines: string[]): string | undefined {
  for (const line of lines) {
    const m = /(?:destination|trip to|travelling to|traveling to|visit(?:ing)?)\s*[:\-–]?\s*(.{2,60})/i.exec(line);
    if (m) return m[1].replace(/[.,;]+$/, "").trim();
  }
  // "Manali Trip" / "Goa Itinerary" in the first few lines.
  for (const line of lines.slice(0, 8)) {
    const m = /^(.{2,40}?)\s+(?:trip|itinerary|tour|holiday|getaway)\b/i.exec(line.trim());
    if (m) return m[1].trim();
  }
  return undefined;
}

function findTravellers(text: string): number | undefined {
  const m = /(\d{1,2})\s*(?:travellers|travelers|pax|people|persons|adults|guests|members)/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 && n <= 60 ? n : undefined;
}

/** Strips leading bullets, indices and separators from an extracted title. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/(?:₹|rs\.?|inr)\s*[\d,]+(?:\.\d{1,2})?/gi, "")
    .replace(/[\d,]+(?:\.\d{1,2})?\s*\/-/g, "")
    .replace(/^[\s•\-–—*·>|]+/, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/[\s:;,\-–—|]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const NOISE = /^(total|subtotal|grand total|amount|gst|tax|taxes|discount|advance|balance|per person|inclusive|exclusive|terms|conditions|note|notes|page \d+)/i;

/**
 * Parses itinerary text into draft items. Each item keeps the source line so
 * the review screen can show where the number came from.
 */
export function parseItineraryText(text: string, opts: { fallbackYear?: number } = {}): ParsedItinerary {
  const normalised = text.replace(/\r\n?/g, "\n").replace(/ /g, " ");
  const lines = normalised
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const joined = lines.join("\n");
  const tripDates = findDates(joined, opts.fallbackYear);
  const fallbackYear = opts.fallbackYear ?? (tripDates.start ? Number(tripDates.start.slice(0, 4)) : new Date().getFullYear());

  const items: DraftItem[] = [];
  const unmatched: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const amount = findAmount(line);
    if (amount === null) continue;
    if (NOISE.test(line.trim())) continue;

    // Title: this line without the money, else the previous non-empty line.
    let title = cleanTitle(line);
    let evidenceLine = line;
    if (title.length < 3 && index > 0) {
      const prev = cleanTitle(lines[index - 1]);
      if (prev.length >= 3 && !NOISE.test(prev)) {
        title = prev;
        evidenceLine = `${lines[index - 1]} · ${line}`;
      }
    }
    if (title.length < 3) {
      unmatched.push(line);
      continue;
    }

    const context = `${lines[index - 1] ?? ""} ${line}`;
    const { category, confident } = categoryOf(line, lines[index - 1] ?? "");
    const dates = findDates(context, fallbackYear);
    const vendorMatch = /(?:at|with|by|vendor|operator|hotel)\s*[:\-–]?\s*([A-Z][\w'&.\- ]{2,40})/.exec(title);

    items.push({
      title: title.slice(0, 80),
      category,
      date: dates.start ?? tripDates.start,
      endDate: category === "Stay" ? (dates.end ?? undefined) : undefined,
      vendor: vendorMatch ? vendorMatch[1].trim() : undefined,
      estimatedPaise: amount,
      evidence: evidenceLine.slice(0, 160),
      confidence: confident && dates.start ? "high" : confident ? "medium" : "low",
    });
  }

  return {
    destination: findDestination(lines),
    startDate: tripDates.start,
    endDate: tripDates.end,
    travellers: findTravellers(joined),
    items,
    unmatched,
    textLength: normalised.trim().length,
  };
}

/** A realistic sample itinerary, used by the "try a sample" button in the import flow. */
export const SAMPLE_ITINERARY_TEXT = `Manali Trip — Itinerary
Destination: Manali, Himachal Pradesh
12 - 16 December 2026
6 travellers

Day 1
Volvo bus Delhi to Manali (HRTC)   Rs 21,600
Airport transfer taxi              Rs 3,200

Day 2
Homestay Old Manali - 4 nights     Rs 62,000
Breakfast and dinner package       Rs 18,000

Day 3
Paragliding at Solang Valley       Rs 18,000
Local cab for sightseeing          Rs 7,200

Day 4
River rafting on the Beas          Rs 9,600
Rohtang permits and entry          Rs 2,400

Day 5
Return Volvo bus to Delhi          Rs 21,600

Total                              Rs 1,63,600`;
