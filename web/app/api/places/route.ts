import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { requireUserId, route } from "@/lib/server/trips";
import { parseGeocodeList, type PlaceSuggestion } from "@/lib/weather/openmeteo";

/**
 * Destination search for the new-trip form: real places from Open-Meteo's
 * geocoding (free, no key) with coordinates, so a trip's weather and plans
 * use exactly the place the user picked.
 */
const cache = new Map<string, { at: number; results: PlaceSuggestion[] }>();

export const GET = route(async (req: Request) => {
  await requireUserId();
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 80);
  if (q.length < 2) return NextResponse.json({ results: [] });
  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3_600_000) return NextResponse.json({ results: hit.results });
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: q, count: "8", language: "en", format: "json" })}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(String(res.status));
    const results = parseGeocodeList(await res.json());
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: Date.now(), results });
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ results: [], error: "Place search is unavailable right now — try again in a moment" }, { status: 503 });
  }
});
