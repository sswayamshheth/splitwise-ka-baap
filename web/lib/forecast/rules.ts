import { addDaysIso } from "@/lib/dates";
import { ideasFor } from "@/lib/itinerary/suggest";
import type { ExpenseCategory } from "@/lib/ledger/types";

import { classifyItem, type Exposure } from "./classify";

/**
 * Weather rules for the Plan section, decided entirely in code. AI may later
 * rephrase what these functions return, but never adds alerts or changes them.
 * Nothing here changes the plan: every result is a suggestion the user can act on.
 */

/** Open-Meteo gives about 16 days of daily forecast, today included. */
export const FORECAST_DAYS = 16;

export const THRESHOLDS = {
  /** Heavy rain: chance of precipitation at or above this %… */
  rainProbability: 60,
  /** …or at least this much rain in the day (mm). */
  rainMm: 10,
  /** Extreme heat: daily maximum at or above this (°C). */
  heatC: 38,
  /** Strong wind: daily maximum at or above this (km/h). */
  windKmh: 40,
} as const;

/** WMO weather codes 95, 96 and 99 are thunderstorms. */
const THUNDER_CODES = new Set([95, 96, 99]);

export type DailyForecast = {
  date: string;
  /** WMO weather code. */
  code: number;
  tMaxC: number;
  tMinC: number;
  rainMm: number;
  /** Max hourly chance of precipitation, %; null when the model doesn't give one. */
  rainProbability: number | null;
  windKmh: number;
};

export type AlertKind = "rain" | "heat" | "wind" | "storm";
export type WeatherAlert = { kind: AlertKind; label: string; reason: string };

export type PlanItemInput = {
  id: string;
  title: string;
  category: ExpenseCategory | string;
  date: string;
  location?: string;
  vendor?: string;
  status?: "planned" | "booked" | "cancelled";
};

export type ItemRisk = { itemId: string; title: string; date: string; reasons: string[] };
export type BetterDay = { itemId: string; title: string; date: string; why: string };
export type Alternative = { title: string; category: ExpenseCategory | string; fromPlan: boolean };

export type DayWeather = {
  date: string;
  /** Absent when the day is outside the forecast window. */
  forecast?: DailyForecast;
  summary?: string;
  /** Code-decided alerts — only raised on days that have outdoor items. */
  alerts: WeatherAlert[];
  /** Outdoor items on this day that the alerts put at risk ("exclusions"). */
  atRisk: ItemRisk[];
  /** Clearer days in the trip where an at-risk item could move ("inclusions"). */
  betterDays: BetterDay[];
  /** Indoor ideas for this day, from the plan and the curated library ("inclusions"). */
  alternatives: Alternative[];
  /** What to pack for this day. */
  packing: string[];
};

export type TripWeather =
  | { status: "too-far"; message: string; forecastFrom: string }
  | { status: "past"; message: string }
  | { status: "ok"; days: DayWeather[]; packing: string[]; alertDays: number; itemRisk: Record<string, ItemRisk>; lastForecastDate: string };

/** Short plain-words summary of a WMO code. */
export function describeCode(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "Rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "Snow";
  if (THUNDER_CODES.has(code)) return "Thunderstorms";
  return "Mixed";
}

