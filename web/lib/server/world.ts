import "server-only";

import dns from "node:dns";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ItineraryItem, TripState } from "@/lib/ledger/types";
import { overpassQuery, parseOverpass, parsePhoton, photonSearches, photonUrl, type Candidate } from "@/lib/signals/osm";
import { gdeltProvider, googlePlacesProvider, mastodonProvider, mergeRatings, pageviewsProvider, wikivoyageProvider, type PlaceContext } from "@/lib/signals/providers";
import type { ProviderStatus, PublicSignal } from "@/lib/signals/types";
import type { PlacePin, TwinWorld, WorldForecast } from "@/lib/twin/twin";
import { distanceKm, forecastUrl, parseForecast, parseGeocode, parseNominatim, type GeoPlace, type LatLon } from "@/lib/weather/openmeteo";

/**
 * Assembles the Digital Twin's real-world inputs for a trip: geocoded places,
 * Open-Meteo forecasts per location cluster, public signals and real
 * alternative places. Cached in memory for 10 minutes; every successful live
 * assembly is also recorded to data/replay/ so Judge Demo Mode can replay the
 * same REAL captured data if the network fails during judging.
 */

// Some public APIs publish AAAA records that are slow or unroutable from many networks; prefer IPv4.
dns.setDefaultResultOrder("ipv4first");

const UA = "GroupTripLedger/1.0 (+https://github.com/sswayamshheth/trip-pool)";
const TTL = 20 * 60_000;
const worldCache = new Map<string, { at: number; world: TwinWorld }>();
const geoCache = new Map<string, GeoPlace | null>();

async function getJson(url: string, init: RequestInit = {}, timeoutMs = 12_000): Promise<unknown> {
  const t0 = Date.now();
  if (process.env.TWIN_DEBUG) process.stderr.write(`[world] -> ${url.slice(8, 60)}
`);
  try {
    return await getJsonInner(url, init, timeoutMs);
  } finally {
    if (process.env.TWIN_DEBUG) process.stderr.write(`[world] <- ${Date.now() - t0}ms ${url.slice(8, 60)}
`);
  }
}

async function getJsonInner(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, headers: { "user-agent": UA, accept: "application/json", ...(init.headers ?? {}) }, signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

let lastNominatim = 0;
async function nominatim(query: string, near: LatLon): Promise<GeoPlace | null> {
  const key = `n:${query.toLowerCase()}`;
  if (geoCache.has(key)) return geoCache.get(key)!;
  // Nominatim usage policy: at most one request per second.
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const d = 0.9;
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: query, format: "jsonv2", limit: "1", viewbox: `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}` })}`;
  try {
    const hit = parseNominatim(await getJson(url, {}, 8000), query);
    geoCache.set(key, hit);
    return hit;
  } catch {
    return null;
  }
}

/** Photon (komoot, OSM data): location-biased search, no hard 1 req/s limit. */
async function photon(query: string, near: LatLon): Promise<GeoPlace | null> {
  const key = `p:${query.toLowerCase()}`;
  if (geoCache.has(key)) return geoCache.get(key)!;
  try {
    const json = (await getJson(`https://photon.komoot.io/api/?${new URLSearchParams({ q: query, lat: String(near.lat), lon: String(near.lon), limit: "1" })}`, {}, 8000)) as { features?: { geometry?: { coordinates?: number[] }; properties?: { name?: string } }[] };
    const f = json.features?.[0];
    const c = f?.geometry?.coordinates;
    const hit: GeoPlace | null = c && c.length >= 2 ? { lon: c[0], lat: c[1], name: f?.properties?.name ?? query, source: "nominatim", query } : null;
    geoCache.set(key, hit);
    return hit;
  } catch {
    return null;
  }
}

