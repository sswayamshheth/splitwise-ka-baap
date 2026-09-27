import { describe, expect, it } from "vitest";

import { parseMetno, symbolToWmo, utcOffsetMinutes } from "@/lib/weather/metno";

/** MET Norway is the backup forecast when Open-Meteo refuses (quota / outage). */
const at = (iso: string, temp: number, mm: number, symbol: string, six = false) => ({
  time: iso,
  data: {
    instant: { details: { air_temperature: temp, wind_speed: 5 } },
    ...(six ? { next_6_hours: { summary: { symbol_code: symbol }, details: { precipitation_amount: mm } } } : { next_1_hours: { summary: { symbol_code: symbol }, details: { precipitation_amount: mm } } }),
  },
});

describe("MET Norway backup forecast", () => {
  it("maps MET symbols to WMO codes", () => {
    expect(symbolToWmo("clearsky_day")).toBe(0);
    expect(symbolToWmo("partlycloudy_night")).toBe(2);
    expect(symbolToWmo("heavyrain")).toBe(65);
    expect(symbolToWmo("lightrainshowers_day")).toBe(80);
    expect(symbolToWmo("rainandthunder")).toBe(95);
  });
  it("uses Indian time inside India", () => {
    expect(utcOffsetMinutes({ lat: 15.5, lon: 73.8 })).toBe(330);
    expect(utcOffsetMinutes({ lat: 1.29, lon: 103.85 })).toBe(420);
  });
  it("groups UTC steps into local days: temps, rain (hourly or 6-hourly, never both), wind km/h", () => {
    const json = {
      properties: {
        timeseries: [
          at("2026-10-11T19:00:00Z", 30, 2, "rain"), // 00:30 IST on the 12th
          at("2026-10-11T20:00:00Z", 26, 3, "heavyrain"),
          at("2026-10-12T00:00:00Z", 24, 12, "rain", true),
        ],
      },
    };
    const f = parseMetno(json, "Candolim", { lat: 15.518, lon: 73.763 }, "https://api.met.no/x", 0);
    expect(f.source).toBe("met-norway");
    expect(f.daily).toHaveLength(1);
    const d = f.daily[0];
    expect(d.date).toBe("2026-10-12");
    expect(d.tempMaxC).toBe(30);
    expect(d.tempMinC).toBe(24);
    expect(d.precipitationMm).toBe(17);
    expect(d.weatherCode).toBe(65);
    expect(d.windMaxKmh).toBe(18);
    expect(f.current?.temperatureC).toBe(30);
  });
  it("rejects an empty answer", () => {
    expect(() => parseMetno({}, "x", { lat: 0, lon: 0 }, "u")).toThrow();
  });
});
