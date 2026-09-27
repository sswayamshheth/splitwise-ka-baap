import { describe, expect, it } from "vitest";

import { planWeather, type DailyForecast } from "@/lib/forecast/rules";
import { combineForecasts, metDayComplete } from "@/lib/weather/backup";
import { ensembleUrl, parseEnsemble } from "@/lib/weather/ensemble";
import { parseMetno } from "@/lib/weather/metno";
import type { Forecast, WeatherDay } from "@/lib/weather/openmeteo";

/** Open-Meteo's GFS ensemble: control column + member columns per variable. */
const ensembleJson = {
  timezone: "Asia/Kolkata",
  utc_offset_seconds: 19800,
  daily: {
    time: ["2026-09-27", "2026-09-28", "2026-09-29"],
    temperature_2m_max: [30, 31, null],
    temperature_2m_max_member01: [32, 29, null],
    temperature_2m_min: [24, 25, null],
    temperature_2m_min_member01: [22, 25, null],
    precipitation_sum: [0, 5, null],
    precipitation_sum_member01: [2, 0.5, null],
    wind_speed_10m_max: [10, 20, null],
    wind_speed_10m_max_member01: [14, 20, null],
    weather_code: [1, 61, null],
    weather_code_member01: [61, 3, null],
  },
};

const day = (date: string, extra: Partial<WeatherDay> = {}): WeatherDay => ({ date, precipitationMm: 0, precipitationProbability: null, precipitationHours: null, tempMaxC: 30, tempMinC: 24, windMaxKmh: 10, gustMaxKmh: null, weatherCode: 1, ...extra });
const fc = (source: Forecast["source"], daily: WeatherDay[]): Forecast => ({ location: { lat: 15.5, lon: 73.8, label: "Goa" }, grid: { lat: 15.5, lon: 73.8 }, timezone: "Asia/Kolkata", fetchedAt: 0, source, sourceUrl: "u", current: null, daily });
const hours = (n: number) => Array.from({ length: n }, (_, hour) => ({ hour, precipitationMm: 0, precipitationProbability: null, windKmh: 5, tempC: 28, weatherCode: 1 }));

describe("GFS ensemble backup (ensemble-api.open-meteo.com)", () => {
  it("asks for 35 days in local time", () => {
    expect(ensembleUrl({ lat: 15.5, lon: 73.83 })).toContain("forecast_days=35");
    expect(ensembleUrl({ lat: 15.5, lon: 73.83 })).toContain("timezone=auto");
  });
  it("summarises members: mean temps/rain/wind, share of members with ≥1 mm as the chance of rain; drops empty days", () => {
    const f = parseEnsemble(ensembleJson, "Goa", { lat: 15.5, lon: 73.83 }, "u", 0);
    expect(f.source).toBe("open-meteo-ensemble");
    expect(f.daily.map((d) => d.date)).toEqual(["2026-09-27", "2026-09-28"]);
    expect(f.daily[0]).toMatchObject({ tempMaxC: 31, tempMinC: 23, precipitationMm: 1, precipitationProbability: 50, windMaxKmh: 12 });
    expect(f.daily[1]).toMatchObject({ precipitationMm: 2.8, precipitationProbability: 50 });
  });
  it("rejects an error answer", () => {
    expect(() => parseEnsemble({ error: true, reason: "limit" }, "x", { lat: 0, lon: 0 }, "u")).toThrow(/limit/);
  });
});

