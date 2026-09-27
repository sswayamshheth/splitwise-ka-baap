import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildGoaEvents } from "@/lib/ledger/demo-goa";
import { computeLedger } from "@/lib/ledger/engine";
import { reduceEvents } from "@/lib/ledger/reduce";
import { nugenChat, nugenConfig } from "@/lib/nugen/client";
import { buildDataset } from "@/lib/nugen/dataset";
import { adaptToWeather, explain, scenarioFromText } from "@/lib/nugen/intelligence";
import { extractJson, ungroundedNumbers, validateAdaptation, validateExplanation, validateScenarioOutput } from "@/lib/nugen/schemas";
import { openAt, parseOverpass, parsePhoton } from "@/lib/signals/osm";
import { gdeltProvider, googlePlacesProvider, mastodonProvider, parseGdelt, parseGdeltDate, parseGooglePlace, parseMastodon, parsePageviews, parseWikivoyage } from "@/lib/signals/providers";
import { ratingScore, relevanceOf, sentimentOf, stripHtml, weatherTermsIn } from "@/lib/signals/score";
import { assess, betterSlot, dayRainHazard, imdCategory, profileOf, slotsFor } from "@/lib/twin/impact";
import { explainDeterministic, factsFor, intentOf } from "@/lib/twin/explain";
import { parseScenarioText } from "@/lib/twin/parse-scenario";
import { EMPTY_SCENARIO, simulatedDay, validateScenario, type Scenario } from "@/lib/twin/scenario";
import { buildTwin, newsPressureOf, primaryPerItem, type PlacePin, type TwinWorld } from "@/lib/twin/twin";
import { parseForecast, parseGeocode, WeatherParseError, type WeatherDay } from "@/lib/weather/openmeteo";

// ---------------------------------------------------------------- fixtures

