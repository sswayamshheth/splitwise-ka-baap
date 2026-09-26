import { LANDSCAPES, PORTRAITS } from "./design-photos";

/**
 * Picks design photography for trips and people. Deterministic: the same trip
 * or name always gets the same image, so screens don't reshuffle.
 */

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

const KEYWORDS: [RegExp, string][] = [
  [/goa|beach|coast|palolem|candolim|gokarna|andaman|kerala|pondicherry|varkala|sea/i, "beach"],
  [/bali|ubud|terrace/i, "terraces"],
  [/manali|himachal|ladakh|leh|shimla|munnar|coorg|darjeeling|ooty|kashmir|sikkim|mountain|hill/i, "mountain"],
  [/dandeli|river|rishikesh|rafting|kali/i, "river"],
  [/forest|jungle|ghats|wayanad|safari/i, "rainforest"],
];

/** A cover photo for a trip, chosen from its destination (falls back by id). */
export function tripCover(destination: string, seed = destination): string {
  const tag = KEYWORDS.find(([re]) => re.test(destination))?.[1];
  const pool = tag ? LANDSCAPES.filter((l) => l.tags.includes(tag)) : [];
  const from = pool.length ? pool : LANDSCAPES.filter((l) => !l.tags.includes("food"));
  return from[hash(seed) % from.length].url;
}

/** A photo for a booking/item card by its category. */
export function categoryPhoto(category: string, seed: string): string {
  const tag = category === "Stay" ? "stay" : category === "Food" ? "food" : category === "Activity" ? "river" : "rainforest";
  const pool = LANDSCAPES.filter((l) => l.tags.includes(tag));
  const from = pool.length ? pool : LANDSCAPES;
  return from[hash(seed) % from.length].url;
}

/** A portrait for a trip member, stable per name. */
export function portrait(name: string): string {
  return PORTRAITS[hash(name.trim().toLowerCase()) % PORTRAITS.length];
}
