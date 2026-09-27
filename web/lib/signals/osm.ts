import type { LatLon } from "@/lib/weather/openmeteo";

/**
 * Real alternative places from OpenStreetMap (Overpass API). OSM gives real,
 * named, geolocated places with tags (indoor, fee, opening hours, wikipedia);
 * it has no ratings — those come from a ratings provider when one is
 * configured. Prices are not in OSM: `estPerPersonPaise` is a planning
 * estimate by kind of place (or ₹0 where OSM says fee=no), always labelled.
 */

export type Candidate = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** OSM feature kind, e.g. "museum", "spa", "bowling_alley". */
  kind: string;
  /** Interest tags (same vocabulary as member preferences). */
  tags: string[];
  indoor: boolean;
  free: boolean;
  estPerPersonPaise: number;
  estimateBasis: string;
  openingHours?: string;
  website?: string;
  wikipedia?: string;
  source: "openstreetmap";
  url: string;
};

type Kind = { key: string; value: string; tags: string[]; indoor: boolean; estRupees: number };

const KINDS: Kind[] = [
  { key: "tourism", value: "museum", tags: ["culture", "indoor"], indoor: true, estRupees: 200 },
  { key: "tourism", value: "gallery", tags: ["culture", "indoor"], indoor: true, estRupees: 150 },
  { key: "tourism", value: "aquarium", tags: ["nature", "indoor"], indoor: true, estRupees: 500 },
  { key: "tourism", value: "theme_park", tags: ["adventure"], indoor: false, estRupees: 1200 },
  { key: "tourism", value: "viewpoint", tags: ["nature", "mountain"], indoor: false, estRupees: 0 },
  { key: "tourism", value: "attraction", tags: ["culture"], indoor: false, estRupees: 200 },
  { key: "leisure", value: "bowling_alley", tags: ["indoor"], indoor: true, estRupees: 700 },
  { key: "leisure", value: "amusement_arcade", tags: ["indoor"], indoor: true, estRupees: 600 },
  { key: "leisure", value: "escape_game", tags: ["indoor", "adventure"], indoor: true, estRupees: 900 },
  { key: "leisure", value: "spa", tags: ["relaxing", "indoor"], indoor: true, estRupees: 1800 },
  { key: "leisure", value: "water_park", tags: ["water", "adventure"], indoor: false, estRupees: 1200 },
  { key: "amenity", value: "spa", tags: ["relaxing", "indoor"], indoor: true, estRupees: 1800 },
  { key: "amenity", value: "cinema", tags: ["indoor"], indoor: true, estRupees: 300 },
  { key: "amenity", value: "theatre", tags: ["culture", "indoor"], indoor: true, estRupees: 500 },
  { key: "amenity", value: "arts_centre", tags: ["culture", "indoor"], indoor: true, estRupees: 300 },
  { key: "amenity", value: "marketplace", tags: ["shopping"], indoor: false, estRupees: 1000 },
  { key: "shop", value: "mall", tags: ["shopping", "indoor"], indoor: true, estRupees: 1000 },
  { key: "historic", value: "fort", tags: ["culture"], indoor: false, estRupees: 50 },
  { key: "historic", value: "castle", tags: ["culture"], indoor: false, estRupees: 50 },
  { key: "historic", value: "church", tags: ["culture", "indoor"], indoor: true, estRupees: 0 },
  { key: "amenity", value: "place_of_worship", tags: ["culture", "indoor"], indoor: true, estRupees: 0 },
  { key: "amenity", value: "restaurant", tags: ["food", "indoor"], indoor: true, estRupees: 900 },
  { key: "amenity", value: "cafe", tags: ["food", "indoor"], indoor: true, estRupees: 450 },
];

