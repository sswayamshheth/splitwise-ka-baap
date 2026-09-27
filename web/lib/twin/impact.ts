import { itemTags } from "@/lib/interests";
import type { ItineraryItem } from "@/lib/ledger/types";
import { describeWeatherCode, isThunder, type WeatherDay, type WeatherHour } from "@/lib/weather/openmeteo";

/**
 * Deterministic weather → activity impact. Each itinerary item gets a
 * sensitivity profile from what it is (sea, river, trek, two-wheeler, flight,
 * indoor…); the profile's thresholds turn real (or simulated) conditions into
 * a hazard, a suitability, an availability and an impact score with the
 * reasons that produced it. Rain thresholds follow IMD's daily categories
 * (light < 15.6 mm, moderate < 64.5, heavy < 115.6, very heavy < 204.5) and
 * standard hourly intensity bands (moderate ≥ 2.5 mm/h, heavy ≥ 7.6 mm/h).
 */

export type Profile = "sea-water" | "river-water" | "outdoor-adventure" | "outdoor-nature" | "outdoor-leisure" | "two-wheeler" | "road-transfer" | "air" | "indoor" | "stay";

export const PROFILE_LABEL: Record<Profile, string> = {
  "sea-water": "Sea / island water activity",
  "river-water": "River water activity",
  "outdoor-adventure": "Outdoor adventure",
  "outdoor-nature": "Outdoor nature trip",
  "outdoor-leisure": "Open-air leisure",
  "two-wheeler": "Two-wheeler travel",
  "road-transfer": "Road transfer",
  air: "Flight",
  indoor: "Indoor",
  stay: "Stay",
};

type Sens = {
  /** How much the day's total rain matters (sea state, river level, trail mud, flooding) 0…1. */
  dayRain: number;
  /** How much rain intensity during the slot matters 0…1. */
  slotRain: number;
  /** Wind (km/h) at which it becomes unsafe; Infinity = not wind sensitive. */
  windClose: number;
  /** Heat (°C) at which it becomes unsafe outdoors. */
  heatClose: number;
  thunderCloses: boolean;
  /** Default activity window when the item has no time. */
  window: [number, number];
};

const SENS: Record<Profile, Sens> = {
  "sea-water": { dayRain: 1, slotRain: 0.8, windClose: 40, heatClose: 44, thunderCloses: true, window: [8, 12] },
  "river-water": { dayRain: 1, slotRain: 0.7, windClose: 55, heatClose: 44, thunderCloses: true, window: [9, 13] },
  "outdoor-adventure": { dayRain: 0.8, slotRain: 1, windClose: 30, heatClose: 40, thunderCloses: true, window: [9, 13] },
  "outdoor-nature": { dayRain: 0.9, slotRain: 0.8, windClose: 60, heatClose: 41, thunderCloses: true, window: [8, 15] },
  "outdoor-leisure": { dayRain: 0.35, slotRain: 1, windClose: 60, heatClose: 42, thunderCloses: false, window: [12, 16] },
  "two-wheeler": { dayRain: 0.5, slotRain: 1, windClose: 50, heatClose: 44, thunderCloses: true, window: [9, 18] },
  "road-transfer": { dayRain: 0.4, slotRain: 0.5, windClose: 90, heatClose: 50, thunderCloses: false, window: [9, 12] },
  air: { dayRain: 0.25, slotRain: 0.4, windClose: 65, heatClose: 50, thunderCloses: false, window: [6, 10] },
  indoor: { dayRain: 0.15, slotRain: 0.1, windClose: 120, heatClose: 60, thunderCloses: false, window: [18, 22] },
  stay: { dayRain: 0.1, slotRain: 0, windClose: 150, heatClose: 60, thunderCloses: false, window: [14, 23] },
};

