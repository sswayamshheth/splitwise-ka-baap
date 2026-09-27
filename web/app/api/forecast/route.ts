import { NextResponse } from "next/server";

import { parseForecast } from "@/lib/forecast/openMeteo";
import { metnoUrl, METNO_UA, parseMetno } from "@/lib/weather/metno";
import type { DailyForecast } from "@/lib/forecast/rules";
import { requireUserId, route } from "@/lib/server/trips";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-side fallback for the Plan page's forecast. Browsers call Open-Meteo
 * directly; when that fails (e.g. a shared network has used up Open-Meteo's
 * free daily quota) the page asks here instead. Signed-in only, cached 30 min.
 */

const TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; days: DailyForecast[] }>();

export const GET = route(async (req: Request) => {
  await requireUserId();
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return NextResponse.json({ days: null });
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return NextResponse.json({ days: hit.days });
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max&timezone=auto&forecast_days=16`,
      { signal: ctrl.signal, cache: "no-store" },
    ).finally(() => clearTimeout(timer));
    let days: DailyForecast[];
    if (!res.ok) {
      console.error("[forecast] open-meteo:", res.status, "— trying MET Norway");
      days = await metnoDays(lat, lon);
    } else {
      days = parseForecast(await res.json());
    }
    if (!days.length) return NextResponse.json({ days: null });
    cache.set(key, { at: Date.now(), days });
    return NextResponse.json({ days });
  } catch {
    console.error("[forecast] open-meteo: unreachable — trying MET Norway");
    const days = await metnoDays(lat, lon).catch(() => []);
    if (!days.length) return NextResponse.json({ days: null });
    cache.set(key, { at: Date.now(), days });
    return NextResponse.json({ days });
  }
});

/** MET Norway (api.met.no) daily summary in the Plan page's DailyForecast shape. */
async function metnoDays(lat: number, lon: number): Promise<DailyForecast[]> {
  const url = metnoUrl({ lat, lon });
  const res = await fetch(url, { headers: { "user-agent": METNO_UA, accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return [];
  const f = parseMetno(await res.json(), "", { lat, lon }, url);
  return f.daily.map((d) => ({ date: d.date, code: d.weatherCode, tMaxC: d.tempMaxC, tMinC: d.tempMinC, rainMm: d.precipitationMm, rainProbability: null, windKmh: d.windMaxKmh }));
}
