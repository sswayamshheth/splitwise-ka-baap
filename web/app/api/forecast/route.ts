import { NextResponse } from "next/server";

import { backupForecast, extendForecast, type JsonGetter } from "@/lib/weather/backup";
import { parseForecast, type Forecast } from "@/lib/weather/openmeteo";
import type { DailyForecast } from "@/lib/forecast/rules";
import { requireUserId, route } from "@/lib/server/trips";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-side fallback for the Plan page's forecast. Browsers call Open-Meteo
 * directly; when that fails (e.g. a shared network has used up Open-Meteo's
 * free daily quota) or the trip runs past its 16 days, the page asks here instead:
 * Open-Meteo, else MET Norway + Open-Meteo's GFS ensemble; the ensemble also
 * extends a forecast to trip days past the 16-day horizon. Signed-in only, cached 30 min.
 */

const TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; body: ForecastBody }>();

type ForecastBody = { days: DailyForecast[] | null; source?: string };

const get: JsonGetter = async (u, headers) => {
  const res = await fetch(u, { headers: { accept: "application/json", ...(headers ?? {}) }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export const GET = route(async (req: Request) => {
  await requireUserId();
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const untilRaw = url.searchParams.get("until");
  const until = untilRaw && /^\d{4}-\d{2}-\d{2}$/.test(untilRaw) ? untilRaw : undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return NextResponse.json({ days: null });
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${until ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return NextResponse.json(hit.body);
  const point = { lat, lon };
  const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max&timezone=auto&forecast_days=16`;
  let forecast: Forecast | null = null;
  try {
    forecast = await extendForecast(parseForecast(await get(omUrl), "", point, omUrl), point, "", until, get);
  } catch (e) {
    console.error("[forecast] open-meteo:", (e as Error).message, "— trying MET Norway + GFS ensemble");
    forecast = await backupForecast(point, "", get).catch(() => null);
  }
  if (!forecast?.daily.length) return NextResponse.json({ days: null });
  const body: ForecastBody = {
    days: forecast.daily.map((d) => ({ date: d.date, code: d.weatherCode, tMaxC: d.tempMaxC, tMinC: d.tempMinC, rainMm: d.precipitationMm, rainProbability: d.precipitationProbability, windKmh: d.windMaxKmh })),
    source: forecast.sourceNote ?? "Open-Meteo",
  };
  cache.set(key, { at: Date.now(), body });
  return NextResponse.json(body);
});