export function profileOf(item: Pick<ItineraryItem, "title" | "category" | "vendor">): Profile {
  const t = `${item.title} ${item.vendor ?? ""}`.toLowerCase();
  if (item.category === "Stay") return "stay";
  if (/flight|indigo|air india|vistara|akasa|spicejet|6e-|airport(?! pickup)/.test(t) && item.category === "Transport") return "air";
  if (/scooter|bike|moped|two.?wheeler|activa/.test(t)) return "two-wheeler";
  if (/raft|kayak|river/.test(t)) return "river-water";
  if (/scuba|snorkel|parasail|jet ?ski|cruise|boat|island|dolphin|surf|banana ride|water sports?/.test(t)) return "sea-water";
  if (/paraglid|bungee|zip ?line|atv|quad|sky ?div|climb|rappel|jeep safari/.test(t)) return "outdoor-adventure";
  if (/trek|hike|falls|waterfall|safari|wildlife|forest|plantation|snow|rohtang|solang|viewpoint|national park/.test(t)) return "outdoor-nature";
  if (/shack|beach|market|walk|fontainhas|sunset|street food|night market/.test(t)) return "outdoor-leisure";
  if (item.category === "Local travel" || item.category === "Transport") return "road-transfer";
  if (/spa|museum|gallery|bowling|arcade|cinema|mall|dinner|lunch|breakfast|restaurant|caf[eé]|brewery|club|bar|escape|aquarium|temple|church/.test(t)) return "indoor";
  const tags = itemTags(item);
  if (tags.includes("water")) return "sea-water";
  if (tags.includes("adventure")) return "outdoor-adventure";
  if (tags.includes("nature") || tags.includes("mountain")) return "outdoor-nature";
  if (item.category === "Food" || item.category === "Shopping") return "indoor";
  return "outdoor-leisure";
}

export type ConditionSource = "live-forecast" | "simulated" | "no-data";

/** The conditions an item faces: the day, and hour-level detail when there is any. */
export type Conditions = {
  source: ConditionSource;
  day: WeatherDay | null;
  /** Days between now and the item — forecast skill drops with lead time. */
  leadDays: number;
};

export type Availability = "open" | "at-risk" | "unavailable" | "unknown";
export type Level = "Low" | "Medium" | "High";

export type ScoreComponent = { label: string; value: number; detail: string };

