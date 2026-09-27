import type { TripState } from "@/lib/ledger/types";
import type { WeatherDay } from "@/lib/weather/openmeteo";

/**
 * A What-If scenario for the Digital Twin. It only ever describes changes to
 * a COPY of the world (weather readings, availability, who is going); the
 * real trip is untouched. `validateScenario` is the gate for anything coming
 * from outside (the UI or a model): ranges are clamped, unknown ids dropped.
 */

export type Area = { kind: "trip" } | { kind: "item"; itemId: string; radiusKm: number };

export type Scenario = {
  label?: string;
  /** Trip day the weather applies to; absent = every trip day. */
  date?: string;
  /** Total rain for the day, mm. */
  rainfallMm?: number;
  /** Hour the rain starts (0–23). */
  stormStartHour?: number;
  /** How many hours the rain lasts on the day. */
  stormHours?: number;
  /** The storm continues this many hours past the day (spills into the next day). */
  stormExtraHours?: number;
  temperatureC?: number;
  windKmh?: number;
  area?: Area;
  unavailableItemIds: string[];
  skippingParticipantIds: string[];
  hotelRemoved: boolean;
};

export const EMPTY_SCENARIO: Scenario = { unavailableItemIds: [], skippingParticipantIds: [], hotelRemoved: false };

const clampN = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : undefined;
};

export type ScenarioCheck = { scenario: Scenario; warnings: string[] };

/** Validates and repairs a scenario against the trip. Never throws; reports what it dropped. */
export function validateScenario(raw: unknown, state: TripState): ScenarioCheck {
  const warnings: string[] = [];
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const itemIds = new Set(state.itinerary.filter((i) => i.status !== "cancelled").map((i) => i.id));
  const people = new Set(state.participants.filter((p) => !p.leftOn).map((p) => p.id));
  const ids = (v: unknown, known: Set<string>, what: string) => {
    if (!Array.isArray(v)) return [];
    const out = [...new Set(v.filter((x): x is string => typeof x === "string"))];
    const bad = out.filter((x) => !known.has(x));
    if (bad.length) warnings.push(`Dropped unknown ${what}: ${bad.join(", ")}`);
    return out.filter((x) => known.has(x));
  };
  const s: Scenario = {
    label: typeof r.label === "string" ? r.label.slice(0, 80) : undefined,
    rainfallMm: clampN(r.rainfallMm, 0, 500),
    stormStartHour: clampN(r.stormStartHour, 0, 23),
    stormHours: clampN(r.stormHours, 1, 24),
    stormExtraHours: clampN(r.stormExtraHours, 0, 48),
    temperatureC: clampN(r.temperatureC, -20, 55),
    windKmh: clampN(r.windKmh, 0, 200),
    unavailableItemIds: ids(r.unavailableItemIds, itemIds, "items"),
    skippingParticipantIds: ids(r.skippingParticipantIds, people, "members"),
    hotelRemoved: r.hotelRemoved === true,
  };
  if (typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
    if (r.date >= state.trip.startDate && r.date <= state.trip.endDate) s.date = r.date;
    else warnings.push(`Date ${r.date} is outside the trip — applied to every trip day instead`);
  }
  const area = r.area as Record<string, unknown> | undefined;
  if (area?.kind === "item" && typeof area.itemId === "string") {
    if (itemIds.has(area.itemId)) s.area = { kind: "item", itemId: area.itemId, radiusKm: clampN(area.radiusKm, 1, 200) ?? 15 };
    else warnings.push(`Dropped unknown location ${area.itemId}`);
  }
  if (s.hotelRemoved && !state.itinerary.some((i) => i.category === "Stay" && i.status !== "cancelled")) {
    warnings.push("This trip has no stay to remove");
    s.hotelRemoved = false;
  }
  return { scenario: s, warnings };
}

export function isEmptyScenario(s: Scenario): boolean {
  return (
    s.rainfallMm === undefined &&
    s.temperatureC === undefined &&
    s.windKmh === undefined &&
    !s.stormExtraHours &&
    !s.unavailableItemIds.length &&
    !s.skippingParticipantIds.length &&
    !s.hotelRemoved
  );
}

