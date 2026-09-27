import type { LatLon } from "@/lib/weather/openmeteo";
import type { Candidate } from "./osm";
import { relevanceOf, sentimentOf, stripHtml, weatherTermsIn } from "./score";
import type { PlaceRatings, ProviderStatus, PublicSignal, SignalSource } from "./types";

/**
 * Public-signal providers. Each one talks to a real public source and returns
 * signals plus an honest status line. Parsers are pure (unit-tested); fetchers
 * take `fetch` as a parameter so API failures can be tested too.
 *
 *  - GDELT DOC 2.0     real news articles (public reports, emerging conditions) · no key
 *  - Mastodon          real public posts from tag timelines (traveller chatter) · no key
 *  - Wikivoyage        the destination's real travel-guide text (climate / stay-safe) · no key
 *  - Wikipedia views   real page-view trend for alternative places (interest trend) · no key
 *  - Google Places     real ratings, review counts and recent reviews · GOOGLE_PLACES_API_KEY
 */

export type Fetch = typeof fetch;
export type ProviderResult = { signals: PublicSignal[]; status: ProviderStatus };
export type PlaceContext = { city: string; region?: string; point: LatLon; names: string[] };

const UA = "GroupTripLedger/1.0 (+https://github.com/sswayamshheth/trip-pool)";

