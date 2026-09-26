/**
 * Travel preferences and the trip Harmony Score.
 *
 * Preferences are optional (asked after sign-up, editable in Profile) and are
 * synced onto the member in each trip. The Harmony Score is deterministic:
 * how similar the group's tastes are (activities, food, pace) blended with how
 * well the itinerary fits each person. Everything it says — shared interests,
 * conflicts, per-person variations — is derived from those inputs, so it can
 * always be explained.
 */

export type Diet = "veg" | "jain" | "eggetarian" | "non-veg" | "vegan";
export type Pace = "relaxed" | "balanced" | "packed";

export type Interests = {
  diet?: Diet;
  cuisines: string[];
  activities: string[];
  pace?: Pace;
};

export const DIETS: { id: Diet; label: string }[] = [
  { id: "veg", label: "Vegetarian" },
  { id: "jain", label: "Jain" },
  { id: "eggetarian", label: "Eggetarian" },
  { id: "vegan", label: "Vegan" },
  { id: "non-veg", label: "Non-vegetarian" },
];

export const CUISINES = ["North Indian", "South Indian", "Gujarati", "Chinese", "Continental", "Seafood", "Street food", "Cafés & bakeries", "Local specialties"];

export const ACTIVITIES: { id: string; label: string; icon: string; hint: string }[] = [
  { id: "water", label: "Water & beaches", icon: "sailing", hint: "Scuba, rafting, kayaking, beach days" },
  { id: "mountain", label: "Mountains & treks", icon: "landscape", hint: "Hikes, snow, viewpoints" },
  { id: "adventure", label: "Adventure sports", icon: "paragliding", hint: "Paragliding, bungee, ATVs" },
  { id: "nature", label: "Nature & wildlife", icon: "forest", hint: "Safaris, waterfalls, plantations" },
  { id: "culture", label: "Culture & heritage", icon: "temple_hindu", hint: "Forts, temples, museums" },
  { id: "food", label: "Food trails", icon: "restaurant", hint: "Street food, cafés, local kitchens" },
  { id: "nightlife", label: "Nightlife", icon: "nightlife", hint: "Clubs, bars, live music" },
  { id: "relaxing", label: "Slow & relaxing", icon: "spa", hint: "Spa, pool, lazy mornings" },
  { id: "indoor", label: "Indoor games", icon: "sports_esports", hint: "Board games, bowling, arcades" },
  { id: "shopping", label: "Shopping", icon: "shopping_bag", hint: "Markets, malls, souvenirs" },
];

export const PACES: { id: Pace; label: string }[] = [
  { id: "relaxed", label: "Relaxed" },
  { id: "balanced", label: "Balanced" },
  { id: "packed", label: "Packed" },
];

export function isEmpty(i: Interests | undefined): boolean {
  return !i || (!i.diet && !i.pace && i.cuisines.length === 0 && i.activities.length === 0);
}

export function normaliseInterests(raw: unknown): Interests | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const diet = DIETS.some((d) => d.id === r.diet) ? (r.diet as Diet) : undefined;
  const pace = PACES.some((p) => p.id === r.pace) ? (r.pace as Pace) : undefined;
  const cuisines = Array.isArray(r.cuisines) ? [...new Set(r.cuisines.filter((c): c is string => typeof c === "string" && CUISINES.includes(c)))] : [];
  const activities = Array.isArray(r.activities) ? [...new Set(r.activities.filter((a): a is string => typeof a === "string" && ACTIVITIES.some((x) => x.id === a)))] : [];
  const out: Interests = { diet, pace, cuisines, activities };
  return isEmpty(out) ? undefined : out;
}

// ------------------------------------------------------------------ item tagging

const TAG_RULES: [RegExp, string][] = [
  [/scuba|snorkel|raft|kayak|cruise|beach|surf|jet ?ski|parasail|boat|swim|island/i, "water"],
  [/trek|hike|hiking|mountain|peak|snow|summit|rohtang|solang|glacier|valley view/i, "mountain"],
  [/paraglid|bungee|zip ?line|atv|quad|sky ?div|climb|rappel|jeep safari/i, "adventure"],
  [/safari|waterfall|falls|wildlife|plantation|estate|forest|bird|national park|dudhsagar/i, "nature"],
  [/temple|fort|museum|heritage|church|palace|monastery|aarti|old town|walk/i, "culture"],
  [/club|bar|pub|party|night|live music|brewery/i, "nightlife"],
  [/spa|yoga|wellness|massage|pool day|sunset/i, "relaxing"],
  [/bowling|arcade|board game|escape room|game|gaming|snooker/i, "indoor"],
  [/market|mall|shopping|bazaar|souvenir/i, "shopping"],
  [/dinner|lunch|breakfast|food|cafe|café|restaurant|shack|thali|street food|meal/i, "food"],
];

