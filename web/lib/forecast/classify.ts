import type { ExpenseCategory } from "@/lib/ledger/types";

/**
 * Whether weather matters for a plan item, decided by simple keyword rules in
 * code (no AI). Outdoor wins when both kinds of word appear ("dinner cruise",
 * "trek then spa"), because that is the part the weather can ruin.
 */

export type Exposure = "outdoor" | "indoor" | "unknown";

const OUTDOOR = [
  "beach", "trek", "trekking", "hike", "hiking", "trail", "rafting", "raft", "boat", "boating", "cruise", "kayak", "kayaking",
  "canoe", "paragliding", "parasailing", "scuba", "snorkel", "snorkelling", "snorkeling", "surf", "surfing", "jet ski", "water sports",
  "safari", "camping", "camp", "zipline", "zip line", "bungee", "waterfall", "falls", "viewpoint", "sunset", "sunrise", "picnic",
  "cycling", "bike ride", "ski", "skiing", "snow", "sightseeing", "fort", "garden", "park", "island", "lake", "river", "pass",
  "hot spring", "springs", "stargazing", "bonfire", "walk", "walking tour", "jeep", "climbing", "rappelling", "fishing",
];

const INDOOR = [
  "museum", "mall", "spa", "restaurant", "cafe", "café", "cafes", "café hopping", "dinner", "lunch", "breakfast", "brunch", "bar", "pub",
  "club", "nightclub", "cinema", "movie", "gallery", "aquarium", "casino", "cooking class", "workshop", "shopping", "bowling",
  "escape room", "theatre", "theater", "hotel", "homestay", "resort", "villa", "hostel", "massage", "library", "planetarium",
];

const CATEGORY_DEFAULT: Record<ExpenseCategory, Exposure> = {
  Stay: "indoor",
  Food: "indoor",
  Shopping: "indoor",
  Transport: "unknown",
  "Local travel": "unknown",
  Activity: "unknown",
  Other: "unknown",
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (words: string[]) => new RegExp(`(?:^|[^\\p{L}])(?:${words.map(escape).join("|")})(?=$|[^\\p{L}])`, "iu");
const OUTDOOR_RE = wordRe(OUTDOOR);
const INDOOR_RE = wordRe(INDOOR);

export function classifyItem(item: { title: string; category: ExpenseCategory | string; location?: string; vendor?: string }): Exposure {
  const text = [item.title, item.location, item.vendor].filter(Boolean).join(" · ");
  if (OUTDOOR_RE.test(text)) return "outdoor";
  if (INDOOR_RE.test(text)) return "indoor";
  return CATEGORY_DEFAULT[item.category as ExpenseCategory] ?? "unknown";
}