async function geocodeDestination(destination: string): Promise<GeoPlace | null> {
  const key = `g:${destination.toLowerCase()}`;
  if (geoCache.has(key)) return geoCache.get(key)!;
  const parts = destination.split(",").map((p) => p.trim()).filter(Boolean);
  for (const q of [parts[0], destination]) {
    try {
      const hit = parseGeocode(await getJson(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: q, count: "1", language: "en", format: "json" })}`), q);
      if (hit) {
        geoCache.set(key, hit);
        return hit;
      }
    } catch {
      /* try the next form */
    }
  }
  const n = await nominatim(destination, { lat: 20, lon: 78 });
  geoCache.set(key, n);
  return n;
}

const GENERIC = /\b(jeep|safari|meals?|rentals?|days?|nights?|tour|trip|session|dinner|lunch|breakfast|beach shack|shack|pickup|innova|airport|scooter|\d+)\b/gi;

/** Place phrases worth geocoding for an item, most specific first. */
export function placeQueries(item: Pick<ItineraryItem, "title" | "location" | "vendor" | "category">): string[] {
  const out: string[] = [];
  if (item.location) out.push(item.location);
  const at = /\bat\s+(.+)$/i.exec(item.title);
  if (at) out.push(at[1].replace(/[·|].*$/, "").trim());
  const stripped = item.title.replace(/[·|].*$/, "").replace(GENERIC, " ").replace(/\s+/g, " ").trim();
  if (stripped.length >= 4 && !out.includes(stripped)) out.push(stripped);
  if (item.vendor) out.push(item.vendor);
  return out.slice(0, 3);
}

async function pinFor(item: ItineraryItem, dest: PlacePin, region: string): Promise<PlacePin> {
  // Flights and the stay default to the destination unless their location resolves nearby.
  if (item.category === "Transport") return { ...dest, precision: "destination" };
  for (const q of placeQueries(item)) {
    const hit = (await photon(`${q} ${region}`, dest)) ?? (await photon(q, dest));
    if (hit && distanceKm(hit, dest) <= 120) return { lat: hit.lat, lon: hit.lon, label: hit.name, precision: "item", source: "openstreetmap (photon)" };
  }
  return { ...dest, precision: "destination" };
}

const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

const poiCache = new Map<string, { at: number; value: { candidates: Candidate[]; note: string; ok: boolean } }>();

/**
 * Real alternative places from OpenStreetMap. Photon (fast OSM search, one
 * query per kind of place) is the main path; the Overpass API — richer tags
 * but often overloaded — is used only when Photon finds too little.
 * Places change slowly: a successful answer is reused for an hour.
 */
async function overpass(point: LatLon, radiusKm: number): Promise<{ candidates: Candidate[]; note: string; ok: boolean }> {
  const key = `${point.lat.toFixed(3)},${point.lon.toFixed(3)},${radiusKm}`;
  const hit = poiCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.value;
  const found = await mapLimit(photonSearches(), 4, (s) => getJson(photonUrl(point, s), {}, 8_000).then((j) => parsePhoton(j, point, radiusKm * 1.8)).catch(() => [] as Candidate[]));
  const byId = new Map<string, Candidate>();
  for (const list of found) for (const c of list) if (![...byId.values()].some((x) => x.name.toLowerCase() === c.name.toLowerCase())) byId.set(c.id, c);
  let value: { candidates: Candidate[]; note: string; ok: boolean };
  if (byId.size >= 3) value = { candidates: [...byId.values()], ok: true, note: `${byId.size} real places from OpenStreetMap (Photon search)` };
  else value = await overpassFetch(point, radiusKm);
  if (value.ok) poiCache.set(key, { at: Date.now(), value });
  return value;
}

async function overpassFetch(point: LatLon, radiusKm: number): Promise<{ candidates: Candidate[]; note: string; ok: boolean }> {
  const data = overpassQuery(point, radiusKm);
  // Race the public mirrors; the first good answer wins.
  try {
    return await Promise.any(
      OVERPASS.map(async (url) => {
        const json = await getJson(url, { method: "POST", body: new URLSearchParams({ data }), headers: { "content-type": "application/x-www-form-urlencoded" } }, 25_000);
        const candidates = parseOverpass(json);
        if (!candidates.length) throw new Error(`${new URL(url).host} returned no places (${String((json as { remark?: string }).remark ?? "empty").slice(0, 60)})`);
        return { candidates, ok: true, note: `${candidates.length} real places from OpenStreetMap (${new URL(url).host})` };
      }),
    );
  } catch (e) {
    const errs = (e as AggregateError).errors?.map((x: Error) => x.message).join("; ") ?? String(e);
    return { candidates: [], ok: false, note: `Overpass unavailable (${errs.slice(0, 120)})` };
  }
}

const clusterKey = (p: LatLon) => `${(Math.round(p.lat * 4) / 4).toFixed(2)},${(Math.round(p.lon * 4) / 4).toFixed(2)}`;

/** Runs `fn` over `items` with at most `limit` in flight (public APIs throttle bursts). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const inflight = new Map<string, Promise<TwinWorld>>();

/** Builds (or reuses) the world; concurrent callers share one in-flight build. */
export function buildWorld(tripId: string, state: TripState, opts: { force?: boolean } = {}): Promise<TwinWorld> {
  const cacheKey = `${tripId}:${state.trip.destination}:${state.itinerary.map((i) => `${i.id}${i.title}${i.location ?? ""}`).join("|")}`;
  const hit = worldCache.get(cacheKey);
  if (!opts.force && hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.world);
  const running = inflight.get(cacheKey);
  if (running) return running;
  const p = assemble(tripId, state, cacheKey).finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, p);
  return p;
}

/** Starts a build in the background (e.g. when a trip is opened) so the Plan tab finds it ready. */
export function prefetchWorld(tripId: string, state: TripState) {
  buildWorld(tripId, state).catch(() => undefined);
}

async function assemble(tripId: string, state: TripState, cacheKey: string): Promise<TwinWorld> {
  const geo = await geocodeDestination(state.trip.destination);
  if (!geo) throw new Error(`Could not locate "${state.trip.destination}" (Open-Meteo geocoding and Nominatim found nothing)`);
  const region = [geo.admin, geo.country].filter(Boolean).join(", ") || state.trip.destination;
  const destination: PlacePin = { lat: geo.lat, lon: geo.lon, label: state.trip.destination, precision: "destination", source: geo.source };

  const live = state.itinerary.filter((i) => i.status !== "cancelled");
  const city = geo.name;
  const ctx: PlaceContext = { city, region: geo.admin, point: destination, names: [city, geo.admin ?? "", ...state.trip.destination.split(",").map((s) => s.trim())].filter((x, i, a) => x && a.indexOf(x) === i) };

  // Independent real sources in parallel: item places, nearby alternatives, news/social/guide.
  const [pins, near, news, social, guide] = await Promise.all([
    Promise.all(live.map(async (item) => [item.id, await pinFor(item, destination, region)] as const)),
    overpass(destination, 10),
    gdeltProvider(ctx),
    mastodonProvider(ctx),
    wikivoyageProvider(ctx),
  ]);
  const places: Record<string, PlacePin> = Object.fromEntries(pins);

  // One forecast per ~25 km cluster: far-off items (a waterfall inland) get their own weather.
  const clusters = new Map<string, { point: LatLon; label: string }>();
  clusters.set(clusterKey(destination), { point: destination, label: destination.label });
  const itemForecast: Record<string, string> = {};
  for (const item of live) {
    const p = places[item.id];
    const k = clusterKey(p);
    if (!clusters.has(k)) clusters.set(k, { point: p, label: p.label });
    itemForecast[item.id] = k;
  }
  // Alternatives are also searched around far-off EXPERIENCES (a waterfall inland), not around airports.
  const experienceKeys = new Set(live.filter((i) => i.category === "Activity" || i.category === "Food" || i.category === "Shopping").map((i) => itemForecast[i.id]));
  const farPoints = [...clusters.entries()].filter(([k, c]) => experienceKeys.has(k) && distanceKm(c.point, destination) > 20).map(([, c]) => c).slice(0, 2);
  const [forecasts, others] = await Promise.all([
    Promise.all(
      [...clusters.entries()].slice(0, 6).map(async ([key, c]): Promise<WorldForecast> => {
        const url = forecastUrl(c.point);
        try {
          return { key, point: c.point, label: c.label, forecast: parseForecast(await getJson(url), c.label, c.point, url) };
        } catch (e) {
          return { key, point: c.point, label: c.label, forecast: null, error: (e as Error).message };
        }
      }),
    ),
    Promise.all(farPoints.map((c) => overpass(c.point, 8))),
  ]);
  for (const [id, k] of Object.entries(itemForecast)) if (!forecasts.some((f) => f.key === k)) itemForecast[id] = forecasts[0].key;

  const byId = new Map<string, Candidate>();
  for (const r of [near, ...others]) for (const c of r.candidates) byId.set(c.id, c);
  let poiNote = near.note;
  if (!near.ok) {
    // Overpass is a shared public service and is often overloaded. Reuse the real OSM places from
    // the last successful capture for this destination, and say so.
    const prev = await loadReplay(state.trip.destination, tripId);
    if (prev?.candidates.length) {
      for (const c of prev.candidates) byId.set(c.id, c);
      poiNote = `Overpass busy now — reusing ${prev.candidates.length} real OSM places captured ${new Date(prev.capturedAt ?? prev.fetchedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    }
  }
  const candidates = [...byId.values()];

  // Ratings are looked up for the places most likely to be recommended: indoor, closest first.
  const shortlist = [...candidates].sort((a, b) => Number(b.indoor) - Number(a.indoor) || distanceKm(a, destination) - distanceKm(b, destination));
  const [views, google] = await Promise.all([pageviewsProvider(shortlist), googlePlacesProvider(shortlist, process.env.GOOGLE_PLACES_API_KEY)]);
  const signals: PublicSignal[] = [...news.signals, ...social.signals, ...guide.signals, ...views.signals, ...google.signals].sort((a, b) => b.relevance - a.relevance);
  const providers: ProviderStatus[] = [
    { source: "openstreetmap", ok: near.ok || candidates.length > 0, configured: true, count: candidates.length, note: poiNote, fetchedAt: Date.now() },
    news.status,
    social.status,
    guide.status,
    views.status,
    google.status,
  ];
  const okWeather = forecasts.filter((f) => f.forecast);
  const world: TwinWorld = {
    tripId,
    mode: "live",
    fetchedAt: Date.now(),
    destination,
    places,
    forecasts,
    itemForecast,
    signals,
    providers,
    candidates,
    ratings: mergeRatings(views.ratings, google.ratings),
    weatherNote: okWeather.length ? `Open-Meteo forecast for ${okWeather.length} location${okWeather.length === 1 ? "" : "s"}, 16-day horizon to ${okWeather[0].forecast!.daily.at(-1)?.date ?? "?"}` : `Weather unavailable: ${forecasts[0]?.error ?? "unknown error"}`,
  };
  worldCache.set(cacheKey, { at: Date.now(), world });
  // Only complete captures are recorded, so a replay always has weather AND places.
  if (okWeather.length && near.ok && candidates.length) await recordReplay(state.trip.destination, world);
  return world;
}

// ---------------------------------------------------------------- judge demo replay (real captured data)

const REPLAY_DIR = path.join(process.cwd(), "data", "replay");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

async function recordReplay(destination: string, world: TwinWorld) {
  if (process.env.VERCEL) return; // read-only filesystem in production; the committed capture is used there
  try {
    await fs.mkdir(REPLAY_DIR, { recursive: true });
    await fs.writeFile(path.join(REPLAY_DIR, `${slug(destination)}.json`), JSON.stringify({ ...world, mode: "replay", capturedAt: world.fetchedAt }, null, 1));
  } catch {
    /* recording is best-effort */
  }
}

export async function loadReplay(destination: string, tripId: string): Promise<TwinWorld | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(REPLAY_DIR, `${slug(destination)}.json`), "utf8")) as TwinWorld;
    return { ...raw, tripId, mode: "replay", capturedAt: raw.capturedAt ?? raw.fetchedAt };
  } catch {
    return null;
  }
}
