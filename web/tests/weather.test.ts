import { describe, expect, it } from "vitest";

import { classifyItem } from "@/lib/forecast/classify";
import { parseForecast } from "@/lib/forecast/openMeteo";
import { distanceKm, nearestWithin, pickDestination, placeCandidates, uniqueByLabel, type Place } from "@/lib/forecast/places";
import { conditionsFor, describeCode, FORECAST_DAYS, planWeather, THRESHOLDS, type DailyForecast, type PlanItemInput } from "@/lib/forecast/rules";

const calm = (date: string, over: Partial<DailyForecast> = {}): DailyForecast => ({ date, code: 1, tMaxC: 24, tMinC: 14, rainMm: 0, rainProbability: 10, windKmh: 10, ...over });

describe("outdoor / indoor classification (keyword rules in code)", () => {
  it.each([
    ["Paragliding at Solang", "Activity", "outdoor"],
    ["River rafting on the Beas", "Activity", "outdoor"],
    ["Beach day at Baga", "Other", "outdoor"],
    ["Hampta Pass day trek", "Activity", "outdoor"],
    ["Sunset boat ride", "Activity", "outdoor"],
    ["Himachal culture museum", "Activity", "indoor"],
    ["Mall Road shopping", "Shopping", "indoor"],
    ["Spa afternoon", "Activity", "indoor"],
    ["Dinner at Johnson's", "Food", "indoor"],
    ["Homestay in Old Manali", "Stay", "indoor"],
    ["Cab to Bhuntar airport", "Transport", "unknown"],
    ["Something fun", "Activity", "unknown"],
  ] as const)("%s → %s", (title, category, expected) => {
    expect(classifyItem({ title, category })).toBe(expected);
  });

  it("lets outdoor win when both appear, and uses location/vendor text too", () => {
    expect(classifyItem({ title: "Dinner cruise", category: "Food" })).toBe("outdoor");
    expect(classifyItem({ title: "Afternoon plan", category: "Activity", location: "Jogini waterfall" })).toBe("outdoor");
  });

  it("doesn't match inside other words", () => {
    expect(classifyItem({ title: "Parking fee", category: "Other" })).toBe("unknown");
    expect(classifyItem({ title: "Boarding snacks", category: "Other" })).toBe("unknown");
  });
});

describe("alert thresholds", () => {
  it("heavy rain: at 60% chance or 10 mm, not just below", () => {
    expect(conditionsFor(calm("2026-10-01", { rainProbability: THRESHOLDS.rainProbability - 1, rainMm: 9.9 }))).toEqual([]);
    expect(conditionsFor(calm("2026-10-01", { rainProbability: 60 })).map((a) => a.kind)).toEqual(["rain"]);
    expect(conditionsFor(calm("2026-10-01", { rainProbability: 20, rainMm: 10 })).map((a) => a.kind)).toEqual(["rain"]);
    expect(conditionsFor(calm("2026-10-01", { rainProbability: null, rainMm: 12 }))[0].reason).toBe("12 mm expected");
    // Labelled "heavy" only when the amount is heavy; a high chance alone is "rain likely".
    expect(conditionsFor(calm("2026-10-01", { rainProbability: 67, rainMm: 0 }))[0].label).toBe("Rain likely");
    expect(conditionsFor(calm("2026-10-01", { rainProbability: 67, rainMm: 11 }))[0].label).toBe("Heavy rain");
  });

  it("extreme heat at 38°C, strong wind at 40 km/h, thunderstorms by WMO code", () => {
    expect(conditionsFor(calm("d", { tMaxC: 37.9 }))).toEqual([]);
    expect(conditionsFor(calm("d", { tMaxC: 38 })).map((a) => a.kind)).toEqual(["heat"]);
    expect(conditionsFor(calm("d", { windKmh: 39.9 }))).toEqual([]);
    expect(conditionsFor(calm("d", { windKmh: 40 })).map((a) => a.kind)).toEqual(["wind"]);
    for (const code of [95, 96, 99]) expect(conditionsFor(calm("d", { code })).map((a) => a.kind)).toContain("storm");
    expect(conditionsFor(calm("d", { code: 61 }))).toEqual([]);
    expect(describeCode(95)).toBe("Thunderstorms");
  });
});