async function getJson(fetchImpl: Fetch, url: string, init: RequestInit = {}, timeoutMs = 12_000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, headers: { "user-agent": UA, accept: "application/json", ...(init.headers ?? {}) }, signal: ctrl.signal, cache: "no-store" });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Not JSON: ${text.slice(0, 120)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

const status = (source: SignalSource, ok: boolean, configured: boolean, count: number, note: string): ProviderStatus => ({ source, ok, configured, count, note, fetchedAt: Date.now() });

// ---------------------------------------------------------------- GDELT news

/** GDELT seendate "20260924T074500Z" → ms. */
export function parseGdeltDate(s: unknown): number | null {
  const m = typeof s === "string" ? /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s) : null;
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

export function parseGdelt(json: unknown, ctx: PlaceContext, now = Date.now()): PublicSignal[] {
  const arts = (json as { articles?: Record<string, unknown>[] } | null)?.articles;
  if (!Array.isArray(arts)) return [];
  const seen = new Set<string>();
  return arts.flatMap((a, i): PublicSignal[] => {
    const title = typeof a.title === "string" ? a.title.trim() : "";
    const url = typeof a.url === "string" ? a.url : undefined;
    if (!title || !url || seen.has(title)) return [];
    seen.add(title);
    const ts = parseGdeltDate(a.seendate);
    const relevance = relevanceOf(title, ctx.names, ts, now);
    return [
      {
        id: `gdelt:${i}:${url.slice(-40)}`,
        source: "gdelt-news",
        kind: "news",
        url,
        timestamp: ts,
        location: { name: ctx.city, lat: ctx.point.lat, lon: ctx.point.lon },
        title,
        summary: `${title}${typeof a.domain === "string" ? ` — ${a.domain}` : ""}`,
        sentiment: sentimentOf(title),
        relevance,
        confidence: 0.7,
        weatherTerms: weatherTermsIn(title),
      },
    ];
  });
}

export function gdeltUrl(ctx: PlaceContext): string {
  const place = ctx.names.slice(0, 2).map((n) => (n.includes(" ") ? `"${n}"` : n));
  const q = `(${place.join(" OR ")}) (rain OR flood OR storm OR weather OR monsoon OR landslide OR tourists OR beach)`;
  return `https://api.gdeltproject.org/api/v2/doc/doc?${new URLSearchParams({ query: q, mode: "artlist", maxrecords: "25", format: "json", timespan: "7d", sort: "datedesc" })}`;
}

export async function gdeltProvider(ctx: PlaceContext, fetchImpl: Fetch = fetch): Promise<ProviderResult> {
  try {
    const json = await getJson(fetchImpl, gdeltUrl(ctx));
    const signals = parseGdelt(json, ctx).filter((s) => s.relevance > 0);
    return { signals, status: status("gdelt-news", true, true, signals.length, signals.length ? "Real news from the last 7 days" : "No matching news in the last 7 days") };
  } catch (e) {
    return { signals: [], status: status("gdelt-news", false, true, 0, `GDELT unavailable: ${(e as Error).message.slice(0, 100)}`) };
  }
}

// ---------------------------------------------------------------- Mastodon public posts

export function parseMastodon(json: unknown, ctx: PlaceContext, instance: string, now = Date.now()): PublicSignal[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((p: Record<string, unknown>): PublicSignal[] => {
    if (p.visibility !== "public" || p.sensitive === true) return [];
    const text = stripHtml(String(p.content ?? ""));
    if (text.length < 20) return [];
    const ts = typeof p.created_at === "string" ? Date.parse(p.created_at) : null;
    const relevance = relevanceOf(`${text} ${ctx.names[0]}`, ctx.names, ts, now) * (weatherTermsIn(text).length || /travel|trip|beach|tourist|visit/i.test(text) ? 1 : 0.4);
    return [
      {
        id: `mastodon:${String(p.id)}`,
        source: "mastodon",
        kind: "social-post",
        url: typeof p.url === "string" ? p.url : undefined,
        timestamp: ts,
        location: { name: ctx.city },
        summary: text.slice(0, 280),
        sentiment: sentimentOf(text),
        relevance: Math.round(relevance * 100) / 100,
        confidence: 0.35,
        weatherTerms: weatherTermsIn(text),
      },
    ];
  });
}

export async function mastodonProvider(ctx: PlaceContext, fetchImpl: Fetch = fetch, instance = "mastodon.social"): Promise<ProviderResult> {
  const tag = ctx.city.toLowerCase().replace(/[^a-z0-9]/g, "");
  try {
    const json = await getJson(fetchImpl, `https://${instance}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=40`);
    const signals = parseMastodon(json, ctx, instance).filter((s) => s.relevance >= 0.3);
    return { signals, status: status("mastodon", true, true, signals.length, signals.length ? `Public #${tag} posts on ${instance}` : `No relevant public #${tag} posts right now`) };
  } catch (e) {
    return { signals: [], status: status("mastodon", false, true, 0, `Mastodon unavailable: ${(e as Error).message.slice(0, 100)}`) };
  }
}

// ---------------------------------------------------------------- Wikivoyage guide

export function parseWikivoyage(json: unknown, ctx: PlaceContext): PublicSignal[] {
  const pages = (json as { query?: { pages?: Record<string, { title?: string; extract?: string; missing?: string; fullurl?: string; touched?: string }> } } | null)?.query?.pages;
  if (!pages) return [];
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined || !page.extract) return [];
  const sentences = page.extract.replace(/\n+/g, " ").split(/(?<=[.!?])\s+/);
  const hits = sentences.filter((s) => /monsoon|rain|storm|flood|season|climate|sea is|rough|landslide|heat/i.test(s)).slice(0, 3);
  if (!hits.length) return [];
  return [
    {
      id: `wikivoyage:${page.title}`,
      source: "wikivoyage",
      kind: "travel-guide",
      url: page.fullurl ?? `https://en.wikivoyage.org/wiki/${encodeURIComponent(page.title ?? ctx.city)}`,
      timestamp: page.touched ? Date.parse(page.touched) : null,
      location: { name: page.title ?? ctx.city, lat: ctx.point.lat, lon: ctx.point.lon },
      title: `Wikivoyage: ${page.title}`,
      summary: hits.join(" ").slice(0, 400),
      sentiment: sentimentOf(hits.join(" ")),
      relevance: 0.5,
      confidence: 0.6,
      weatherTerms: weatherTermsIn(hits.join(" ")),
    },
  ];
}

export async function wikivoyageProvider(ctx: PlaceContext, fetchImpl: Fetch = fetch): Promise<ProviderResult> {
  const titles = [ctx.city, ctx.region].filter(Boolean) as string[];
  try {
    for (const t of titles) {
      const url = `https://en.wikivoyage.org/w/api.php?${new URLSearchParams({ action: "query", prop: "extracts|info", inprop: "url", explaintext: "1", redirects: "1", titles: t, format: "json" })}`;
      const signals = parseWikivoyage(await getJson(fetchImpl, url), ctx);
      if (signals.length) return { signals, status: status("wikivoyage", true, true, signals.length, `Travel guide: ${t}`) };
    }
    return { signals: [], status: status("wikivoyage", true, true, 0, "Guide has no climate notes for this place") };
  } catch (e) {
    return { signals: [], status: status("wikivoyage", false, true, 0, `Wikivoyage unavailable: ${(e as Error).message.slice(0, 100)}`) };
  }
}