/** Conditions that would trouble an outdoor plan on this day, whatever is planned. */
export function conditionsFor(day: DailyForecast): WeatherAlert[] {
  const out: WeatherAlert[] = [];
  if (THUNDER_CODES.has(day.code)) out.push({ kind: "storm", label: "Thunderstorms", reason: "thunderstorms forecast" });
  const probRain = day.rainProbability !== null && day.rainProbability >= THRESHOLDS.rainProbability;
  if (probRain || day.rainMm >= THRESHOLDS.rainMm) {
    const bits = [day.rainProbability !== null ? `${Math.round(day.rainProbability)}% chance of rain` : null, day.rainMm > 0 ? `${round1(day.rainMm)} mm expected` : null].filter(Boolean);
    // Same alert either way; the label only says "heavy" when that much rain is actually expected.
    out.push({ kind: "rain", label: day.rainMm >= THRESHOLDS.rainMm ? "Heavy rain" : "Rain likely", reason: bits.join(", ") || "heavy rain expected" });
  }
  if (day.tMaxC >= THRESHOLDS.heatC) out.push({ kind: "heat", label: "Extreme heat", reason: `up to ${Math.round(day.tMaxC)}°C` });
  if (day.windKmh >= THRESHOLDS.windKmh) out.push({ kind: "wind", label: "Strong wind", reason: `gusts to ${Math.round(day.windKmh)} km/h` });
  return out;
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function packingFor(days: DailyForecast[]): string[] {
  const items = new Set<string>();
  for (const d of days) {
    if ((d.rainProbability ?? 0) >= 40 || d.rainMm >= 2 || THUNDER_CODES.has(d.code)) items.add("Rain jacket or umbrella");
    if (d.tMaxC >= 30) items.add("Sunscreen, hat and water");
    if (d.tMaxC >= THRESHOLDS.heatC) items.add("Light, loose clothing");
    if (d.tMinC <= 10) items.add("Warm layers for the evenings");
    if (d.tMinC <= 2 || (d.code >= 71 && d.code <= 77)) items.add("Gloves and a warm hat");
    if (d.windKmh >= 30) items.add("A windproof layer");
  }
  return [...items];
}

const GENERIC_INDOOR: Alternative[] = [
  { title: "A local museum or heritage centre", category: "Activity", fromPlan: false },
  { title: "A long café lunch or a cooking class", category: "Food", fromPlan: false },
  { title: "A spa or massage afternoon", category: "Activity", fromPlan: false },
  { title: "An indoor market or shopping street", category: "Shopping", fromPlan: false },
];

/** Indoor ideas: first those already in the plan (other days), then the destination library, then generic ones. */
function indoorAlternatives(destination: string, items: PlanItemInput[], date: string): Alternative[] {
  const seen = new Set<string>();
  const out: Alternative[] = [];
  const add = (a: Alternative) => {
    const key = a.title.toLowerCase();
    if (seen.has(key) || out.length >= 4) return;
    seen.add(key);
    out.push(a);
  };
  for (const i of items) if (i.date !== date && i.status !== "cancelled" && classifyItem(i) === "indoor" && i.category !== "Stay") add({ title: i.title, category: i.category, fromPlan: true });
  for (const idea of ideasFor(destination)) if (classifyItem(idea) === "indoor") add({ title: idea.title, category: idea.category, fromPlan: false });
  for (const g of GENERIC_INDOOR) add(g);
  return out;
}

/**
 * Applies the rules to a trip. `forecast` may cover only part of the trip;
 * `today` bounds the forecast window.
 */
export function planWeather(input: { destination: string; startDate: string; endDate: string; today: string; items: PlanItemInput[]; forecast: DailyForecast[] }): TripWeather {
  const { startDate, endDate, today } = input;
  const lastForecastDate = addDaysIso(today, FORECAST_DAYS - 1);
  if (endDate < today) return { status: "past", message: "This trip has already happened." };
  if (startDate > lastForecastDate) {
    return { status: "too-far", message: "Forecast available closer to your dates", forecastFrom: addDaysIso(startDate, -(FORECAST_DAYS - 1)) };
  }

  const byDate = new Map(input.forecast.map((d) => [d.date, d]));
  const active = input.items.filter((i) => i.status !== "cancelled");
  const dates: string[] = [];
  for (let d = startDate < today ? today : startDate; d && d <= endDate; d = addDaysIso(d, 1)) dates.push(d);

  const days: DayWeather[] = [];
  const itemRisk: Record<string, ItemRisk> = {};
  for (const date of dates) {
    const forecast = date <= lastForecastDate ? byDate.get(date) : undefined;
    const day: DayWeather = { date, forecast, summary: forecast ? describeCode(forecast.code) : undefined, alerts: [], atRisk: [], betterDays: [], alternatives: [], packing: [] };
    if (forecast) {
      const conditions = conditionsFor(forecast);
      const outdoor = active.filter((i) => i.date === date && classifyItem(i) === "outdoor");
      if (conditions.length && outdoor.length) {
        day.alerts = conditions;
        day.packing = packingFor([forecast]);
        for (const i of outdoor) {
          const risk: ItemRisk = { itemId: i.id, title: i.title, date, reasons: conditions.map((c) => `${c.label}: ${c.reason}`) };
          day.atRisk.push(risk);
          itemRisk[i.id] = risk;
        }
        day.alternatives = indoorAlternatives(input.destination, active, date);
      }
    }
    days.push(day);
  }

  // Better days: the clearest other day in the trip (no conditions, lowest rain chance) for each at-risk item.
  const calm = days.filter((d) => d.forecast && conditionsFor(d.forecast).length === 0);
  for (const day of days) {
    for (const risk of day.atRisk) {
      const options = calm.filter((d) => d.date !== day.date).sort((a, b) => (a.forecast!.rainProbability ?? 0) - (b.forecast!.rainProbability ?? 0) || a.forecast!.rainMm - b.forecast!.rainMm);
      const best = options[0];
      if (best?.forecast) {
        const f = best.forecast;
        day.betterDays.push({ itemId: risk.itemId, title: risk.title, date: best.date, why: `${describeCode(f.code).toLowerCase()}${f.rainProbability !== null ? `, ${Math.round(f.rainProbability)}% chance of rain` : ""}, up to ${Math.round(f.tMaxC)}°C` });
      } else if (day.alerts.some((a) => a.kind === "heat")) {
        day.betterDays.push({ itemId: risk.itemId, title: risk.title, date: day.date, why: "go early (before 10 am) or late (after 5 pm), when it's cooler" });
      }
    }
  }

  const forecastDays = days.map((d) => d.forecast).filter((f): f is DailyForecast => !!f);
  return { status: "ok", days, packing: packingFor(forecastDays), alertDays: days.filter((d) => d.alerts.length).length, itemRisk, lastForecastDate };
}

export type { Exposure };