/** Overpass QL for named candidate places within `radiusKm` of a point (one regex selector per key keeps it fast). */
export function overpassQuery(p: LatLon, radiusKm: number): string {
  const r = Math.round(radiusKm * 1000);
  const at = `(around:${r},${p.lat.toFixed(5)},${p.lon.toFixed(5)})`;
  const byKey = new Map<string, string[]>();
  for (const k of KINDS) {
    // Worship places and restaurants are everywhere: only notable ones (below).
    if (k.value === "place_of_worship" || k.value === "restaurant" || k.value === "cafe") continue;
    byKey.set(k.key, [...(byKey.get(k.key) ?? []), k.value]);
  }
  const parts = [...byKey.entries()].map(([key, values]) => `nwr["${key}"~"^(${values.join("|")})$"]["name"]${at};`);
  parts.push(`nwr["amenity"="place_of_worship"]["name"]["wikidata"]${at};`);
  parts.push(`nwr["amenity"~"^(restaurant|cafe)$"]["name"]["website"]${at};`);
  return `[out:json][timeout:25];(${parts.join("")});out center 200;`;
}

const safeHttp = (u?: string) => (u && /^https?:\/\//i.test(u) ? u : undefined);

const INDOOR_TRUE = /^(yes|room|area|corridor)$/;

/** Parses an Overpass JSON response into candidates (deduplicated by name). */
export function parseOverpass(json: unknown): Candidate[] {
  const elements = (json as { elements?: Record<string, unknown>[] } | null)?.elements;
  if (!Array.isArray(elements)) return [];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    const tags = (el.tags ?? {}) as Record<string, string>;
    const name = tags["name:en"] || tags.name;
    if (!name) continue;
    const lat = typeof el.lat === "number" ? el.lat : (el.center as { lat?: number } | undefined)?.lat;
    const lon = typeof el.lon === "number" ? el.lon : (el.center as { lon?: number } | undefined)?.lon;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    const kind = KINDS.find((k) => tags[k.key] === k.value);
    if (!kind) continue;
    const key = name.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const indoor = tags.indoor ? INDOOR_TRUE.test(tags.indoor) : tags.building ? true : kind.indoor;
    const free = tags.fee === "no";
    const type = el.type === "way" || el.type === "relation" ? el.type : "node";
    if (!Number.isSafeInteger(el.id)) continue;
    out.push({
      id: `osm:${type}/${String(el.id)}`,
      name,
      lat,
      lon,
      kind: kind.value,
      tags: kind.tags,
      indoor,
      free,
      estPerPersonPaise: free ? 0 : kind.estRupees * 100,
      estimateBasis: free ? "OSM: fee=no" : `planning estimate for a ${kind.value.replace(/_/g, " ")} (not a quoted price)`,
      openingHours: tags.opening_hours,
      website: safeHttp(tags.website || tags["contact:website"]),
      wikipedia: tags.wikipedia,
      source: "openstreetmap",
      url: `https://www.openstreetmap.org/${type}/${String(el.id)}`,
    });
  }
  return out;
}

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/**
 * Best-effort reading of simple OSM opening_hours ("Mo-Su 09:00-18:00",
 * "24/7", "Tu-Su 10:00-17:00; Mo off"). Returns null when the format is
 * beyond this reader — callers treat that as "unknown", not as closed.
 */