describe("planWeather: alerts, exclusions and inclusions", () => {
  const items: PlanItemInput[] = [
    { id: "raft", title: "River rafting on the Beas", category: "Activity", date: "2026-10-02" },
    { id: "dinner", title: "Dinner at Johnson's Cafe", category: "Food", date: "2026-10-02" },
    { id: "museum", title: "Himachal culture museum", category: "Activity", date: "2026-10-04" },
    { id: "trek", title: "Hampta Pass day trek", category: "Activity", date: "2026-10-03" },
  ];
  const forecast = [
    calm("2026-10-01", { rainProbability: 30 }),
    calm("2026-10-02", { code: 63, rainProbability: 85, rainMm: 14 }),
    calm("2026-10-03", { tMaxC: 39, rainProbability: 5 }),
    calm("2026-10-04", { rainProbability: 5, tMinC: 6 }),
  ];
  const w = planWeather({ destination: "Manali", startDate: "2026-10-01", endDate: "2026-10-04", today: "2026-09-27", items, forecast });

  it("raises alerts only on days with outdoor items, and flags those items at risk", () => {
    if (w.status !== "ok") throw new Error("expected ok");
    const d2 = w.days.find((d) => d.date === "2026-10-02")!;
    expect(d2.alerts.map((a) => a.kind)).toEqual(["rain"]);
    expect(d2.atRisk.map((r) => r.itemId)).toEqual(["raft"]);
    expect(w.itemRisk.raft.reasons[0]).toBe("Heavy rain: 85% chance of rain, 14 mm expected");
    expect(w.itemRisk.dinner).toBeUndefined();
    // Day 4 is calm; day 1 has no items at all.
    expect(w.days.find((d) => d.date === "2026-10-04")!.alerts).toEqual([]);
    expect(w.days.find((d) => d.date === "2026-10-01")!.alerts).toEqual([]);
    expect(w.alertDays).toBe(2);
  });

  it("suggests the clearest other day, indoor ideas and packing for alert days", () => {
    if (w.status !== "ok") throw new Error("expected ok");
    const d2 = w.days.find((d) => d.date === "2026-10-02")!;
    expect(d2.betterDays[0]).toMatchObject({ itemId: "raft", date: "2026-10-04" });
    expect(d2.alternatives.length).toBeGreaterThan(0);
    expect(d2.alternatives[0]).toMatchObject({ title: "Himachal culture museum", fromPlan: true });
    expect(d2.alternatives.every((a) => classifyItem(a) === "indoor")).toBe(true);
    expect(d2.packing).toContain("Rain jacket or umbrella");
    const d3 = w.days.find((d) => d.date === "2026-10-03")!;
    expect(d3.alerts.map((a) => a.kind)).toEqual(["heat"]);
    expect(d3.packing).toEqual(expect.arrayContaining(["Sunscreen, hat and water", "Light, loose clothing"]));
    expect(w.packing).toContain("Warm layers for the evenings");
  });

  it("never adds items or changes amounts — it only reads the plan", () => {
    const before = JSON.stringify(items);
    planWeather({ destination: "Manali", startDate: "2026-10-01", endDate: "2026-10-04", today: "2026-09-27", items, forecast });
    expect(JSON.stringify(items)).toBe(before);
  });

  it("offers a better time instead of a day when every other day also has alerts (heat)", () => {
    const hot = planWeather({
      destination: "Nowhere",
      startDate: "2026-05-01",
      endDate: "2026-05-02",
      today: "2026-04-28",
      items: [{ id: "hike", title: "Desert hike", category: "Activity", date: "2026-05-01" }],
      forecast: [calm("2026-05-01", { tMaxC: 44 }), calm("2026-05-02", { tMaxC: 45 })],
    });
    if (hot.status !== "ok") throw new Error("expected ok");
    expect(hot.days[0].betterDays[0]).toMatchObject({ itemId: "hike", date: "2026-05-01" });
    expect(hot.days[0].betterDays[0].why).toMatch(/early|late/);
    // Unknown destination still gets generic indoor ideas.
    expect(hot.days[0].alternatives.length).toBeGreaterThan(0);
  });

  it("ignores cancelled items", () => {
    const r = planWeather({ destination: "Manali", startDate: "2026-10-02", endDate: "2026-10-02", today: "2026-09-27", items: [{ ...items[0], status: "cancelled" }], forecast });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.days[0].alerts).toEqual([]);
  });
});

