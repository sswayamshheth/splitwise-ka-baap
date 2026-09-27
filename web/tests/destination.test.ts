import { describe, expect, it } from "vitest";

import { cleanPlace, createTrip, placeLabel } from "@/lib/ledger/commands";
import { reduceEvents } from "@/lib/ledger/reduce";
import { parseGeocodeList } from "@/lib/weather/openmeteo";

/** The destination must be a real place picked from the search list, with coordinates. */
describe("destination picker", () => {
  it("parses every geocoding hit, so the user can tell the two Manalis apart", () => {
    const json = {
      results: [
        { name: "Manali", admin1: "Tamil Nadu", country: "India", latitude: 13.16667, longitude: 80.26667, population: 35248, feature_code: "PPL" },
        { name: "Manali", admin1: "Himachal Pradesh", country: "India", latitude: 32.2574, longitude: 77.17481, population: 8096, feature_code: "PPL" },
        { name: "Manali", admin2: "Kullu", admin1: "Himachal Pradesh", country: "India", latitude: 32.26, longitude: 77.18 },
        { name: "Manali", admin2: "Kullu", admin1: "Himachal Pradesh", country: "India", latitude: 32.25, longitude: 77.17 },
        { name: "Broken", latitude: "x" },
      ],
    };
    const list = parseGeocodeList(json);
    // The duplicate Kullu entry is shown once; the district tells the rest apart.
    expect(list).toHaveLength(3);
    expect(list.map((p) => p.admin)).toEqual(["Tamil Nadu", "Himachal Pradesh", "Himachal Pradesh"]);
    expect(list[2].district).toBe("Kullu");
    expect(parseGeocodeList(null)).toEqual([]);
    expect(parseGeocodeList({})).toEqual([]);
  });

  it("keeps only places with real coordinates", () => {
    expect(cleanPlace({ name: "Manali", admin: "Himachal Pradesh", country: "India", lat: 32.2574, lon: 77.17481 })).toMatchObject({ lat: 32.2574, lon: 77.17481, source: "open-meteo-geocoding" });
    expect(cleanPlace({ name: "Nowhere", lat: 120, lon: 10 })).toBeUndefined();
    expect(cleanPlace({ name: "Nowhere", lat: "abc", lon: 10 })).toBeUndefined();
    expect(cleanPlace({ name: "", lat: 1, lon: 1 })).toBeUndefined();
    expect(cleanPlace(undefined)).toBeUndefined();
  });

  it("labels a place without repeating itself", () => {
    expect(placeLabel({ name: "Manali", admin: "Himachal Pradesh", country: "India" })).toBe("Manali, Himachal Pradesh, India");
    expect(placeLabel({ name: "Singapore", country: "Singapore" })).toBe("Singapore");
  });

  it("stores the picked place on the trip, for weather and planning", () => {
    const place = { name: "Manali", admin: "Himachal Pradesh", country: "India", lat: 32.2574, lon: 77.17481, source: "open-meteo-geocoding" as const };
    const { events } = createTrip({ name: "Hills", destination: placeLabel(place), place, startDate: "2026-11-01", endDate: "2026-11-05" }, { actor: "system" });
    const s = reduceEvents(events)!;
    expect(s.trip.destination).toBe("Manali, Himachal Pradesh, India");
    expect(s.trip.place).toMatchObject({ lat: 32.2574, lon: 77.17481 });
  });
});