export function openAt(openingHours: string | undefined, isoDate: string, hour: number): boolean | null {
  if (!openingHours) return null;
  const oh = openingHours.trim();
  if (oh === "24/7") return true;
  const dow = DAYS[new Date(`${isoDate}T12:00:00Z`).getUTCDay()];
  let matched: boolean | null = null;
  for (const rule of oh.split(";").map((r) => r.trim()).filter(Boolean)) {
    const m = /^((?:[A-Z][a-z](?:-[A-Z][a-z])?,?)+)\s+(off|closed|(?:\d{2}:\d{2}-\d{2}:\d{2},?\s*)+)$/.exec(rule);
    if (!m) {
      const t = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(rule);
      if (t) matched = hour >= Number(t[1]) && hour < Number(t[3]);
      else return null;
      continue;
    }
    const dayHit = m[1].split(",").some((span) => {
      const [a, b] = span.split("-");
      const ia = DAYS.indexOf(a);
      const ib = b ? DAYS.indexOf(b) : ia;
      const id = DAYS.indexOf(dow);
      if (ia < 0 || ib < 0) return false;
      return ia <= ib ? id >= ia && id <= ib : id >= ia || id <= ib;
    });
    if (!dayHit) continue;
    if (/off|closed/.test(m[2])) {
      matched = false;
      continue;
    }
    matched = m[2].split(",").some((range) => {
      const t = /(\d{2}):(\d{2})-(\d{2}):(\d{2})/.exec(range.trim());
      if (!t) return false;
      const end = Number(t[3]) === 0 ? 24 : Number(t[3]);
      return hour >= Number(t[1]) && hour < end;
    });
  }
  return matched;
}

// ---------------------------------------------------------------- Photon (fast OSM search)

const PHOTON_WORD: Record<string, string> = {
  museum: "museum",
  gallery: "gallery",
  aquarium: "aquarium",
  theme_park: "park",
  viewpoint: "viewpoint",
  bowling_alley: "bowling",
  amusement_arcade: "arcade",
  escape_game: "escape",
  spa: "spa",
  water_park: "water park",
  cinema: "cinema",
  theatre: "theatre",
  arts_centre: "arts",
  marketplace: "market",
  mall: "mall",
  fort: "fort",
  place_of_worship: "church",
};

/** The Photon searches (one per OSM kind) used to find real alternatives near a point. */
export function photonSearches(): { key: string; value: string; word: string }[] {
  const seen = new Set<string>();
  return KINDS.filter((k) => PHOTON_WORD[k.value] && !seen.has(`${k.key}:${k.value}`) && seen.add(`${k.key}:${k.value}`)).map((k) => ({ key: k.key, value: k.value, word: PHOTON_WORD[k.value] }));
}

export function photonUrl(p: LatLon, s: { key: string; value: string; word: string }): string {
  return `https://photon.komoot.io/api/?${new URLSearchParams({ q: s.word, lat: String(p.lat), lon: String(p.lon), limit: "8", osm_tag: `${s.key}:${s.value}`, location_bias_scale: "0.1", zoom: "12" })}`;
}

/** Parses a Photon GeoJSON response into candidates within `maxKm` of `near`. */
export function parsePhoton(json: unknown, near: LatLon, maxKm: number): Candidate[] {
  const features = (json as { features?: { geometry?: { coordinates?: number[] }; properties?: Record<string, unknown> }[] } | null)?.features;
  if (!Array.isArray(features)) return [];
  const out: Candidate[] = [];
  for (const f of features) {
    const c = f.geometry?.coordinates;
    const p = f.properties ?? {};
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!c || c.length < 2 || !name) continue;
    const [lon, lat] = c;
    const dLat = ((lat - near.lat) * Math.PI) / 180;
    const dLon = ((lon - near.lon) * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos((near.lat * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    if (2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h))) > maxKm) continue;
    const kind = KINDS.find((k) => k.key === p.osm_key && k.value === p.osm_value);
    if (!kind) continue;
    const type = p.osm_type === "W" ? "way" : p.osm_type === "R" ? "relation" : "node";
    if (!Number.isSafeInteger(p.osm_id)) continue;
    out.push({
      id: `osm:${type}/${String(p.osm_id)}`,
      name,
      lat,
      lon,
      kind: kind.value,
      tags: kind.tags,
      indoor: kind.indoor,
      free: false,
      estPerPersonPaise: kind.estRupees * 100,
      estimateBasis: `planning estimate for a ${kind.value.replace(/_/g, " ")} (not a quoted price)`,
      source: "openstreetmap",
      url: `https://www.openstreetmap.org/${type}/${String(p.osm_id)}`,
    });
  }
  return out;
}
