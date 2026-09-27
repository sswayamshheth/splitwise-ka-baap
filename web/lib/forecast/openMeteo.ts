import type { DailyForecast } from "./rules";
import type { Place } from "./places";

/**
 * Open-Meteo (free, no key) geocoding and daily forecast, called from the
 * browser. Results are cached in memory and in localStorage — never in the
 * database. Every failure resolves to an empty result so the page stays usable.
 */

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEO_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FORECAST_TTL_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 10_000;

const memory = new Map<string, { at: number; value: unknown }>();

function readCache<T>(key: string, ttl: number): T | undefined {
  const hit = memory.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return undefined;
    const stored = JSON.parse(raw) as { at: number; value: T };
    if (Date.now() - stored.at >= ttl) return undefined;
    memory.set(key, stored);
    return stored.value;
  } catch {
    return undefined;
  }
}

function writeCache(key: string, value: unknown) {
  const entry = { at: Date.now(), value };
  memory.set(key, entry);
  try {
    window.localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // Storage full or blocked: the in-memory copy is enough.
  }
}

async function getJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const inflight = new Map<string, Promise<unknown>>();
function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

type GeoResponse = { results?: { name: string; admin1?: string; country?: string; country_code?: string; latitude: number; longitude: number }[] };

/** Places matching a name (up to 5). Empty when nothing matches or the service is unreachable. */
export function geocode(name: string): Promise<Place[]> {
  const q = name.trim();
  if (q.length < 2) return Promise.resolve([]);
  const key = `gtl.geo.v1:${q.toLowerCase()}`;
  const cached = readCache<Place[]>(key, GEO_TTL_MS);
  if (cached) return Promise.resolve(cached);
  return once(key, async () => {
    try {
      const json = (await getJson(`${GEO_URL}?name=${encodeURIComponent(q)}&count=5&language=en&format=json`)) as GeoResponse;
      const places: Place[] = (json.results ?? []).map((r) => ({ name: r.name, admin1: r.admin1, country: r.country, countryCode: r.country_code, lat: r.latitude, lon: r.longitude }));
      writeCache(key, places);
      return places;
    } catch {
      return [];
    }
  });
}

type ForecastResponse = {
  daily?: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_sum: (number | null)[];
    precipitation_probability_max: (number | null)[];
    wind_speed_10m_max: number[];
  };
};

export function parseForecast(json: unknown): DailyForecast[] {
  const d = (json as ForecastResponse)?.daily;
  if (!d || !Array.isArray(d.time)) return [];
  return d.time.map((date, i) => ({
    date,
    code: d.weather_code[i] ?? 0,
    tMaxC: d.temperature_2m_max[i] ?? 0,
    tMinC: d.temperature_2m_min[i] ?? 0,
    rainMm: d.precipitation_sum[i] ?? 0,
    rainProbability: d.precipitation_probability_max[i] ?? null,
    windKmh: d.wind_speed_10m_max[i] ?? 0,
  }));
}

/** The next 16 days of daily weather at a point, in the place's own time zone. Null when unavailable. */
export function forecastAt(lat: number, lon: number): Promise<DailyForecast[] | null> {
  const key = `gtl.wx.v1:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = readCache<DailyForecast[]>(key, FORECAST_TTL_MS);
  if (cached) return Promise.resolve(cached);
  return once(key, async () => {
    try {
      const url = `${FORECAST_URL}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max&timezone=auto&forecast_days=16`;
      const days = parseForecast(await getJson(url));
      if (!days.length) throw new Error("empty");
      writeCache(key, days);
      return days;
    } catch {
      // Direct call failed (offline, blocked, or this network hit Open-Meteo's free daily quota): try via our server.
      try {
        const via = (await getJson(`/api/forecast?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`)) as { days?: DailyForecast[] | null };
        if (!via.days?.length) return null;
        writeCache(key, via.days);
        return via.days;
      } catch {
        return null;
      }
    }
  });
}
