import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

import { requireUserId, route } from "@/lib/server/trips";
import { parseGeocodeList, type PlaceSuggestion } from "@/lib/weather/openmeteo";

/** OpenStreetMap Nominatim hits (cities, states, regions) as picker suggestions. */
function parseNominatimList(json: unknown): PlaceSuggestion[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((r: Record<string, unknown>): PlaceSuggestion[] => {
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    const a = (r.address ?? {}) as Record<string, string>;
    const name = String(r.name || String(r.display_name ?? "").split(",")[0] || "").trim();
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const admin = a.state && a.state !== name ? a.state : undefined;
    return [{ name, admin, district: a.state_district ?? a.county, country: a.country, lat, lon, kind: String(r.addresstype ?? r.type ?? "") }];
  });
}

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
    // Towns from Open-Meteo, plus states/regions from OpenStreetMap ("Goa" the state isn't a town).
    const [om, osm] = await Promise.all([
      fetch(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: q, count: "8", language: "en", format: "json" })}`, { signal: AbortSignal.timeout(6000) })
        .then(async (r) => (r.ok ? parseGeocodeList(await r.json()) : []))
        .catch(() => [] as PlaceSuggestion[]),
      fetch(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: "jsonv2", limit: "6", addressdetails: "1", "accept-language": "en" })}`, {
        headers: { "user-agent": "GroupTripLedger/1.0 (HackCelestial demo; github.com/sswayamshheth/splitwise-ka-baap)" },
        signal: AbortSignal.timeout(6000),
      })
        .then(async (r) => (r.ok ? parseNominatimList(await r.json()) : []))
        .catch(() => [] as PlaceSuggestion[]),
    ]);
    if (!om.length && !osm.length) throw new Error("no results");
    const seen = new Set<string>();
    const merged = [...om, ...osm].filter((p) => {
      const k = `${p.name}|${p.admin ?? ""}|${p.country ?? ""}`.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // Exact-name matches first, then places in India (the app plans Indian trips in ₹), then the rest.
    const want = q.toLowerCase();
    const rank = (p: PlaceSuggestion) => (p.name.toLowerCase() === want ? 0 : 2) + (p.country === "India" ? 0 : 1);
    const results = merged.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p).slice(0, 10);
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: Date.now(), results });
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ results: [], error: "Place search is unavailable right now — try again in a moment" }, { status: 503 });
  }
});
