import type { Forecast, LatLon, WeatherDay } from "./openmeteo";

/**
 * Second backup and long-range source: Open-Meteo's Ensemble API
 * (ensemble-api.open-meteo.com, NOAA GFS ensemble — control run + 30 members,
 * up to 35 days). It is a separate service from api.open-meteo.com, so it still
 * answers when the main forecast API has refused this network's daily quota.
 *
 * Each day is summarised across all members: mean max/min temperature, mean
 * rain and wind, the median weather code, and — something the MET Norway
 * backup can't give — a real chance of rain: the share of members with at
 * least 1 mm that day.
 */

export const ENSEMBLE_MAX_DAYS = 35;

export function ensembleUrl(p: LatLon, days = ENSEMBLE_MAX_DAYS): string {
  const q = new URLSearchParams({
    latitude: p.lat.toFixed(4),
    longitude: p.lon.toFixed(4),
    models: "gfs_seamless",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
    timezone: "auto",
    forecast_days: String(Math.min(ENSEMBLE_MAX_DAYS, Math.max(1, days))),
  });
  return `https://ensemble-api.open-meteo.com/v1/ensemble?${q}`;
}

/** Rain of at least this much (mm) in a member counts towards the chance of rain. */
export const ENSEMBLE_RAIN_MM = 1;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};
const r1 = (n: number) => Math.round(n * 10) / 10;

export function parseEnsemble(json: unknown, label: string, requested: LatLon, sourceUrl: string, fetchedAt = Date.now()): Forecast {
  if (!json || typeof json !== "object") throw new Error("Empty ensemble response");
  const j = json as Record<string, unknown>;
  if (j.error) throw new Error(`Open-Meteo ensemble error: ${String(j.reason ?? "unknown")}`);
  const daily = j.daily as Record<string, unknown[]> | undefined;
  if (!daily || !Array.isArray(daily.time)) throw new Error("Ensemble response has no daily block");
  // "temperature_2m_max" is the control run, "temperature_2m_max_member01…" the members.
  const columns = (v: string) => Object.keys(daily).filter((k) => k === v || k.startsWith(`${v}_member`));
  const values = (v: string, i: number) => columns(v).map((k) => num(daily[k]?.[i])).filter((x): x is number => x !== null);
  const days: WeatherDay[] = [];
  daily.time.forEach((t, i) => {
    if (typeof t !== "string") return;
    const tmax = values("temperature_2m_max", i);
    const tmin = values("temperature_2m_min", i);
    const rain = values("precipitation_sum", i);
    const wind = values("wind_speed_10m_max", i);
    const codes = values("weather_code", i);
    // Days the model no longer covers come back as nulls: dropped, never filled in.
    if (!tmax.length || !rain.length || !codes.length) return;
    days.push({
      date: t,
      precipitationMm: r1(mean(rain)),
      precipitationProbability: Math.round((rain.filter((mm) => mm >= ENSEMBLE_RAIN_MM).length / rain.length) * 100),
      precipitationHours: null,
      tempMaxC: r1(mean(tmax)),
      tempMinC: r1(tmin.length ? mean(tmin) : mean(tmax)),
      windMaxKmh: Math.round(wind.length ? mean(wind) : 0),
      gustMaxKmh: null,
      weatherCode: median(codes),
    });
  });
  if (!days.length) throw new Error("Ensemble response has no usable days");
  return {
    location: { ...requested, label },
    grid: { lat: num(j.latitude) ?? requested.lat, lon: num(j.longitude) ?? requested.lon },
    timezone: typeof j.timezone === "string" ? j.timezone : "auto",
    fetchedAt,
    source: "open-meteo-ensemble",
    sourceUrl,
    current: null,
    daily: days,
  };
}
