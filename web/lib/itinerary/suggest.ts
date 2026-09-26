import type { DraftItem } from "@/lib/itinerary/parse";
import type { ExpenseCategory } from "@/lib/ledger/types";

/**
 * Offline itinerary suggestions (no AI key needed): a small curated library of
 * activities per destination and interest, arranged across the trip's days.
 * Estimates are rough per-person figures × travellers, labelled as estimates
 * for the user to review — nothing is booked.
 */

export type Idea = { title: string; category: ExpenseCategory; perPerson: number; tags: string[] };

const LIBRARY: { match: RegExp; stay: string; ideas: Idea[] }[] = [
  {
    match: /goa|candolim|calangute|baga|palolem|panjim/i,
    stay: "Villa or beach resort",
    ideas: [
      { title: "Scuba or snorkelling at Grande Island", category: "Activity", perPerson: 3500, tags: ["water", "adventure"] },
      { title: "Parasailing at Calangute", category: "Activity", perPerson: 1200, tags: ["water", "adventure"] },
      { title: "Old Goa churches & Fontainhas walk", category: "Activity", perPerson: 400, tags: ["culture"] },
      { title: "Spice plantation lunch", category: "Food", perPerson: 900, tags: ["nature", "food"] },
      { title: "Dudhsagar falls jeep safari", category: "Activity", perPerson: 1800, tags: ["nature", "adventure"] },
      { title: "Sunset cruise on the Mandovi", category: "Activity", perPerson: 800, tags: ["water", "relaxing"] },
      { title: "Night market at Arpora", category: "Shopping", perPerson: 1000, tags: ["shopping", "nightlife"] },
      { title: "Beach shack seafood dinner", category: "Food", perPerson: 1200, tags: ["food"] },
      { title: "Tito's Lane evening", category: "Other", perPerson: 1500, tags: ["nightlife"] },
      { title: "Spa & pool afternoon", category: "Activity", perPerson: 1500, tags: ["relaxing"] },
    ],
  },
  {
    match: /manali|himachal|solang|kasol|shimla/i,
    stay: "Homestay in Old Manali",
    ideas: [
      { title: "Paragliding at Solang", category: "Activity", perPerson: 3000, tags: ["adventure", "mountain"] },
      { title: "Hampta or Jogini falls trek", category: "Activity", perPerson: 500, tags: ["mountain", "nature"] },
      { title: "Rohtang / Atal Tunnel snow day", category: "Local travel", perPerson: 1500, tags: ["mountain"] },
      { title: "River rafting on the Beas", category: "Activity", perPerson: 900, tags: ["water", "adventure"] },
      { title: "Hadimba temple & Vashisht springs", category: "Activity", perPerson: 200, tags: ["culture", "relaxing"] },
      { title: "Café hopping in Old Manali", category: "Food", perPerson: 800, tags: ["food", "relaxing"] },
      { title: "Mall Road shopping", category: "Shopping", perPerson: 1000, tags: ["shopping"] },
      { title: "Board-game night at the homestay", category: "Other", perPerson: 0, tags: ["indoor"] },
    ],
  },
  {
    match: /coorg|madikeri|kodagu|munnar|wayanad|ooty|chikmagalur/i,
    stay: "Plantation stay",
    ideas: [
      { title: "Coffee estate walk & tasting", category: "Activity", perPerson: 900, tags: ["nature", "food"] },
      { title: "Abbey Falls & Raja's Seat", category: "Activity", perPerson: 300, tags: ["nature", "relaxing"] },
      { title: "Dubare elephant camp", category: "Activity", perPerson: 800, tags: ["nature"] },
      { title: "Barapole river rafting", category: "Activity", perPerson: 1500, tags: ["water", "adventure"] },
      { title: "Namdroling monastery visit", category: "Activity", perPerson: 0, tags: ["culture"] },
      { title: "Local Kodava thali", category: "Food", perPerson: 600, tags: ["food"] },
    ],
  },
  {
    match: /rishikesh|haridwar|shivpuri/i,
    stay: "Riverside camp",
    ideas: [
      { title: "16 km rafting run", category: "Activity", perPerson: 1500, tags: ["water", "adventure"] },
      { title: "Bungee at Jumpin Heights", category: "Activity", perPerson: 3700, tags: ["adventure"] },
      { title: "Ganga aarti at Triveni Ghat", category: "Activity", perPerson: 0, tags: ["culture"] },
      { title: "Sunrise yoga session", category: "Activity", perPerson: 500, tags: ["relaxing"] },
      { title: "Café trail near Laxman Jhula", category: "Food", perPerson: 700, tags: ["food"] },
    ],
  },
];