/** Activity tags an itinerary item appeals to, from its title and category. */
export function itemTags(item: { title: string; category: string; vendor?: string }): string[] {
  const text = `${item.title} ${item.vendor ?? ""}`;
  const tags = new Set(TAG_RULES.filter(([re]) => re.test(text)).map(([, t]) => t));
  if (item.category === "Food") tags.add("food");
  if (item.category === "Shopping") tags.add("shopping");
  return [...tags];
}

/** Only items people *choose to enjoy* count for fit — not flights, stays or cabs. */
function isExperience(item: { category: string; title: string; vendor?: string }) {
  return item.category === "Activity" || item.category === "Food" || item.category === "Shopping" || itemTags(item).length > 0;
}

// ------------------------------------------------------------------ similarity

function jaccard(a: string[], b: string[]): number | null {
  if (a.length === 0 || b.length === 0) return null;
  const A = new Set(a);
  const inter = b.filter((x) => A.has(x)).length;
  return inter / new Set([...a, ...b]).size;
}

const DIET_RANK: Record<Diet, number> = { vegan: 0, jain: 0, veg: 1, eggetarian: 2, "non-veg": 3 };
/** 1 = same table works for both; lower = the group has to plan around it. */
function dietCompat(a?: Diet, b?: Diet): number | null {
  if (!a || !b) return null;
  if (a === b) return 1;
  if ((a === "jain" && b === "vegan") || (a === "vegan" && b === "jain")) return 0.7;
  const gap = Math.abs(DIET_RANK[a] - DIET_RANK[b]);
  return gap === 1 ? 0.85 : gap === 2 ? 0.7 : 0.55;
}

function paceCompat(a?: Pace, b?: Pace): number | null {
  if (!a || !b) return null;
  if (a === b) return 1;
  return a === "balanced" || b === "balanced" ? 0.65 : 0.25;
}

function pairScore(a: Interests, b: Interests): number | null {
  const parts: [number | null, number][] = [
    [jaccard(a.activities, b.activities), 0.5],
    [dietCompat(a.diet, b.diet), 0.2],
    [paceCompat(a.pace, b.pace), 0.15],
    [jaccard(a.cuisines, b.cuisines), 0.15],
  ];
  const known = parts.filter(([v]) => v !== null) as [number, number][];
  if (!known.length) return null;
  const w = known.reduce((s, [, wt]) => s + wt, 0);
  return known.reduce((s, [v, wt]) => s + v * wt, 0) / w;
}

// ------------------------------------------------------------------ harmony

export type HarmonyMember = { id: string; name: string; interests?: Interests };
export type HarmonyItem = { id: string; title: string; category: string; vendor?: string; participantIds: string[] };

export type Variation = { itemId: string; itemTitle: string; reason: string; suggestion: string };

export type Harmony = {
  /** 0–100, null when fewer than two members have shared preferences. */
  score: number | null;
  label: "Great harmony" | "Good harmony" | "Mixed tastes" | "Low harmony" | "Not enough preferences";
  /** Members with preferences / all active members. */
  coverage: { withPrefs: number; total: number };
  groupSimilarity: number | null;
  itineraryFit: number | null;
  sharedInterests: { id: string; label: string; count: number }[];
  conflicts: string[];
  perMember: { id: string; name: string; fit: number | null; hasPrefs: boolean; variations: Variation[] }[];
};

const ALTERNATIVE: Record<string, string> = {
  water: "a beach morning or a sunset cruise",
  mountain: "a short viewpoint hike",
  adventure: "a zipline or ATV slot nearby",
  nature: "a waterfall or plantation visit",
  culture: "a heritage walk or temple visit",
  food: "a local food trail",
  nightlife: "an evening at a live-music café",
  relaxing: "a spa or pool afternoon",
  indoor: "a board-game café or bowling",
  shopping: "time at the local market",
};