describe("forecast range", () => {
  it(`says so plainly when the trip starts beyond ~${FORECAST_DAYS} days`, () => {
    const r = planWeather({ destination: "Goa", startDate: "2026-10-20", endDate: "2026-10-24", today: "2026-09-27", items: [], forecast: [] });
    expect(r.status).toBe("too-far");
    if (r.status === "too-far") {
      expect(r.message).toBe("Forecast available closer to your dates");
      expect(r.forecastFrom).toBe("2026-10-05");
    }
  });

  it("covers a trip starting on the last forecast day, and leaves later days without a forecast", () => {
    const r = planWeather({ destination: "Goa", startDate: "2026-10-12", endDate: "2026-10-14", today: "2026-09-27", items: [], forecast: [calm("2026-10-12")] });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.lastForecastDate).toBe("2026-10-12");
      expect(r.days.map((d) => !!d.forecast)).toEqual([true, false, false]);
    }
  });

  it("marks finished trips as past, and starts mid-trip days from today", () => {
    expect(planWeather({ destination: "Goa", startDate: "2026-09-01", endDate: "2026-09-05", today: "2026-09-27", items: [], forecast: [] }).status).toBe("past");
    const r = planWeather({ destination: "Goa", startDate: "2026-09-25", endDate: "2026-09-28", today: "2026-09-27", items: [], forecast: [calm("2026-09-27"), calm("2026-09-28")] });
    if (r.status === "ok") expect(r.days.map((d) => d.date)).toEqual(["2026-09-27", "2026-09-28"]);
  });
});

describe("places", () => {
  it("builds findable names from location, vendor and 'at/in/to' phrases", () => {
    expect(placeCandidates({ title: "Paragliding at Solang Valley" })).toEqual(["Solang Valley", "Solang"]);
    expect(placeCandidates({ title: "Cab to Bhuntar airport" })).toEqual(["Bhuntar"]);
    expect(placeCandidates({ title: "Dinner", location: "Vashisht", vendor: "Johnson's Cafe" })[0]).toBe("Vashisht");
    expect(placeCandidates({ title: "a b c" })).toEqual([]);
  });

  it("only accepts matches near the destination", () => {
    const manali = { lat: 32.26, lon: 77.17 };
    const png: Place = { name: "Solang", countryCode: "PG", lat: -2.39, lon: 147.33 };
    const vashisht: Place = { name: "Bashist", countryCode: "IN", lat: 32.27, lon: 77.19 };
    expect(nearestWithin([png], manali)).toBeNull();
    expect(nearestWithin([png, vashisht], manali)).toBe(vashisht);
    const km = distanceKm(manali, { lat: 31.86, lon: 77.15 }); // Manali → Bhuntar, about 45 km
    expect(km).toBeGreaterThan(43);
    expect(km).toBeLessThan(47);
  });
});

describe("Open-Meteo parsing", () => {
  it("maps the daily arrays and tolerates missing values", () => {
    const days = parseForecast({
      daily: {
        time: ["2026-10-01", "2026-10-02"],
        weather_code: [61, 0],
        temperature_2m_max: [21.5, 25],
        temperature_2m_min: [12, 13],
        precipitation_sum: [11.2, null],
        precipitation_probability_max: [80, null],
        wind_speed_10m_max: [12, 8],
      },
    });
    expect(days).toEqual([
      { date: "2026-10-01", code: 61, tMaxC: 21.5, tMinC: 12, rainMm: 11.2, rainProbability: 80, windKmh: 12 },
      { date: "2026-10-02", code: 0, tMaxC: 25, tMinC: 13, rainMm: 0, rainProbability: null, windKmh: 8 },
    ]);
    expect(parseForecast({ error: true })).toEqual([]);
    expect(parseForecast(null)).toEqual([]);
  });
});

describe("choosing between same-named destinations", () => {
  const tamilNadu: Place = { name: "Manali", admin1: "Tamil Nadu", countryCode: "IN", lat: 13.17, lon: 80.27 };
  const himachal: Place = { name: "Manali", admin1: "Himachal Pradesh", countryCode: "IN", lat: 32.26, lon: 77.17 };
  const bhuntar: Place = { name: "Bhuntar", countryCode: "IN", lat: 31.86, lon: 77.15 };
  const vashisht: Place = { name: "Bashist", countryCode: "IN", lat: 32.27, lon: 77.19 };

  it("picks the one the itinerary's places are near", () => {
    expect(pickDestination([tamilNadu, himachal], [[bhuntar], [vashisht], []])).toBe(himachal);
  });

  it("falls back to the geocoder's first match when the itinerary gives no clue", () => {
    expect(pickDestination([tamilNadu, himachal], [[], []])).toBe(tamilNadu);
    expect(pickDestination([], [[bhuntar]])).toBeNull();
  });

  it("drops duplicate labels", () => {
    expect(uniqueByLabel([tamilNadu, { ...tamilNadu, lat: 10.58 }, himachal])).toEqual([tamilNadu, himachal]);
  });
});