const GENERIC: Idea[] = [
  { title: "Kayaking or boating session", category: "Activity", perPerson: 900, tags: ["water"] },
  { title: "Water sports combo (jet ski, banana ride)", category: "Activity", perPerson: 1500, tags: ["water", "adventure"] },
  { title: "Zipline & rope course", category: "Activity", perPerson: 1200, tags: ["adventure"] },
  { title: "Sunrise viewpoint hike", category: "Activity", perPerson: 300, tags: ["mountain", "nature"] },
  { title: "Spa & wellness afternoon", category: "Activity", perPerson: 1800, tags: ["relaxing"] },
  { title: "Bowling & arcade night", category: "Other", perPerson: 700, tags: ["indoor"] },
  { title: "Old town heritage walk", category: "Activity", perPerson: 500, tags: ["culture"] },
  { title: "Local food trail", category: "Food", perPerson: 800, tags: ["food"] },
  { title: "Nature day trip", category: "Activity", perPerson: 1200, tags: ["nature"] },
  { title: "Adventure activity slot", category: "Activity", perPerson: 2000, tags: ["adventure"] },
  { title: "Lake / beach afternoon", category: "Activity", perPerson: 600, tags: ["water", "relaxing"] },
  { title: "Evening market", category: "Shopping", perPerson: 1000, tags: ["shopping"] },
  { title: "Live music night", category: "Other", perPerson: 1200, tags: ["nightlife"] },
  { title: "Board-game café", category: "Other", perPerson: 400, tags: ["indoor"] },
];

/** Every idea we know for a destination, destination-specific first, then generic ones. */
export function ideasFor(destination: string): Idea[] {
  const lib = LIBRARY.find((l) => l.match.test(destination));
  const own = lib?.ideas ?? [];
  const seen = new Set(own.map((i) => i.title));
  return [...own, ...GENERIC.filter((g) => !seen.has(g.title))];
}

function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
function nightsBetween(a: string, b: string) {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.max(1, Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000));
}

/**
 * Suggest a plan. `interests` is how many travellers like each activity tag
 * (from their preferences); ideas matching more of the group come first.
 */
export function suggestItinerary(input: { destination: string; startDate: string; endDate: string; travellers: number; interests: Record<string, number> }): DraftItem[] {
  const lib = LIBRARY.find((l) => l.match.test(input.destination));
  const ideas = lib?.ideas ?? GENERIC;
  const nights = nightsBetween(input.startDate, input.endDate);
  const people = Math.max(1, input.travellers);
  const score = (i: Idea) => i.tags.reduce((s, t) => s + (input.interests[t] ?? 0), 0);
  const ranked = [...ideas].sort((a, b) => score(b) - score(a) || a.perPerson - b.perPerson);
  const perDay = 2;
  const picks = ranked.slice(0, Math.min(ranked.length, Math.max(2, nights * perDay)));
  const why = (i: Idea) => {
    const liked = i.tags.filter((t) => (input.interests[t] ?? 0) > 0);
    return liked.length ? `Suggested: matches ${liked.join(", ")} interests` : "Suggested: popular here";
  };
  const items: DraftItem[] = [
    {
      title: `${lib?.stay ?? "Stay"} · ${nights} night${nights === 1 ? "" : "s"}`,
      category: "Stay",
      date: input.startDate,
      endDate: input.endDate,
      estimatedPaise: 3_000_00 * nights * Math.ceil(people / 2),
      evidence: "Suggested stay (estimate: ~₹3,000 per room-night, 2 per room)",
      confidence: "medium",
    },
  ];
  picks.forEach((idea, i) => {
    items.push({
      title: idea.title,
      category: idea.category,
      date: addDays(input.startDate, Math.min(nights - 1, Math.floor(i / perDay)) + (nights > 1 ? 0 : 0)),
      estimatedPaise: idea.perPerson * 100 * people,
      evidence: `${why(idea)} · est. ₹${idea.perPerson.toLocaleString("en-IN")}/person`,
      confidence: "medium",
    });
  });
  return items;
}