function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/**
 * The simulated weather for one date at one place, derived from the real day
 * (when there is one) with the scenario's parameters laid over it. Returns
 * null when the scenario does not touch this date.
 */
export function simulatedDay(real: WeatherDay | null, date: string, s: Scenario, fallback: WeatherDay | null): WeatherDay | null {
  const touchesWeather = s.rainfallMm !== undefined || s.temperatureC !== undefined || s.windKmh !== undefined || !!s.stormExtraHours;
  if (!touchesWeather) return null;
  const base: WeatherDay = real ?? (fallback ? { ...fallback, date, hours: fallback.hours?.map((h) => ({ ...h })) } : { date, precipitationMm: 0, precipitationProbability: null, precipitationHours: 0, tempMaxC: 28, tempMinC: 22, windMaxKmh: 10, gustMaxKmh: null, weatherCode: 2 });
  const start = s.stormStartHour ?? 6;
  const len = s.stormHours ?? 12;
  const onDay = !s.date || s.date === date;
  const spill = !!s.date && addDays(s.date, 1) === date && !!s.stormExtraHours;
  if (!onDay && !spill) return null;

  // Intensity is fixed by the day's rainfall over the storm length; extra hours
  // keep raining at that rate, and whatever runs past midnight spills over.
  const rate = (s.rainfallMm ?? base.precipitationMm) / len;
  const extra = s.stormExtraHours ?? 0;
  let rainTotal: number | undefined = s.rainfallMm;
  let rainStart = start;
  let rainHours = Math.min(24 - start, len);
  if (onDay && extra) {
    rainHours = Math.min(24 - start, len + extra);
    rainTotal = rate * rainHours;
  }
  if (spill && !onDay) {
    const past = Math.max(0, start + len + extra - 24);
    if (!past) return null;
    rainStart = 0;
    rainHours = Math.min(24, past);
    rainTotal = rate * rainHours;
  }
  const day: WeatherDay = { ...base, date, hours: base.hours?.map((h) => ({ ...h })) };
  if (rainTotal !== undefined) {
    const perHour = rainTotal / Math.max(1, rainHours);
    const hours = day.hours?.length ? day.hours : Array.from({ length: 24 }, (_, hour) => ({ hour, precipitationMm: 0, precipitationProbability: null, windKmh: base.windMaxKmh * 0.7, tempC: base.tempMaxC - 3, weatherCode: base.weatherCode }));
    day.hours = hours.map((h) => {
      const inStorm = h.hour >= rainStart && h.hour < rainStart + rainHours;
      return { ...h, precipitationMm: inStorm ? Math.round(perHour * 1000) / 1000 : spill ? h.precipitationMm : 0, precipitationProbability: inStorm ? 100 : h.precipitationProbability, weatherCode: inStorm ? (perHour >= 7.6 ? 65 : perHour >= 2.5 ? 63 : 61) : h.weatherCode };
    });
    day.precipitationMm = Math.round(day.hours.reduce((a, h) => a + h.precipitationMm, 0) * 10) / 10;
    day.precipitationHours = day.hours.filter((h) => h.precipitationMm > 0).length;
    day.precipitationProbability = 100;
    day.weatherCode = perHour >= 7.6 ? 65 : perHour >= 2.5 ? 63 : rainTotal > 0 ? 61 : day.weatherCode;
  }
  if (s.temperatureC !== undefined && onDay) {
    const delta = s.temperatureC - day.tempMaxC;
    day.tempMaxC = s.temperatureC;
    day.hours = day.hours?.map((h) => ({ ...h, tempC: Math.round((h.tempC + delta * (h.hour >= 10 && h.hour <= 17 ? 1 : 0.6)) * 10) / 10 }));
  }
  if (s.windKmh !== undefined && onDay) {
    day.windMaxKmh = s.windKmh;
    day.gustMaxKmh = Math.round(s.windKmh * 1.4);
    day.hours = day.hours?.map((h) => ({ ...h, windKmh: s.windKmh! }));
  }
  return day;
}