// ---------------------------------------------------------------- Wikipedia page-view trend

export function parsePageviews(json: unknown): { total: number; trend: number } | null {
  const items = (json as { items?: { views?: number }[] } | null)?.items;
  if (!Array.isArray(items) || items.length < 4) return null;
  const views = items.map((i) => (typeof i.views === "number" ? i.views : 0));
  const half = Math.floor(views.length / 2);
  const early = views.slice(0, half).reduce((a, b) => a + b, 0);
  const late = views.slice(half).reduce((a, b) => a + b, 0);
  const total = early + late;
  return { total, trend: early > 0 ? Math.round((late / early - 1) * 100) / 100 : 0 };
}

const ymd = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

export async function pageviewsProvider(candidates: Candidate[], fetchImpl: Fetch = fetch, now = Date.now()): Promise<ProviderResult & { ratings: Record<string, PlaceRatings> }> {
  const withWiki = candidates.filter((c) => c.wikipedia && /^en:/.test(c.wikipedia)).slice(0, 12);
  const ratings: Record<string, PlaceRatings> = {};
  const signals: PublicSignal[] = [];
  let failures = 0;
  const end = new Date(now - 86_400_000);
  const start = new Date(now - 31 * 86_400_000);
  await Promise.all(
    withWiki.map(async (c) => {
      const article = c.wikipedia!.slice(3).replace(/ /g, "_");
      const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(article)}/daily/${ymd(start)}/${ymd(end)}`;
      try {
        const pv = parsePageviews(await getJson(fetchImpl, url, {}, 8000));
        if (!pv) return;
        const id = `pageviews:${c.id}`;
        ratings[c.id] = { placeRef: c.id, pageviews30d: pv.total, pageviewTrend: pv.trend, signalIds: [id] };
        signals.push({
          id,
          source: "wikipedia-pageviews",
          kind: "trend",
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(article)}`,
          timestamp: end.getTime(),
          location: { name: c.name, lat: c.lat, lon: c.lon },
          placeRef: c.id,
          summary: `${pv.total.toLocaleString("en-IN")} Wikipedia views in 30 days, ${pv.trend >= 0 ? "+" : ""}${Math.round(pv.trend * 100)}% in the last 15 days`,
          relevance: 0.4,
          confidence: 0.5,
        });
      } catch {
        failures++;
      }
    }),
  );
  const ok = failures < withWiki.length || withWiki.length === 0;
  return { signals, ratings, status: status("wikipedia-pageviews", ok, true, signals.length, withWiki.length ? `Interest trend for ${signals.length} of ${withWiki.length} places with a Wikipedia article` : "No nearby alternative has a Wikipedia article") };
}

// ---------------------------------------------------------------- Google Places ratings & reviews

type GPlace = { id?: string; displayName?: { text?: string }; rating?: number; userRatingCount?: number; location?: { latitude?: number; longitude?: number }; googleMapsUri?: string; reviews?: { rating?: number; publishTime?: string; text?: { text?: string }; relativePublishTimeDescription?: string }[] };

