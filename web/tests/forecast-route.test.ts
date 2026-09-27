import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: "user_forecast_test" }), currentUser: async () => null }));

import { GET } from "@/app/api/forecast/route";

const daily = { time: ["2026-10-01"], weather_code: [61], temperature_2m_max: [20], temperature_2m_min: [9], precipitation_sum: [12], precipitation_probability_max: [80], wind_speed_10m_max: [14] };
const get = (q: string) => GET(new Request(`http://x/api/forecast?${q}`));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/api/forecast (server fallback for the Plan weather)", () => {
  it("returns parsed daily weather, then serves it from cache", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ daily }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    expect((await (await get("lat=32.26&lon=77.17")).json()).days[0]).toMatchObject({ date: "2026-10-01", rainMm: 12, rainProbability: 80 });
    await get("lat=32.26&lon=77.17");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("answers days:null (not an error) when Open-Meteo refuses, e.g. the daily quota", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: true, reason: "Daily API request limit exceeded" }), { status: 429 })));
    const res = await get("lat=10.1&lon=20.2");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ days: null });
  });

  it("rejects nonsense coordinates without calling out", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await (await get("lat=abc&lon=1")).json()).toEqual({ days: null });
    expect(await (await get("lat=95&lon=1")).json()).toEqual({ days: null });
    expect(f).not.toHaveBeenCalled();
  });
});
