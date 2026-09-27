"use client";

import { useEffect, useMemo, useState } from "react";

import { todayIso } from "@/lib/dates";
import { forecastAt, geocode } from "@/lib/forecast/openMeteo";
import { nearestWithin, pickDestination, placeCandidates, placeLabel, uniqueByLabel, type Place } from "@/lib/forecast/places";
import { planWeather, type DailyForecast, type PlanItemInput, type TripWeather } from "@/lib/forecast/rules";

export type Stop = { id: string; title: string; date: string; place: Place };

export type TripWeatherState = {
  loading: boolean;
  /** Places matching the trip's destination; the user can pick another one. */
  destinations: Place[];
  destination: Place | null;
  chooseDestination: (label: string) => void;
  /** Code-decided weather for the trip; null while loading or when the service is unavailable. */
  weather: TripWeather | null;
  unavailable: boolean;
  stops: Stop[];
  unlocated: { id: string; title: string; date: string }[];
};

const choiceKey = (tripId: string) => `gtl.dest.v1:${tripId}`;

function readChoice(tripId: string): string | null {
  try {
    return window.localStorage.getItem(choiceKey(tripId));
  } catch {
    return null;
  }
}

/** Finds where each item is (near the destination only). Sequential and cached, so it's gentle on the free API. */
async function locate(items: PlanItemInput[], destination: Place): Promise<{ stops: Stop[]; unlocated: TripWeatherState["unlocated"] }> {
  const stops: Stop[] = [];
  const unlocated: TripWeatherState["unlocated"] = [];
  for (const item of items.slice(0, 40)) {
    let found: Place | null = null;
    for (const name of placeCandidates(item)) {
      const qualified = destination.admin1 ? await geocode(`${name}, ${destination.admin1}`) : [];
      found = nearestWithin(qualified, destination) ?? nearestWithin(await geocode(name), destination);
      if (found) break;
    }
    if (found) stops.push({ id: item.id, title: item.title, date: item.date, place: found });
    else unlocated.push({ id: item.id, title: item.title, date: item.date });
  }
  return { stops, unlocated };
}

export function useTripWeather(trip: { tripId: string; destination: string; startDate: string; endDate: string; items: PlanItemInput[] }): TripWeatherState {
  const [destinations, setDestinations] = useState<Place[]>([]);
  const [autoPick, setAutoPick] = useState<Place | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [forecast, setForecast] = useState<DailyForecast[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [located, setLocated] = useState<{ stops: Stop[]; unlocated: TripWeatherState["unlocated"] }>({ stops: [], unlocated: [] });

  useEffect(() => setChoice(readChoice(trip.tripId)), [trip.tripId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const places = uniqueByLabel(await geocode(trip.destination));
      if (!alive) return;
      setDestinations(places);
      if (!places.length) {
        setUnavailable(true);
        setLoading(false);
        return;
      }
      // Several places share the name: let the itinerary's own place names decide (the user can still change it).
      let pick = places[0];
      if (places.length > 1) {
        const names = [...new Set(trip.items.flatMap((i) => placeCandidates(i)))].slice(0, 20);
        const matches: Place[][] = [];
        for (const n of names) matches.push(await geocode(n));
        pick = pickDestination(places, matches) ?? places[0];
      }
      if (alive) setAutoPick(pick);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip.destination]);

  const destination = useMemo(() => destinations.find((p) => placeLabel(p) === choice) ?? autoPick, [destinations, choice, autoPick]);

  useEffect(() => {
    if (!destination) return;
    let alive = true;
    setLoading(true);
    void forecastAt(destination.lat, destination.lon).then((days) => {
      if (!alive) return;
      setForecast(days);
      setUnavailable(!days);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [destination]);

  // Re-locate only when something that affects places changes (not on every ledger event).
  const itemsKey = trip.items.map((i) => `${i.id}|${i.title}|${i.location ?? ""}|${i.vendor ?? ""}|${i.date}`).join("\n");
  useEffect(() => {
    if (!destination) return;
    let alive = true;
    void locate(trip.items, destination).then((r) => alive && setLocated(r));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, itemsKey]);

  const weather = useMemo(
    () => (forecast ? planWeather({ destination: trip.destination, startDate: trip.startDate, endDate: trip.endDate, today: todayIso(), items: trip.items, forecast }) : null),
    [forecast, trip.destination, trip.startDate, trip.endDate, trip.items],
  );

  const chooseDestination = (label: string) => {
    setChoice(label);
    try {
      window.localStorage.setItem(choiceKey(trip.tripId), label);
    } catch {
      // Not remembered across visits; fine.
    }
  };

  return { loading, destinations, destination, chooseDestination, weather, unavailable, stops: located.stops, unlocated: located.unlocated };
}