export type Assessment = {
  profile: Profile;
  /** 0 … 1 */
  hazard: number;
  suitability: number;
  availability: Availability;
  /** 0 … 100 impact / risk score and its band. */
  impactScore: number;
  level: Level;
  confidence: number;
  drivers: string[];
  components: ScoreComponent[];
  window: [number, number];
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const lerp = (x: number, a: number, b: number) => clamp01((x - a) / (b - a));

/** IMD daily categories → 0…1 hazard. */
export function dayRainHazard(mm: number): number {
  if (mm < 2.5) return 0;
  if (mm < 15.6) return 0.1 + 0.15 * lerp(mm, 2.5, 15.6);
  if (mm < 64.5) return 0.25 + 0.35 * lerp(mm, 15.6, 64.5);
  if (mm < 115.6) return 0.6 + 0.25 * lerp(mm, 64.5, 115.6);
  return 0.85 + 0.15 * lerp(mm, 115.6, 204.5);
}
export function imdCategory(mm: number): string {
  if (mm < 2.5) return "no significant rain";
  if (mm < 15.6) return "light rain";
  if (mm < 64.5) return "moderate rain";
  if (mm < 115.6) return "heavy rain";
  if (mm < 204.5) return "very heavy rain";
  return "extremely heavy rain";
}
/** Hourly intensity bands → 0…1 hazard. */
export function rateHazard(mmPerHour: number): number {
  if (mmPerHour < 0.5) return 0;
  if (mmPerHour < 2.5) return 0.15 + 0.2 * lerp(mmPerHour, 0.5, 2.5);
  if (mmPerHour < 7.6) return 0.35 + 0.35 * lerp(mmPerHour, 2.5, 7.6);
  return 0.7 + 0.3 * lerp(mmPerHour, 7.6, 20);
}

export function windowOf(item: Pick<ItineraryItem, "time">, profile: Profile): [number, number] {
  const m = item.time ? /^(\d{1,2}):/.exec(item.time) : null;
  if (m) {
    const h = Math.min(23, Number(m[1]));
    return [h, Math.min(24, h + 3)];
  }
  return SENS[profile].window;
}

function hoursIn(day: WeatherDay, window: [number, number]): WeatherHour[] {
  return (day.hours ?? []).filter((h) => h.hour >= window[0] && h.hour < window[1]);
}

/**
 * Forecast confidence 0…1: the source's own precipitation probability (how
 * sure the model is it rains / stays dry) blended with lead time. Simulated
 * conditions are what the user set, so confidence is 1.
 */
export function confidenceOf(c: Conditions): number {
  if (c.source === "simulated") return 1;
  if (!c.day) return 0;
  const lead = c.leadDays <= 2 ? 0.9 : c.leadDays <= 5 ? 0.8 : c.leadDays <= 9 ? 0.65 : 0.5;
  const p = c.day.precipitationProbability;
  // Certainty either way: 90% or 10% chance are both confident statements.
  const sure = p === null ? 0.6 : 0.5 + Math.abs(p - 50) / 100;
  return Math.round(lead * sure * 100) / 100;
}

/**
 * Assess one item against its conditions. `newsPressure` (0…1) is how strongly
 * recent public reports for the place talk about bad weather — it can raise
 * the score a little, never create risk on a clear day by itself.
 */
export function assess(item: Pick<ItineraryItem, "title" | "category" | "vendor" | "time">, c: Conditions, newsPressure = 0): Assessment {
  const profile = profileOf(item);
  const s = SENS[profile];
  const window = windowOf(item, profile);
  const drivers: string[] = [];
  const components: ScoreComponent[] = [];
  if (!c.day) {
    return {
      profile,
      hazard: 0,
      suitability: 0,
      availability: "unknown",
      impactScore: 0,
      level: "Low",
      confidence: 0,
      drivers: ["No live forecast covers this date yet (Open-Meteo reaches 16 days ahead). Not guessed."],
      components: [],
      window,
    };
  }
  const d = c.day;
  const slot = hoursIn(d, window);
  const slotMax = slot.length ? Math.max(...slot.map((h) => h.precipitationMm)) : d.precipitationMm / Math.max(1, d.precipitationHours ?? 24);
  const slotSum = slot.reduce((a, h) => a + h.precipitationMm, 0);
  const hDay = dayRainHazard(d.precipitationMm) * s.dayRain;
  const hSlot = rateHazard(slotMax) * s.slotRain;
  const rain = Math.max(hDay, hSlot);
  const windMax = slot.length ? Math.max(...slot.map((h) => h.windKmh)) : d.windMaxKmh;
  const wind = Number.isFinite(s.windClose) ? lerp(Math.max(windMax, (d.gustMaxKmh ?? 0) * 0.7), s.windClose * 0.55, s.windClose) : 0;
  const tMax = slot.length ? Math.max(...slot.map((h) => h.tempC)) : d.tempMaxC;
  const heat = lerp(tMax, s.heatClose - 6, s.heatClose);
  const thunderCode = slot.length ? slot.some((h) => isThunder(h.weatherCode)) : isThunder(d.weatherCode);
  const thunder = thunderCode ? (s.thunderCloses ? 0.8 : 0.3) : 0;
  // Two or more serious factors together (rain + wind, storm + heat) compound.
  const compounding = [rain, wind, heat, thunder].filter((x) => x > 0.3).length >= 2 ? 0.15 : 0;
  const hazard = clamp01(Math.max(rain, wind, heat, thunder) + compounding);

  if (hDay > 0.05) drivers.push(`${d.precipitationMm.toFixed(1)} mm on the day (${imdCategory(d.precipitationMm)})`);
  if (hSlot > 0.05) drivers.push(`${slotMax.toFixed(1)} mm/h peak between ${window[0]}:00–${window[1]}:00${slot.length ? ` (${slotSum.toFixed(1)} mm in the slot)` : ""}`);
  if (wind > 0.05) drivers.push(`wind ${Math.round(windMax)} km/h${d.gustMaxKmh ? `, gusts ${Math.round(d.gustMaxKmh)}` : ""} (unsafe from ${s.windClose})`);
  if (heat > 0.05) drivers.push(`${Math.round(tMax)}°C (heat-unsafe from ${s.heatClose}°C outdoors)`);
  if (thunderCode) drivers.push(`${describeWeatherCode(d.weatherCode).toLowerCase()} forecast`);
  if (!drivers.length) drivers.push(`${describeWeatherCode(d.weatherCode)}, ${d.precipitationMm.toFixed(1)} mm, ${Math.round(d.tempMaxC)}°C — no weather concern for this kind of activity`);

  const confidence = confidenceOf(c);
  const sensitivity = Math.max(s.dayRain, s.slotRain);
  const news = clamp01(newsPressure) * (hazard > 0.2 ? 0.12 : 0);
  const raw = hazard * (0.65 + 0.35 * confidence) + news;
  const impactScore = Math.round(clamp01(raw) * 100);
  const level: Level = impactScore >= 60 ? "High" : impactScore >= 30 ? "Medium" : "Low";
  components.push({ label: "Weather severity", value: Math.round(hazard * 100), detail: drivers[0] });
  components.push({ label: "Activity sensitivity", value: Math.round(sensitivity * 100), detail: PROFILE_LABEL[profile] });
  components.push({ label: "Forecast confidence", value: Math.round(confidence * 100), detail: c.source === "simulated" ? "Simulated — what you set" : `precipitation probability ${d.precipitationProbability ?? "n/a"}%, ${c.leadDays} day${c.leadDays === 1 ? "" : "s"} ahead` });
  if (news > 0) components.push({ label: "Public reports", value: Math.round(news * 100), detail: "recent reports mention bad weather here" });

  const suitability = Math.round((1 - hazard) * 100);
  const availability: Availability = hazard >= 0.75 ? "unavailable" : hazard >= 0.4 ? "at-risk" : "open";
  return { profile, hazard, suitability, availability, impactScore, level, confidence, drivers, components, window };
}

export type Slot = { start: number; end: number; hazard: number; suitability: number; mm: number };

/**
 * Time-based adaptation: the same item scored across the day's daylight
 * slots. Only meaningful where hour-level data exists; day-level ground
 * effects (sea state, river level) stay in every slot.
 */
export function slotsFor(item: Pick<ItineraryItem, "title" | "category" | "vendor" | "time">, c: Conditions): Slot[] {
  if (!c.day?.hours?.length) return [];
  const profile = profileOf(item);
  const len = Math.max(2, windowOf(item, profile)[1] - windowOf(item, profile)[0]);
  const out: Slot[] = [];
  for (let start = 7; start + len <= 20; start += 1) {
    const a = assess({ ...item, time: `${String(start).padStart(2, "0")}:00` }, c);
    const mm = hoursIn(c.day, [start, start + len]).reduce((s, h) => s + h.precipitationMm, 0);
    out.push({ start, end: start + len, hazard: a.hazard, suitability: a.suitability, mm: Math.round(mm * 10) / 10 });
  }
  return out;
}

/** The best slot that is clearly better than the planned one, if any. */
export function betterSlot(slots: Slot[], current: Assessment): Slot | null {
  const best = [...slots].sort((a, b) => a.hazard - b.hazard || Math.abs(a.start - current.window[0]) - Math.abs(b.start - current.window[0]))[0];
  if (!best) return null;
  if (best.start === current.window[0]) return null;
  if (current.hazard - best.hazard < 0.2 || best.hazard >= 0.4) return null;
  return best;
}
