/**
 * Live weather from Open-Meteo (https://open-meteo.com) — free, no key, real
 * model data (current conditions + up to 16 days of daily/hourly forecast).
 *
 * This file holds the pure parsers (tested) and the fetchers. Nothing here is
 * invented: a day outside the forecast horizon is returned as `null`, never
 * guessed, and every reading keeps where and when it came from.
 */

export type LatLon = { lat: number; lon: number };

export type GeoPlace = LatLon & { name: string; admin?: string; country?: string; source: "open-meteo-geocoding" | "nominatim"; query: string };

export type WeatherHour = { hour: number; precipitationMm: number; precipitationProbability: number | null; windKmh: number; tempC: number; weatherCode: number };

export type WeatherDay = {
  date: string;
  /** Hour-by-hour readings (local time) when the source provided them. */
  hours?: WeatherHour[];
  /** Total precipitation for the day, mm. */
  precipitationMm: number;
  /** Max probability of precipitation, %. */
  precipitationProbability: number | null;
  /** Hours with precipitation. */
  precipitationHours: number | null;
  tempMaxC: number;
  tempMinC: number;
  windMaxKmh: number;
  gustMaxKmh: number | null;
  /** WMO weather code (0 clear … 95–99 thunderstorm). */
  weatherCode: number;
};

export type WeatherCurrent = { time: string; temperatureC: number; precipitationMm: number; windKmh: number; weatherCode: number };

export type Forecast = {
  location: LatLon & { label: string };
  /** Model grid point Open-Meteo actually answered for. */
  grid: LatLon;
  timezone: string;
  fetchedAt: number;
  /** Open-Meteo normally; MET Norway when Open-Meteo refuses (quota / outage). */
  source: "open-meteo" | "met-norway";
  sourceUrl: string;
  current: WeatherCurrent | null;
  daily: WeatherDay[];
};

const WMO: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Rime fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Dense drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  80: "Rain showers",
  81: "Heavy showers",
  82: "Violent showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Severe thunderstorm with hail",
};
export const describeWeatherCode = (code: number) => WMO[code] ?? `Weather code ${code}`;
export const isThunder = (code: number) => code >= 95;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export class WeatherParseError extends Error {}

/** Parses an Open-Meteo /v1/forecast response. Throws WeatherParseError on a malformed payload. */
export function parseForecast(json: unknown, label: string, requested: LatLon, sourceUrl: string, fetchedAt = Date.now()): Forecast {
  if (!json || typeof json !== "object") throw new WeatherParseError("Empty weather response");
  const j = json as Record<string, unknown>;
  if (j.error) throw new WeatherParseError(`Open-Meteo error: ${String(j.reason ?? "unknown")}`);
  const daily = j.daily as Record<string, unknown[]> | undefined;
  if (!daily || !Array.isArray(daily.time)) throw new WeatherParseError("Weather response has no daily block");
  const at = (key: string, i: number) => num(daily[key]?.[i]);
  const days: WeatherDay[] = [];
  daily.time.forEach((t, i) => {
    if (typeof t !== "string") return;
    const precip = at("precipitation_sum", i);
    const tmax = at("temperature_2m_max", i);
    const tmin = at("temperature_2m_min", i);
    const wind = at("wind_speed_10m_max", i);
    const code = at("weather_code", i);
    // A day with missing core values is dropped rather than filled in.
    if (precip === null || tmax === null || wind === null || code === null) return;
    days.push({
      date: t,
      precipitationMm: precip,
      precipitationProbability: at("precipitation_probability_max", i),
      precipitationHours: at("precipitation_hours", i),
      tempMaxC: tmax,
      tempMinC: tmin ?? tmax,
      windMaxKmh: wind,
      gustMaxKmh: at("wind_gusts_10m_max", i),
      weatherCode: code,
    });
  });
  const hourly = j.hourly as Record<string, unknown[]> | undefined;
  if (hourly && Array.isArray(hourly.time)) {
    const byDate = new Map(days.map((d) => [d.date, d]));
    const h = (key: string, i: number) => num(hourly[key]?.[i]);
    hourly.time.forEach((t, i) => {
      if (typeof t !== "string") return;
      const day = byDate.get(t.slice(0, 10));
      const precip = h("precipitation", i);
      const temp = h("temperature_2m", i);
      if (!day || precip === null || temp === null) return;
      (day.hours ??= []).push({ hour: Number(t.slice(11, 13)), precipitationMm: precip, precipitationProbability: h("precipitation_probability", i), windKmh: h("wind_speed_10m", i) ?? 0, tempC: temp, weatherCode: h("weather_code", i) ?? day.weatherCode });
    });
  }
  const c = j.current as Record<string, unknown> | undefined;
  const current: WeatherCurrent | null =
    c && typeof c.time === "string" && num(c.temperature_2m) !== null
      ? { time: c.time, temperatureC: num(c.temperature_2m)!, precipitationMm: num(c.precipitation) ?? 0, windKmh: num(c.wind_speed_10m) ?? 0, weatherCode: num(c.weather_code) ?? 0 }
      : null;
  return {
    location: { ...requested, label },
    grid: { lat: num(j.latitude) ?? requested.lat, lon: num(j.longitude) ?? requested.lon },
    timezone: typeof j.timezone === "string" ? j.timezone : "auto",
    fetchedAt,
    source: "open-meteo",
    sourceUrl,
    current,
    daily: days,
  };
}