const labelOf = (id: string) => ACTIVITIES.find((a) => a.id === id)?.label ?? id;

export function computeHarmony(members: HarmonyMember[], items: HarmonyItem[]): Harmony {
  const withPrefs = members.filter((m) => !isEmpty(m.interests));
  const experiences = items.filter(isExperience);

  // Group similarity: mean over all pairs that share at least one comparable dimension.
  const pairs: number[] = [];
  for (let i = 0; i < withPrefs.length; i++) {
    for (let j = i + 1; j < withPrefs.length; j++) {
      const s = pairScore(withPrefs[i].interests!, withPrefs[j].interests!);
      if (s !== null) pairs.push(s);
    }
  }
  const groupSimilarity = pairs.length ? pairs.reduce((a, b) => a + b, 0) / pairs.length : null;

  // Itinerary fit per member: share of their experiences that match something they like.
  const perMember = members.map((m) => {
    const mine = experiences.filter((it) => it.participantIds.includes(m.id));
    const likes = new Set(m.interests?.activities ?? []);
    const hasPrefs = !isEmpty(m.interests);
    let fit: number | null = null;
    const variations: Variation[] = [];
    if (hasPrefs && likes.size && mine.length) {
      let hits = 0;
      for (const it of mine) {
        const tags = itemTags(it);
        if (tags.some((t) => likes.has(t))) hits++;
        else if (tags.length) {
          const pick = [...likes][0];
          variations.push({
            itemId: it.id,
            itemTitle: it.title,
            reason: `${labelOf(tags[0])} isn't on ${m.name.split(" ")[0]}'s list`,
            suggestion: `Swap in ${ALTERNATIVE[pick] ?? "something they enjoy"} (${labelOf(pick).toLowerCase()})`,
          });
        }
      }
      fit = hits / mine.length;
    }
    return { id: m.id, name: m.name, fit, hasPrefs, variations: variations.slice(0, 3) };
  });
  const fits = perMember.map((p) => p.fit).filter((f): f is number => f !== null);
  const itineraryFit = fits.length ? fits.reduce((a, b) => a + b, 0) / fits.length : null;

  let score: number | null = null;
  if (groupSimilarity !== null && itineraryFit !== null) score = Math.round(100 * (0.6 * groupSimilarity + 0.4 * itineraryFit));
  else if (groupSimilarity !== null) score = Math.round(100 * groupSimilarity);
  else if (itineraryFit !== null && withPrefs.length >= 1) score = Math.round(100 * itineraryFit);
  if (withPrefs.length < 2 && itineraryFit === null) score = null;

  const counts = new Map<string, number>();
  for (const m of withPrefs) for (const a of m.interests!.activities) counts.set(a, (counts.get(a) ?? 0) + 1);
  const sharedInterests = [...counts.entries()]
    .filter(([, c]) => c >= Math.max(2, Math.ceil(withPrefs.length / 2)))
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, label: labelOf(id), count }));

  const conflicts: string[] = [];
  const diets = withPrefs.map((m) => m.interests!.diet).filter((d): d is Diet => !!d);
  const strict = diets.filter((d) => d === "jain" || d === "vegan" || d === "veg").length;
  if (strict && diets.includes("non-veg")) {
    conflicts.push(`${strict} ${strict === 1 ? "person eats" : "people eat"} veg/Jain/vegan and others don't — pick restaurants with a proper veg kitchen`);
  }
  const paces = new Set(withPrefs.map((m) => m.interests!.pace).filter(Boolean));
  if (paces.has("relaxed") && paces.has("packed")) conflicts.push("Some want a relaxed trip and some a packed one — keep afternoons optional");
  const noShared = withPrefs.length >= 2 && sharedInterests.length === 0;
  if (noShared) conflicts.push("No activity type is shared by most of the group — plan a split afternoon");

  const label: Harmony["label"] =
    score === null ? "Not enough preferences" : score >= 75 ? "Great harmony" : score >= 55 ? "Good harmony" : score >= 35 ? "Mixed tastes" : "Low harmony";

  return { score, label, coverage: { withPrefs: withPrefs.length, total: members.length }, groupSimilarity, itineraryFit, sharedInterests, conflicts, perMember };
}