export function parseGooglePlace(json: unknown, candidate: Candidate, now = Date.now()): { ratings: PlaceRatings; signals: PublicSignal[] } | null {
  const place = (json as { places?: GPlace[] } | null)?.places?.[0];
  if (!place || typeof place.rating !== "number") return null;
  const lat = place.location?.latitude;
  const lon = place.location?.longitude;
  // Guard against a same-name place elsewhere: must be within ~2 km of the OSM point.
  if (typeof lat === "number" && typeof lon === "number" && (Math.abs(lat - candidate.lat) > 0.02 || Math.abs(lon - candidate.lon) > 0.02)) return null;
  const signals: PublicSignal[] = [];
  const ratingId = `gplaces:${place.id ?? candidate.id}`;
  signals.push({
    id: ratingId,
    source: "google-places",
    kind: "rating",
    url: place.googleMapsUri,
    timestamp: now,
    location: { name: place.displayName?.text ?? candidate.name, lat: candidate.lat, lon: candidate.lon },
    placeRef: candidate.id,
    rating: place.rating,
    reviewCount: place.userRatingCount ?? 0,
    summary: `${place.rating.toFixed(1)}★ from ${(place.userRatingCount ?? 0).toLocaleString("en-IN")} Google reviews`,
    relevance: 0.8,
    confidence: Math.min(0.95, 0.4 + Math.log10(1 + (place.userRatingCount ?? 0)) / 6),
  });
  const sentiments: number[] = [];
  let latest = 0;
  for (const [i, r] of (place.reviews ?? []).entries()) {
    const text = r.text?.text?.trim();
    if (!text) continue;
    const ts = r.publishTime ? Date.parse(r.publishTime) : null;
    if (ts && ts > latest) latest = ts;
    const s = sentimentOf(text);
    sentiments.push(s);
    signals.push({
      id: `${ratingId}:review:${i}`,
      source: "google-places",
      kind: "review",
      url: place.googleMapsUri,
      timestamp: ts,
      location: { name: place.displayName?.text ?? candidate.name, lat: candidate.lat, lon: candidate.lon },
      placeRef: candidate.id,
      rating: r.rating,
      summary: text.slice(0, 240),
      sentiment: s,
      relevance: ts && now - ts < 90 * 86_400_000 ? 0.7 : 0.45,
      confidence: 0.5,
      weatherTerms: weatherTermsIn(text),
    });
  }
  return {
    ratings: {
      placeRef: candidate.id,
      rating: place.rating,
      reviewCount: place.userRatingCount ?? 0,
      recentSentiment: sentiments.length ? Math.round((sentiments.reduce((a, b) => a + b, 0) / sentiments.length) * 100) / 100 : undefined,
      latestReviewAt: latest || undefined,
      signalIds: signals.map((s) => s.id),
    },
    signals,
  };
}

export async function googlePlacesProvider(candidates: Candidate[], apiKey: string | undefined, fetchImpl: Fetch = fetch): Promise<ProviderResult & { ratings: Record<string, PlaceRatings> }> {
  if (!apiKey) return { signals: [], ratings: {}, status: status("google-places", false, false, 0, "Ratings & reviews need GOOGLE_PLACES_API_KEY (Places API New). Not configured — no ratings shown, none invented.") };
  const ratings: Record<string, PlaceRatings> = {};
  const signals: PublicSignal[] = [];
  let failures = 0;
  let lastError = "";
  await Promise.all(
    candidates.slice(0, 10).map(async (c) => {
      try {
        const json = await getJson(fetchImpl, "https://places.googleapis.com/v1/places:searchText", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "places.id,places.displayName,places.rating,places.userRatingCount,places.location,places.googleMapsUri,places.reviews" },
          body: JSON.stringify({ textQuery: c.name, locationBias: { circle: { center: { latitude: c.lat, longitude: c.lon }, radius: 1500 } }, maxResultCount: 1 }),
        });
        const parsed = parseGooglePlace(json, c);
        if (parsed) {
          ratings[c.id] = parsed.ratings;
          signals.push(...parsed.signals);
        }
      } catch (e) {
        failures++;
        lastError = (e as Error).message;
      }
    }),
  );
  const ok = failures === 0 || Object.keys(ratings).length > 0;
  return { signals, ratings, status: status("google-places", ok, true, Object.keys(ratings).length, ok ? `Live ratings for ${Object.keys(ratings).length} places` : `Google Places failed: ${lastError.slice(0, 100)}`) };
}

/** Merges two ratings maps (Google + page views) per place. */
export function mergeRatings(...maps: Record<string, PlaceRatings>[]): Record<string, PlaceRatings> {
  const out: Record<string, PlaceRatings> = {};
  for (const m of maps) {
    for (const [k, v] of Object.entries(m)) {
      const prev = out[k];
      out[k] = prev ? { ...prev, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)), signalIds: [...prev.signalIds, ...v.signalIds] } : v;
    }
  }
  return out;
}