const NOW = Date.UTC(2026, 8, 27, 6, 0, 0);
const events = buildGoaEvents(NOW);
const state = reduceEvents(events)!;
const S = state.trip.startDate;
const day = (n: number) => new Date(Date.parse(`${S}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** A real Open-Meteo-shaped payload (structure copied from a live response). */
function openMeteo(dates: string[], rain: number[], hourlyRain?: (h: number, d: number) => number) {
  const hourly = { time: [] as string[], precipitation: [] as number[], precipitation_probability: [] as number[], weather_code: [] as number[], wind_speed_10m: [] as number[], temperature_2m: [] as number[] };
  dates.forEach((d, di) => {
    for (let h = 0; h < 24; h++) {
      hourly.time.push(`${d}T${String(h).padStart(2, "0")}:00`);
      hourly.precipitation.push(hourlyRain ? hourlyRain(h, di) : rain[di] / 24);
      hourly.precipitation_probability.push(rain[di] > 5 ? 90 : 20);
      hourly.weather_code.push(rain[di] > 60 ? 65 : rain[di] > 5 ? 61 : 1);
      hourly.wind_speed_10m.push(10);
      hourly.temperature_2m.push(28);
    }
  });
  return {
    latitude: 15.5,
    longitude: 73.76,
    timezone: "Asia/Kolkata",
    current: { time: `${dates[0]}T06:00`, temperature_2m: 26, precipitation: 0, weather_code: 1, wind_speed_10m: 5 },
    daily: {
      time: dates,
      precipitation_sum: rain,
      precipitation_probability_max: rain.map((r) => (r > 5 ? 90 : 20)),
      precipitation_hours: rain.map((r) => (r > 0 ? 12 : 0)),
      weather_code: rain.map((r) => (r > 60 ? 65 : r > 5 ? 61 : 1)),
      temperature_2m_max: rain.map(() => 30),
      temperature_2m_min: rain.map(() => 24),
      wind_speed_10m_max: rain.map(() => 12),
      wind_gusts_10m_max: rain.map(() => 20),
    },
    hourly,
  };
}

const tripDates = [0, 1, 2, 3, 4].map(day);
const P = { lat: 15.518, lon: 73.763 };

function world(rain: number[], extra: Partial<TwinWorld> = {}): TwinWorld {
  const forecast = parseForecast(openMeteo(tripDates, rain), "Candolim", P, "https://api.open-meteo.com/v1/forecast?test", NOW);
  const places: Record<string, PlacePin> = Object.fromEntries(state.itinerary.map((i) => [i.id, { ...P, label: "Candolim", precision: "destination" as const, source: "test" }]));
  places.it_scuba = { lat: 15.468, lon: 73.881, label: "Grande Island", precision: "item" as const, source: "test" };
  return {
    tripId: state.trip.id,
    mode: "live",
    fetchedAt: NOW,
    destination: { ...P, label: "Candolim, North Goa", precision: "destination", source: "test" },
    places,
    forecasts: [{ key: "k", point: P, label: "Candolim", forecast }],
    itemForecast: Object.fromEntries(state.itinerary.map((i) => [i.id, "k"])),
    signals: [],
    providers: [],
    candidates: [
      { id: "osm:node/1", name: "Museum of Goa", lat: 15.53, lon: 73.77, kind: "museum", tags: ["culture", "indoor"], indoor: true, free: false, estPerPersonPaise: 20000, estimateBasis: "estimate", source: "openstreetmap", url: "https://www.openstreetmap.org/node/1" },
      { id: "osm:node/2", name: "Candolim Bowling", lat: 15.52, lon: 73.765, kind: "bowling_alley", tags: ["indoor"], indoor: true, free: false, estPerPersonPaise: 70000, estimateBasis: "estimate", source: "openstreetmap", url: "https://www.openstreetmap.org/node/2" },
      { id: "osm:node/3", name: "Aguada Viewpoint", lat: 15.49, lon: 73.77, kind: "viewpoint", tags: ["nature", "mountain"], indoor: false, free: true, estPerPersonPaise: 0, estimateBasis: "fee=no", source: "openstreetmap", url: "https://www.openstreetmap.org/node/3" },
    ],
    ratings: {},
    weatherNote: "test",
    ...extra,
  };
}

const heavy: Scenario = { ...EMPTY_SCENARIO, date: day(1), rainfallMm: 100, stormStartHour: 6, stormHours: 10 };

// ---------------------------------------------------------------- weather parsing

describe("weather parsing (Open-Meteo)", () => {
  it("parses daily, hourly and current blocks", () => {
    const f = parseForecast(openMeteo(tripDates, [0, 26.4, 3, 0, 0]), "Candolim", P, "u", NOW);
    expect(f.daily).toHaveLength(5);
    expect(f.daily[1].precipitationMm).toBe(26.4);
    expect(f.daily[1].hours).toHaveLength(24);
    expect(f.current?.temperatureC).toBe(26);
    expect(f.source).toBe("open-meteo");
  });
  it("rejects malformed payloads and API errors instead of guessing", () => {
    expect(() => parseForecast(null, "x", P, "u")).toThrow(WeatherParseError);
    expect(() => parseForecast({ error: true, reason: "bad lat" }, "x", P, "u")).toThrow(/bad lat/);
    expect(() => parseForecast({ daily: {} }, "x", P, "u")).toThrow(/daily/);
  });
  it("drops days with missing core values", () => {
    const raw = openMeteo(tripDates.slice(0, 2), [1, 2]);
    (raw.daily.precipitation_sum as (number | null)[])[1] = null;
    expect(parseForecast(raw, "x", P, "u").daily).toHaveLength(1);
  });
  it("parses geocoding", () => {
    expect(parseGeocode({ results: [{ name: "Candolim", latitude: 15.5, longitude: 73.7, admin1: "Goa", country: "India" }] }, "Candolim")).toMatchObject({ lat: 15.5, admin: "Goa" });
    expect(parseGeocode({}, "nowhere")).toBeNull();
  });
});

// ---------------------------------------------------------------- weather impact

describe("weather impact", () => {
  it("classifies items by sensitivity profile", () => {
    const by = (id: string) => profileOf(state.itinerary.find((i) => i.id === id)!);
    expect(by("it_scuba")).toBe("sea-water");
    expect(by("it_villa")).toBe("stay");
    expect(by("it_scooters")).toBe("two-wheeler");
    expect(by("it_flight_out")).toBe("air");
    expect(by("it_dinner")).toBe("indoor");
  });
  it("uses IMD rain categories", () => {
    expect(imdCategory(10)).toBe("light rain");
    expect(imdCategory(100)).toBe("heavy rain");
    expect(dayRainHazard(0)).toBe(0);
    expect(dayRainHazard(130)).toBeGreaterThan(dayRainHazard(70));
  });
  it("scuba is unavailable at 100 mm but fine at 2 mm; indoor dinner stays open", () => {
    const scuba = state.itinerary.find((i) => i.id === "it_scuba")!;
    const dinner = state.itinerary.find((i) => i.id === "it_dinner")!;
    const wet = parseForecast(openMeteo([day(1)], [100]), "x", P, "u").daily[0];
    const dry = parseForecast(openMeteo([day(1)], [2]), "x", P, "u").daily[0];
    const a = assess(scuba, { source: "simulated", day: wet, leadDays: 2 });
    expect(a.availability).toBe("unavailable");
    expect(a.level).toBe("High");
    expect(a.components.map((c) => c.label)).toContain("Weather severity");
    expect(assess(scuba, { source: "live-forecast", day: dry, leadDays: 2 }).availability).toBe("open");
    expect(assess(dinner, { source: "simulated", day: wet, leadDays: 2 }).availability).toBe("open");
  });
  it("no forecast → unknown, never guessed", () => {
    const a = assess(state.itinerary[0], { source: "no-data", day: null, leadDays: 20 });
    expect(a.availability).toBe("unknown");
    expect(a.impactScore).toBe(0);
  });
  it("heat makes outdoor plans risky", () => {
    const d: WeatherDay = { date: day(1), precipitationMm: 0, precipitationProbability: 5, precipitationHours: 0, tempMaxC: 44, tempMinC: 30, windMaxKmh: 8, gustMaxKmh: 12, weatherCode: 0 };
    expect(assess({ title: "Dudhsagar falls jeep safari", category: "Activity" }, { source: "simulated", day: d, leadDays: 1 }).availability).not.toBe("open");
  });
  it("time-based adaptation finds a drier afternoon slot", () => {
    const d = parseForecast(openMeteo([day(1)], [40], (h) => (h < 12 ? 10 : 0)), "x", P, "u").daily[0];
    const item = { title: "Fontainhas heritage walk", category: "Activity" as const, time: "09:00" };
    const c = { source: "live-forecast" as const, day: d, leadDays: 1 };
    const slots = slotsFor(item, c);
    expect(slots.length).toBeGreaterThan(3);
    const best = betterSlot(slots, assess(item, c));
    expect(best?.start).toBeGreaterThanOrEqual(12);
  });
});

// ---------------------------------------------------------------- public signals

describe("public signal processing", () => {
  const ctx = { city: "Candolim", region: "Goa", point: P, names: ["Candolim", "Goa"] };
  it("scores sentiment and weather terms from the text", () => {
    expect(sentimentOf("Beautiful beach, loved it, great food")).toBeGreaterThan(0.5);
    expect(sentimentOf("Road flooded, tourists stranded, ferry suspended")).toBeLessThan(-0.5);
    expect(sentimentOf("not good")).toBeLessThan(0);
    expect(weatherTermsIn("IMD orange alert: heavy rain in Goa")).toEqual(expect.arrayContaining(["heavy rain", "orange alert"]));
    expect(stripHtml("<p>Rain in <b>Goa</b> &amp; more</p>")).toBe("Rain in Goa & more");
  });
  it("relevance needs the place, rises with weather/travel words, decays with age", () => {
    expect(relevanceOf("Mumbai rains", ["Goa"], NOW, NOW)).toBe(0);
    const fresh = relevanceOf("Heavy rain lashes Goa, tourists stay indoors", ["Goa"], NOW, NOW);
    const old = relevanceOf("Heavy rain lashes Goa, tourists stay indoors", ["Goa"], NOW - 20 * 86_400_000, NOW);
    expect(fresh).toBe(1);
    expect(old).toBeLessThan(fresh);
  });
  it("parses GDELT news with source, timestamp, location and relevance", () => {
    const s = parseGdelt({ articles: [{ url: "https://news.example/goa-rain", title: "Goa Heavy Rainfall Alert: tourists advised to avoid beaches", seendate: "20260924T074500Z", domain: "news.example" }] }, ctx, NOW);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ source: "gdelt-news", kind: "news", url: "https://news.example/goa-rain", timestamp: parseGdeltDate("20260924T074500Z") });
    expect(s[0].relevance).toBeGreaterThan(0.5);
    expect(s[0].weatherTerms).toContain("rain");
    expect(parseGdelt({ nope: 1 }, ctx)).toEqual([]);
  });
  it("parses Mastodon public posts only", () => {
    const posts = [
      { id: "1", visibility: "public", sensitive: false, created_at: new Date(NOW).toISOString(), url: "https://m/1", content: "<p>Heavy rain in Candolim today, beach shacks closed</p>" },
      { id: "2", visibility: "unlisted", content: "<p>Rain in Candolim trip</p>" },
    ];
    const s = parseMastodon(posts, ctx, "mastodon.social", NOW);
    expect(s).toHaveLength(1);
    expect(s[0].sentiment).toBeLessThan(0);
  });
  it("keeps only climate sentences from Wikivoyage", () => {
    const s = parseWikivoyage({ query: { pages: { "1": { title: "Candolim", extract: "Candolim is a village. Most shacks close during the monsoon. Enjoy the beach." } } } }, ctx);
    expect(s[0].summary).toMatch(/monsoon/);
    expect(s[0].summary).not.toMatch(/village/);
  });
  it("computes a page-view trend", () => {
    const items = [...Array(15).fill({ views: 10 }), ...Array(15).fill({ views: 20 })];
    expect(parsePageviews({ items })).toEqual({ total: 450, trend: 1 });
    expect(parsePageviews({ items: [] })).toBeNull();
  });
  it("parses OSM Overpass and Photon places", () => {
    const c = parseOverpass({ elements: [{ type: "node", id: 5, lat: 15.5, lon: 73.7, tags: { tourism: "museum", name: "Museum of Goa", opening_hours: "Tu-Su 10:00-18:00", fee: "no" } }, { type: "node", id: 6, lat: 1, lon: 1, tags: { tourism: "museum" } }] });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ indoor: true, free: true, estPerPersonPaise: 0 });
    const ph = parsePhoton({ features: [{ geometry: { coordinates: [73.77, 15.53] }, properties: { name: "Museum of Goa", osm_key: "tourism", osm_value: "museum", osm_type: "N", osm_id: 9 } }, { geometry: { coordinates: [0, 0] }, properties: { name: "Far", osm_key: "tourism", osm_value: "museum", osm_type: "N", osm_id: 10 } }] }, P, 20);
    expect(ph.map((x) => x.name)).toEqual(["Museum of Goa"]);
  });
  it("reads simple opening hours and says unknown otherwise", () => {
    const monday = "2026-10-12";
    expect(openAt("Tu-Su 10:00-18:00; Mo off", monday, 11)).toBe(false);
    expect(openAt("Mo-Su 09:00-18:00", monday, 11)).toBe(true);
    expect(openAt("24/7", monday, 3)).toBe(true);
    expect(openAt("sunrise-sunset", monday, 11)).toBeNull();
  });
  it("news pressure comes only from recent, relevant, weather-related reports", () => {
    const sig = { id: "a", source: "gdelt-news" as const, kind: "news" as const, timestamp: NOW, location: { name: "Goa" }, summary: "flood", relevance: 1, confidence: 0.7, sentiment: -1, weatherTerms: ["flood"] };
    expect(newsPressureOf([sig], NOW)).toBeGreaterThan(0);
    expect(newsPressureOf([{ ...sig, timestamp: NOW - 10 * 86_400_000 }], NOW)).toBe(0);
  });
});

// ---------------------------------------------------------------- ratings & reviews

describe("rating / review integration", () => {
  const cand = world([0, 0, 0, 0, 0]).candidates[0];
  it("Bayesian rating: many reviews beat a handful of perfect ones", () => {
    expect(ratingScore(4.6, 2000)!).toBeGreaterThan(ratingScore(5, 3)!);
    expect(ratingScore(undefined, 10)).toBeNull();
  });
  it("parses Google Places ratings and recent reviews, rejecting far-away name matches", () => {
    const place = { places: [{ id: "g1", displayName: { text: "Museum of Goa" }, rating: 4.6, userRatingCount: 3120, location: { latitude: 15.531, longitude: 73.771 }, googleMapsUri: "https://maps.google.com/?cid=1", reviews: [{ rating: 5, publishTime: new Date(NOW).toISOString(), text: { text: "Amazing art, great on a rainy day" } }] }] };
    const r = parseGooglePlace(place, cand, NOW)!;
    expect(r.ratings).toMatchObject({ rating: 4.6, reviewCount: 3120 });
    expect(r.ratings.recentSentiment).toBeGreaterThan(0);
    expect(r.signals.map((s) => s.kind)).toEqual(["rating", "review"]);
    const far = { places: [{ ...place.places[0], location: { latitude: 19, longitude: 72.8 } }] };
    expect(parseGooglePlace(far, cand, NOW)).toBeNull();
  });
  it("without a key the ratings provider returns nothing and says so (no invented ratings)", async () => {
    const r = await googlePlacesProvider([cand], undefined);
    expect(r.signals).toEqual([]);
    expect(r.status).toMatchObject({ configured: false, ok: false });
  });
  it("ratings change which alternative wins, but do not override weather", () => {
    const base = world([0, 0, 0, 0, 0]);
    const plain = buildTwin(state, events, base, heavy, { now: NOW });
    const rated = buildTwin(state, events, { ...base, ratings: { "osm:node/2": { placeRef: "osm:node/2", rating: 4.8, reviewCount: 4000, recentSentiment: 0.9, signalIds: [] }, "osm:node/1": { placeRef: "osm:node/1", rating: 3.1, reviewCount: 900, recentSentiment: -0.6, signalIds: [] } } }, heavy, { now: NOW });
    const pick = (t: typeof plain) => primaryPerItem(t.recommendations).find((r) => r.forItemId === "it_scuba" && r.kind === "replace")?.alternative?.candidate.id;
    expect(pick(rated)).toBe("osm:node/2");
    expect(pick(plain)).toBeDefined();
    // The outdoor viewpoint never wins in heavy rain, whatever its rating.
    const outdoor = buildTwin(state, events, { ...base, ratings: { "osm:node/3": { placeRef: "osm:node/3", rating: 5, reviewCount: 50000, recentSentiment: 1, signalIds: [] } } }, heavy, { now: NOW });
    expect(pick(outdoor)).not.toBe("osm:node/3");
  });
});

// ---------------------------------------------------------------- digital twin / recommendations / what-if

describe("digital twin", () => {
  it("normal weather: real twin, nothing at risk, no recommendations", () => {
    const t = buildTwin(state, events, world([0, 1, 0, 0, 0]), null, { now: NOW });
    expect(t.mode).toBe("real");
    expect(t.headline.normal).toBe(true);
    expect(t.recommendations).toHaveLength(0);
  });
  it("live heavy rain in the forecast affects the real plan and recommends an indoor alternative", () => {
    const t = buildTwin(state, events, world([0, 120, 0, 0, 0]), null, { now: NOW });
    expect(t.mode).toBe("real");
    const scuba = t.items.find((i) => i.id === "it_scuba")!;
    expect(scuba.conditions.source).toBe("live-forecast");
    expect(scuba.assessment.availability).toBe("unavailable");
    const rec = primaryPerItem(t.recommendations).find((r) => r.forItemId === "it_scuba")!;
    expect(rec.alternative?.candidate.indoor).toBe(true);
    expect(rec.evidence.map((e) => e.label)).toEqual(expect.arrayContaining(["Weather", "Location", "Group fit"]));
    expect(rec.breakdown.map((b) => b.label)).toEqual(["Weather suitability", "Public / social signals", "Group preferences", "Trip constraints", "Itinerary fit"]);
  });
  it("What-If 20 mm → 100 mm recalculates: scuba goes from open to unavailable with cascading effects", () => {
    const w = world([0, 0, 0, 0, 0]);
    const light = buildTwin(state, events, w, { ...heavy, rainfallMm: 20 }, { now: NOW });
    const hard = buildTwin(state, events, w, heavy, { now: NOW });
    const scuba = (t: typeof light) => t.items.find((i) => i.id === "it_scuba")!;
    expect(hard.mode).toBe("simulated");
    expect(scuba(hard).assessment.impactScore).toBeGreaterThan(scuba(light).assessment.impactScore);
    expect(scuba(hard).assessment.availability).toBe("unavailable");
    expect(scuba(hard).conditions.source).toBe("simulated");
    const kinds = new Set(hard.effects.map((e) => e.kind));
    expect(kinds).toEqual(new Set(["direct", "cascading", "secondary"]));
    expect(hard.effects.some((e) => /Booking consequence/.test(e.text))).toBe(true);
    expect(hard.effects.some((e) => /scooter access/.test(e.text))).toBe(true);
  });
  it("booking/cost effects come from the ledger (paid scuba → refund under its policy)", () => {
    const hard = buildTwin(state, events, world([0, 0, 0, 0, 0]), heavy, { now: NOW });
    const rec = primaryPerItem(hard.recommendations).find((r) => r.forItemId === "it_scuba")!;
    expect(rec.changes[0]).toMatchObject({ kind: "cancel-booking", expenseId: "x_scuba" });
    expect(rec.finance?.ok).toBe(true);
    // 100% refundable until 5 days before the trip day → full ₹10,500 back to Siya, who paid.
    expect(rec.finance?.refunds).toEqual([{ amountPaise: 10_500_00, to: "Siya", expense: "Scuba at Grande Island" }]);
    expect(rec.chain.at(-1)).toMatch(/Ledger recalculated/);
    expect(hard.paths.find((p) => p.date === day(1))!.twin.some((p) => p.alt)).toBe(true);
  });
  it("the real trip is never modified by the twin", () => {
    const before = JSON.stringify(events);
    const ledgerBefore = computeLedger(reduceEvents(events)!);
    buildTwin(state, events, world([0, 0, 0, 0, 0]), { ...heavy, skippingParticipantIds: ["p_rohan", "p_dev"], hotelRemoved: true, unavailableItemIds: ["it_dinner"] }, { now: NOW });
    expect(JSON.stringify(events)).toBe(before);
    expect(computeLedger(reduceEvents(events)!)).toEqual(ledgerBefore);
    expect(state.itinerary.find((i) => i.id === "it_scuba")!.status).not.toBe("cancelled");
  });
  it("members skipping, hotel removed and activity unavailable are simulated through the ledger", () => {
    const t = buildTwin(state, events, world([0, 0, 0, 0, 0]), { ...EMPTY_SCENARIO, date: day(1), skippingParticipantIds: ["p_aarav"], hotelRemoved: true, unavailableItemIds: ["it_dinner"] }, { now: NOW });
    expect(t.mode).toBe("simulated");
    expect(t.items.find((i) => i.id === "it_villa")!.forcedUnavailable).toMatch(/Hotel removed/);
    expect(t.items.find((i) => i.id === "it_dinner")!.assessment.availability).toBe("unavailable");
    expect(t.finance?.ok).toBe(true);
    expect(t.finance!.lines.some((l) => /Villa Azul/.test(l))).toBe(true);
    expect(t.participants.find((p) => p.id === "p_aarav")!.available).toBe(false);
  });
  it("affected-location scenarios only change weather near that place", () => {
    const t = buildTwin(state, events, world([0, 0, 0, 0, 0]), { ...heavy, area: { kind: "item", itemId: "it_scuba", radiusKm: 5 } }, { now: NOW });
    expect(t.items.find((i) => i.id === "it_scuba")!.conditions.source).toBe("simulated");
    expect(t.items.find((i) => i.id === "it_dinner")!.conditions.source).toBe("live-forecast");
  });
  it("storm extension spills into the next day; temperature scenario sets 42°C", () => {
    const base = parseForecast(openMeteo([day(1), day(2)], [0, 0]), "x", P, "u").daily;
    const s = { ...EMPTY_SCENARIO, date: day(1), rainfallMm: 60, stormStartHour: 12, stormHours: 10, stormExtraHours: 12 };
    const next = simulatedDay(base[1], day(2), s, null)!;
    expect(next.precipitationMm).toBeGreaterThan(0);
    const hot = simulatedDay(base[0], day(1), { ...EMPTY_SCENARIO, date: day(1), temperatureC: 42 }, null)!;
    expect(hot.tempMaxC).toBe(42);
  });
  it("GroupTrip Intelligence picks are honoured only inside the engine's shortlist", () => {
    const w = world([0, 0, 0, 0, 0]);
    const t = buildTwin(state, events, w, heavy, { now: NOW, nugenPicks: { it_scuba: "osm:node/2" } });
    const rec = primaryPerItem(t.recommendations).find((r) => r.forItemId === "it_scuba")!;
    expect(rec.alternative?.candidate.id).toBe("osm:node/2");
    expect(rec.chosenBy).toBe("nugen");
    const bogus = buildTwin(state, events, w, heavy, { now: NOW, nugenPicks: { it_scuba: "osm:node/999" } });
    expect(primaryPerItem(bogus.recommendations).find((r) => r.forItemId === "it_scuba")!.chosenBy).toBe("deterministic");
  });
});

describe("What-If scenarios", () => {
  it("parses natural language deterministically", () => {
    expect(parseScenarioText("rainfall becomes 100mm on day 2", state).scenario).toMatchObject({ rainfallMm: 100, date: day(1) });
    expect(parseScenarioText("storm lasts another 12 hours", state).scenario.stormExtraHours).toBe(12);
    expect(parseScenarioText("temperature 42°C on day 2", state).scenario.temperatureC).toBe(42);
    expect(parseScenarioText("scuba unavailable", state).scenario.unavailableItemIds).toEqual(["it_scuba"]);
    expect(parseScenarioText("three members skip day 2", state).scenario.skippingParticipantIds).toHaveLength(3);
    expect(parseScenarioText("Rohan and Dev skip", state).scenario.skippingParticipantIds).toEqual(["p_rohan", "p_dev"]);
    expect(parseScenarioText("hotel removed", state).scenario.hotelRemoved).toBe(true);
  });
  it("validates and clamps scenarios, dropping unknown ids", () => {
    const { scenario, warnings } = validateScenario({ rainfallMm: 9999, temperatureC: "42", unavailableItemIds: ["it_scuba", "it_fake"], skippingParticipantIds: ["p_nobody"], date: "2030-01-01" }, state);
    expect(scenario.rainfallMm).toBe(500);
    expect(scenario.temperatureC).toBe(42);
    expect(scenario.unavailableItemIds).toEqual(["it_scuba"]);
    expect(scenario.skippingParticipantIds).toEqual([]);
    expect(scenario.date).toBeUndefined();
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------- Nugen structured output

describe("Nugen structured output", () => {
  it("extracts JSON from fenced or chatty model output", () => {
    expect(extractJson('Sure! ```json\n{"a": {"b": "}"}}\n``` done')).toEqual({ a: { b: "}" } });
    expect(() => extractJson("no json here")).toThrow();
  });
  it("adaptation picks must reference the shortlist", () => {
    const ok = validateAdaptation({ picks: [{ itemId: "it_scuba", candidateId: "osm:node/1", reason: "indoor" }, { itemId: "it_ghost", candidateId: "x" }] }, { it_scuba: ["osm:node/1"] });
    expect(ok.ok && ok.value).toHaveLength(1);
    expect(ok.ok && ok.repaired[0]).toMatch(/unknown item/);
    expect(validateAdaptation({ picks: [{ itemId: "it_scuba", candidateId: "invented-place" }] }, { it_scuba: ["osm:node/1"] }).ok).toBe(false);
    expect(validateAdaptation({ nonsense: true }, {}).ok).toBe(false);
  });
  it("scenario output is validated against the trip", () => {
    expect(validateScenarioOutput({ rainfallMm: 100, date: day(1) }, state).ok).toBe(true);
    expect(validateScenarioOutput({ unavailableItemIds: ["it_invented"] }, state).ok).toBe(false);
    expect(validateScenarioOutput("garbage", state).ok).toBe(false);
  });
  it("explanations may not invent numbers", () => {
    const facts = JSON.stringify({ refund: "₹10,500", score: 71 });
    expect(ungroundedNumbers("Refund ₹10,500 and score 71", facts)).toEqual([]);
    expect(validateExplanation({ answer: "You will get ₹12,000 back" }, facts).ok).toBe(false);
    expect(validateExplanation({ answer: "The score is 71 because it is indoors." }, facts).ok).toBe(true);
  });
});

describe("invalid AI response & API failure handling", () => {
  const cfg = { apiKey: "test", model: "model_test", aligned: true, baseModel: "qwen-v2p5-0p5b-instruct" };
  const fakeFetch = (status: number, body: unknown) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("nugenConfig reports base vs aligned honestly", () => {
    expect(nugenConfig({})).toBeNull();
    expect(nugenConfig({ NUGEN_API_KEY: "k" })).toMatchObject({ aligned: false, model: "qwen-v2p5-0p5b-instruct" });
    expect(nugenConfig({ NUGEN_API_KEY: "k", NUGEN_MODEL_ID: "model_01abc" })).toMatchObject({ aligned: true, model: "model_01abc" });
  });
  it("chat client parses Nugen responses and surfaces HTTP errors", async () => {
    const r = await nugenChat(cfg, [{ role: "user", content: "hi" }], { fetchImpl: fakeFetch(200, { choices: [{ message: { content: '{"x":1}' } }], model: "model_test", confidence_score: 86.5 }) });
    expect(r).toMatchObject({ text: '{"x":1}', confidenceScore: 86.5 });
    await expect(nugenChat(cfg, [], { fetchImpl: fakeFetch(401, "bad key") })).rejects.toThrow(/401/);
    await expect(nugenChat(cfg, [], { fetchImpl: fakeFetch(200, { choices: [] }) })).rejects.toThrow(/no content/);
  });
  it("without a key, What-If falls back to the deterministic parser and says why", async () => {
    const r = await scenarioFromText("rainfall becomes 100mm on day 2", state, null);
    expect(r.meta).toMatchObject({ engine: "deterministic", fallbackReason: "NUGEN_API_KEY not configured" });
    expect(r.scenario.rainfallMm).toBe(100);
  });
  it("adaptation with no key returns no picks (engine ranking stands)", async () => {
    const r = await adaptToWeather({ trip: { destination: "Goa", dates: "" }, affected: [], shortlist: {}, signals: [], preferences: {} }, null);
    expect(r.picks).toBeNull();
    expect(r.meta.engine).toBe("deterministic");
  });
  it("explanations fall back to the grounded deterministic answer", async () => {
    const t = buildTwin(state, events, world([0, 0, 0, 0, 0]), heavy, { now: NOW });
    const facts = factsFor(t, "it_scuba");
    const r = await explain("Why did my cost change?", facts, null);
    expect(r.meta.engine).toBe("deterministic");
    expect(r.answer).toMatch(/₹10,500/);
    expect(ungroundedNumbers(r.answer, JSON.stringify(facts))).toEqual([]);
    expect(intentOf("Why did you recommend this?")).toBe("why-recommended");
    expect(explainDeterministic("Why was this activity removed?", facts)).toMatch(/Scuba at Grande Island is unavailable/);
  });
  it("public-signal providers report failures instead of throwing", async () => {
    const ctx = { city: "Candolim", region: "Goa", point: P, names: ["Candolim"] };
    const down = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const g = await gdeltProvider(ctx, down);
    expect(g.signals).toEqual([]);
    expect(g.status).toMatchObject({ ok: false });
    const m = await mastodonProvider(ctx, fakeFetch(503, "busy"));
    expect(m.status.ok).toBe(false);
    expect(m.status.note).toMatch(/503/);
  });
});

describe("Nugen alignment dataset", () => {
  it("is built from real engine output, with the documented benchmark shape", () => {
    const capture = JSON.parse(readFileSync(path.join(process.cwd(), "data", "replay", "candolim-north-goa.json"), "utf8")) as TwinWorld;
    const { corpus, benchmark } = buildDataset([{ id: state.trip.id, events }], capture, NOW);
    expect(corpus).toMatch(/GroupTrip Intelligence/);
    expect(benchmark.length).toBeGreaterThan(5);
    for (const b of benchmark) expect(Object.keys(b).sort()).toEqual(["instruction", "response", "sample_num"]);
    expect(() => JSON.parse(benchmark[0].response)).not.toThrow();
  });
});