export function forecastUrl(p: LatLon): string {
  const q = new URLSearchParams({
    latitude: p.lat.toFixed(4),
    longitude: p.lon.toFixed(4),
    current: "temperature_2m,precipitation,weather_code,wind_speed_10m",
    daily: "precipitation_sum,precipitation_probability_max,precipitation_hours,weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_gusts_10m_max",
    hourly: "precipitation,precipitation_probability,weather_code,wind_speed_10m,temperature_2m",
    forecast_days: "16",
    timezone: "auto",
  });
  return `https://api.open-meteo.com/v1/forecast?${q}`;
}

/** Parses an Open-Meteo geocoding response (first hit). */
export function parseGeocode(json: unknown, query: string): GeoPlace | null {
  const r = (json as { results?: Record<string, unknown>[] } | null)?.results?.[0];
  if (!r) return null;
  const lat = num(r.latitude);
  const lon = num(r.longitude);
  if (lat === null || lon === null) return null;
  return { lat, lon, name: String(r.name ?? query), admin: typeof r.admin1 === "string" ? r.admin1 : undefined, country: typeof r.country === "string" ? r.country : undefined, source: "open-meteo-geocoding", query };
}

export type PlaceSuggestion = { name: string; admin?: string; district?: string; country?: string; lat: number; lon: number; population?: number; kind?: string };

/** All hits of an Open-Meteo geocoding search, for the destination picker. */
export function parseGeocodeList(json: unknown): PlaceSuggestion[] {
  const rows = (json as { results?: Record<string, unknown>[] } | null)?.results ?? [];
  const out: PlaceSuggestion[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const lat = num(r.latitude);
    const lon = num(r.longitude);
    if (lat === null || lon === null || typeof r.name !== "string") continue;
    // Same name in the same district and state is the same choice for a trip: show it once.
    const key = [r.name, r.admin2, r.admin1, r.country].join("|").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: r.name,
      district: typeof r.admin2 === "string" ? r.admin2 : undefined,
      admin: typeof r.admin1 === "string" ? r.admin1 : undefined,
      country: typeof r.country === "string" ? r.country : undefined,
      lat,
      lon,
      population: typeof r.population === "number" ? r.population : undefined,
      kind: typeof r.feature_code === "string" ? r.feature_code : undefined,
    });
  }
  return out;
}

/** Parses a Nominatim /search jsonv2 response (first hit). */
export function parseNominatim(json: unknown, query: string): GeoPlace | null {
  const r = Array.isArray(json) ? (json[0] as Record<string, unknown> | undefined) : undefined;
  if (!r) return null;
  const lat = Number(r.lat);
  const lon = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, name: String(r.name || (typeof r.display_name === "string" ? r.display_name.split(",")[0] : query)), source: "nominatim", query };
}

/** The forecast day for a date, or null when the date is outside the live horizon. */
export function dayFor(forecast: Forecast, date: string): WeatherDay | null {
  return forecast.daily.find((d) => d.date === date) ?? null;
}

export function horizon(forecast: Forecast): { first: string; last: string } | null {
  if (!forecast.daily.length) return null;
  return { first: forecast.daily[0].date, last: forecast.daily[forecast.daily.length - 1].date };
}

/** Great-circle distance in km. */
export function distanceKm(a: LatLon, b: LatLon): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
