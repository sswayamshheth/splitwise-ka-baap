/**
 * Turning plan items into place names the geocoder can find, and keeping only
 * matches near the trip's destination (so "Solang" never lands in Papua New Guinea).
 */

export type Place = { name: string; admin1?: string; country?: string; countryCode?: string; lat: number; lon: number };

/** Items further than this from the destination are treated as "not found". */
export const MAX_KM_FROM_DESTINATION = 100;

export function placeLabel(p: Place): string {
  return [p.name, p.admin1, p.countryCode ?? p.country].filter(Boolean).join(", ");
}

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Words that describe a kind of place rather than name one; dropped to get a findable name.
const GENERIC = /\b(valley|pass|airport|river|lake|falls|waterfall|fort|temple|beach|island|market|road|station|springs?|hills?|peak|trek|trail|park|camp|village|town|city|old|new|the)\b/gi;
const PREPOSITION = /\b(?:at|in|to|near|from|around|on|via)\s+(?:the\s+)?([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})/gu;

function clean(s: string): string {
  return s.replace(/[·|,;:()[\]]/g, " ").replace(/\s{2,}/g, " ").trim();
}

/**
 * Candidate names for an item, best first: its location, its vendor, then
 * capitalised place phrases from the title ("at Solang Valley" → "Solang Valley",
 * "Solang"). Never more than `max`.
 */
export function placeCandidates(item: { title: string; location?: string; vendor?: string }, max = 4): string[] {
  const out: string[] = [];
  const push = (raw?: string) => {
    if (!raw) return;
    const full = clean(raw);
    const short = clean(full.replace(GENERIC, " "));
    for (const name of [full, short]) {
      if (name.length >= 3 && name.length <= 60 && !out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(name);
    }
  };
  push(item.location);
  push(item.vendor);
  for (const m of item.title.matchAll(PREPOSITION)) push(m[1]);
  return out.slice(0, max);
}

/** The match nearest the destination, if it is within range. */
export function nearestWithin(candidates: Place[], destination: { lat: number; lon: number }, maxKm = MAX_KM_FROM_DESTINATION): Place | null {
  let best: Place | null = null;
  let bestKm = Infinity;
  for (const c of candidates) {
    const km = distanceKm(c, destination);
    if (km <= maxKm && km < bestKm) {
      best = c;
      bestKm = km;
    }
  }
  return best;
}

/** Distinct places by label (the geocoder can return two towns with the same name in one state). */
export function uniqueByLabel(places: Place[]): Place[] {
  const seen = new Set<string>();
  return places.filter((p) => {
    const key = placeLabel(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Which of several same-named destinations the plan is about: the one that most
 * of the itinerary's own place names sit near. Falls back to the first (the
 * geocoder's best match) when the itinerary doesn't say.
 */
export function pickDestination(candidates: Place[], itemPlaceMatches: Place[][]): Place | null {
  if (!candidates.length) return null;
  let best = candidates[0];
  let bestScore = 0;
  for (const c of candidates) {
    const score = itemPlaceMatches.filter((matches) => matches.some((m) => distanceKm(m, c) <= MAX_KM_FROM_DESTINATION)).length;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}


// Capitalised words that start a title or name a kind of thing, never a place worth looking up.
const NOT_PLACES = new Set(["day", "dinner", "lunch", "breakfast", "homestay", "hotel", "stay", "return", "flights", "flight", "local", "board-game", "river", "mall", "arrival", "departure", "check-in", "shopping", "food", "cab", "taxi", "trek", "visit", "night", "morning", "evening", "and", "or"]);

/**
 * Every capitalised name in a title ("Hadimba temple & Vashisht springs" → "Hadimba", "Vashisht"),
 * for telling same-named destinations apart. Broader than `placeCandidates`, so only used to vote.
 */
export function titlePlaceNames(title: string): string[] {
  const out: string[] = [];
  for (const m of title.matchAll(/\b[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2}/gu)) {
    const words = clean(m[0].replace(GENERIC, " ")).split(" ").filter((w) => w.length >= 4 && !NOT_PLACES.has(w.toLowerCase()));
    const name = words.join(" ");
    if (name && !out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}
