import type { Forecast, LatLon, WeatherDay, WeatherHour } from "./openmeteo";

/**
 * Backup forecast source: MET Norway's Locationforecast (api.met.no — the
 * Norwegian Meteorological Institute, behind yr.no). Free, no key, global,
 * ~9 days ahead. Used when Open-Meteo refuses (e.g. its free daily quota is
 * used up on a shared network). Their terms require an identifying User-Agent.
 */

export const METNO_UA = "GroupTripLedger/1.0 (HackCelestial demo; github.com/sswayamshheth/splitwise-ka-baap)";
export const metnoUrl = (p: LatLon) => `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}`;

/** MET symbol codes → WMO weather codes (the vocabulary the rest of the app speaks). */
export function symbolToWmo(symbol: string | undefined): number {
  const s = (symbol ?? "").replace(/_(day|night|polartwilight)$/, "");
  if (/thunder/.test(s)) return 95;
  if (/snow/.test(s)) return /heavy/.test(s) ? 75 : /light/.test(s) ? 71 : 73;
  if (/sleet/.test(s)) return 66;
  if (/rainshowers/.test(s)) return /heavy/.test(s) ? 81 : 80;
  if (/rain/.test(s)) return /heavy/.test(s) ? 65 : /light/.test(s) ? 61 : 63;
  if (s === "fog") return 45;
  if (s === "cloudy") return 3;
  if (s === "partlycloudy") return 2;
  if (s === "fair") return 1;
  return 0; // clearsky / unknown
}

/** MET answers in UTC; days are grouped in the destination's local time (IST inside India, else by longitude). */
export function utcOffsetMinutes(p: LatLon): number {
  if (p.lat >= 6 && p.lat <= 37.5 && p.lon >= 68 && p.lon <= 97.5) return 330;
  return Math.round(p.lon / 15) * 60;
}

type Entry = {
  time: string;
  data: {
    instant?: { details?: { air_temperature?: number; wind_speed?: number } };
    next_1_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } };
    next_6_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } };
  };
};

/** `offsetMinutes`: the destination's real UTC offset when known (e.g. from Open-Meteo's answer); else estimated. */
export function parseMetno(json: unknown, label: string, requested: LatLon, sourceUrl: string, fetchedAt = Date.now(), offsetMinutes = utcOffsetMinutes(requested)): Forecast {
  const ts = (json as { properties?: { timeseries?: Entry[] } } | null)?.properties?.timeseries;
  if (!Array.isArray(ts) || !ts.length) throw new Error("MET Norway: empty forecast");
  const offset = offsetMinutes * 60_000;
  const days = new Map<string, { temps: number[]; winds: number[]; mm: number; wetHours: number; covered: number; codes: number[]; hours: WeatherHour[] }>();
  for (const e of ts) {
    const local = new Date(Date.parse(e.time) + offset);
    const date = local.toISOString().slice(0, 10);
    const hour = local.getUTCHours();
    const d = days.get(date) ?? { temps: [], winds: [], mm: 0, wetHours: 0, covered: 0, codes: [], hours: [] };
    const temp = e.data.instant?.details?.air_temperature;
    const windKmh = (e.data.instant?.details?.wind_speed ?? 0) * 3.6;
    if (typeof temp === "number") d.temps.push(temp);
    d.winds.push(windKmh);
    // Hourly steps carry next_1_hours; later (6-hourly) steps only next_6_hours — never count both.
    const h1 = e.data.next_1_hours;
    const h6 = e.data.next_6_hours;
    const mm = h1 ? (h1.details?.precipitation_amount ?? 0) : (h6?.details?.precipitation_amount ?? 0);
    const code = symbolToWmo((h1 ?? h6)?.summary?.symbol_code);
    d.mm += mm;
    d.covered += h1 ? 1 : h6 ? 6 : 0;
    if (mm > 0) d.wetHours += h1 ? 1 : 6;
    d.codes.push(code);
    if (h1 && typeof temp === "number") d.hours.push({ hour, precipitationMm: mm, precipitationProbability: null, windKmh, tempC: temp, weatherCode: code });
    days.set(date, d);
  }
  const daily: WeatherDay[] = [...days.entries()]
    // A day seen through a single reading (the last step has no period after it) would show min = max: left out.
    .filter(([, d]) => d.temps.length >= 2 && d.covered >= 6)
    .map(([date, d]) => ({
      date,
      hours: d.hours.length >= 12 ? d.hours : undefined,
      precipitationMm: Math.round(d.mm * 10) / 10,
      precipitationProbability: null,
      precipitationHours: d.wetHours,
      tempMaxC: Math.max(...d.temps),
      tempMinC: Math.min(...d.temps),
      windMaxKmh: Math.round(Math.max(...d.winds)),
      gustMaxKmh: null,
      weatherCode: Math.max(...d.codes),
    }));
  const first = ts[0];
  return {
    location: { ...requested, label },
    grid: requested,
    timezone: `UTC${offset >= 0 ? "+" : "-"}${Math.floor(Math.abs(offset) / 3_600_000)}:${String((Math.abs(offset) / 60_000) % 60).padStart(2, "0")}`,
    fetchedAt,
    source: "met-norway",
    sourceUrl,
    current: {
      time: first.time,
      temperatureC: first.data.instant?.details?.air_temperature ?? daily[0]?.tempMaxC ?? 0,
      precipitationMm: first.data.next_1_hours?.details?.precipitation_amount ?? 0,
      windKmh: Math.round((first.data.instant?.details?.wind_speed ?? 0) * 3.6),
      weatherCode: symbolToWmo((first.data.next_1_hours ?? first.data.next_6_hours)?.summary?.symbol_code),
    },
    daily,
  };
}