describe("combining forecast sources", () => {
  it("extends the main forecast with ensemble days after its horizon only", () => {
    const main = fc("open-meteo", [day("2026-09-27"), day("2026-09-28")]);
    const ens = fc("open-meteo-ensemble", [day("2026-09-28", { tempMaxC: 99 }), day("2026-09-29", { tempMaxC: 33 })]);
    const out = combineForecasts({ primary: main, ensemble: ens })!;
    expect(out.daily.map((d) => [d.date, d.tempMaxC])).toEqual([["2026-09-27", 30], ["2026-09-28", 30], ["2026-09-29", 33]]);
    expect(out.source).toBe("open-meteo");
    expect(out.sourceNote).toMatch(/ensemble/);
  });
  it("uses MET Norway for its complete hour-by-hour days (no mixed-in chance of rain), the ensemble for the rest", () => {
    const met = fc("met-norway", [day("2026-09-27", { tempMaxC: 29, hours: hours(12) }), day("2026-09-28", { tempMaxC: 28, hours: hours(24) }), day("2026-09-29", { tempMaxC: 27 })]);
    met.current = { time: "t", temperatureC: 29, precipitationMm: 0, windKmh: 5, weatherCode: 1 };
    const ens = fc("open-meteo-ensemble", ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"].map((d) => day(d, { tempMaxC: 31, precipitationProbability: 40 })));
    const out = combineForecasts({ met, ensemble: ens })!;
    expect(out.daily.map((d) => [d.date, d.tempMaxC, d.precipitationProbability])).toEqual([
      ["2026-09-27", 31, 40], // today from now on only: not a whole day from MET
      ["2026-09-28", 28, null],
      ["2026-09-29", 31, 40], // 6-hourly: ensemble
      ["2026-09-30", 31, 40],
    ]);
    expect(out.current?.temperatureC).toBe(29);
    expect(out.sourceNote).toMatch(/MET Norway hour by hour for 1 day/);
    expect(metDayComplete(met.daily[1])).toBe(true);
  });
  it("falls back to whichever single source answered, or null", () => {
    expect(combineForecasts({ met: fc("met-norway", [day("2026-09-28")]) })?.source).toBe("met-norway");
    expect(combineForecasts({ ensemble: fc("open-meteo-ensemble", [day("2026-09-28")]) })?.source).toBe("open-meteo-ensemble");
    expect(combineForecasts({})).toBeNull();
  });
});

describe("MET Norway day grouping", () => {
  const step = (time: string, temp: number, kind: "1" | "6" | "none") => ({
    time,
    data: {
      instant: { details: { air_temperature: temp, wind_speed: 1 } },
      ...(kind === "1" ? { next_1_hours: { summary: { symbol_code: "fair_day" }, details: { precipitation_amount: 0 } } } : kind === "6" ? { next_6_hours: { summary: { symbol_code: "fair_day" }, details: { precipitation_amount: 0 } } } : {}),
    },
  });
  it("uses the real UTC offset when given (Singapore is +8) and leaves out a day seen through one reading", () => {
    const json = { properties: { timeseries: [step("2026-10-01T16:00:00Z", 27, "6"), step("2026-10-01T22:00:00Z", 26, "6"), step("2026-10-02T04:00:00Z", 31, "none")] } };
    const f = parseMetno(json, "Singapore", { lat: 1.29, lon: 103.85 }, "u", 0, 480);
    // 00:00 and 06:00 local on 2 Oct; the single 12:00 reading with no period after it is part of that day, not a day of its own.
    expect(f.daily.map((d) => [d.date, d.tempMaxC, d.tempMinC])).toEqual([["2026-10-02", 31, 26]]);
    const lone = { properties: { timeseries: [step("2026-10-01T16:00:00Z", 27, "6"), step("2026-10-01T22:00:00Z", 26, "6"), step("2026-10-02T16:00:00Z", 30, "none")] } };
    expect(parseMetno(lone, "Singapore", { lat: 1.29, lon: 103.85 }, "u", 0, 480).daily.map((d) => d.date)).toEqual(["2026-10-02"]);
  });
});

describe("Plan weather horizon follows the forecast", () => {
  const f = (date: string): DailyForecast => ({ date, code: 1, tMaxC: 31, tMinC: 24, rainMm: 0, rainProbability: 10, windKmh: 10 });
  it("keeps long-range days past 16 days when a source gave them", () => {
    const dates = Array.from({ length: 20 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
    const w = planWeather({ destination: "Goa", startDate: "2026-10-14", endDate: "2026-10-18", today: "2026-09-30", items: [], forecast: dates.map(f) });
    expect(w.status).toBe("ok");
    if (w.status !== "ok") return;
    expect(w.days.map((d) => !!d.forecast)).toEqual([true, true, true, true, true]);
    expect(w.lastForecastDate).toBe("2026-10-20");
  });
  it("still says 'too far' past the furthest forecast day", () => {
    const w = planWeather({ destination: "Goa", startDate: "2026-12-01", endDate: "2026-12-03", today: "2026-09-30", items: [], forecast: [f("2026-10-01")] });
    expect(w.status).toBe("too-far");
    if (w.status === "too-far") expect(w.horizonDays).toBe(16);
  });
});

describe("telling same-named destinations apart", () => {
  it("offers every capitalised name in a title as a vote, without generic words", async () => {
    const { titlePlaceNames } = await import("@/lib/forecast/places");
    expect(titlePlaceNames("Hadimba temple & Vashisht springs")).toEqual(["Hadimba", "Vashisht"]);
    expect(titlePlaceNames("River rafting on the Beas")).toEqual(["Beas"]);
    expect(titlePlaceNames("Homestay in Old Manali · 3 nights")).toEqual(["Manali"]);
    expect(titlePlaceNames("Board-game night at the homestay")).toEqual([]);
  });
});
