"use client";

import { useEffect, useState } from "react";

import { proxyHealth } from "@/lib/ai/agent";
import type { WeatherNoteInput, WeatherNotes } from "@/lib/ai/nugenGuards";
import type { TripWeather } from "@/lib/forecast/rules";

const EMPTY: WeatherNotes = { notes: {}, order: {} };
const cache = new Map<string, WeatherNotes>();

/** What the server may send to NuGen: only the code-decided alerts, at-risk items and indoor ideas. */
export function weatherNoteInput(weather: TripWeather | null): WeatherNoteInput | null {
  if (weather?.status !== "ok") return null;
  const days = weather.days
    .filter((d) => d.atRisk.length)
    .map((d) => ({
      date: d.date,
      alerts: d.alerts.map((a) => ({ label: a.label, reason: a.reason })),
      atRisk: d.atRisk.map((r) => ({ itemId: r.itemId, title: r.title, reasons: r.reasons })),
      alternatives: d.alternatives.map((a) => a.title),
    }));
  return days.length ? { days } : null;
}

/**
 * Optional NuGen wording for the weather alerts the code decided: a friendly line
 * per at-risk item and an order for the indoor ideas. Empty (and nothing is sent)
 * unless the server has NuGen switched on.
 */
export function useWeatherNotes(weather: TripWeather | null): WeatherNotes {
  const [notes, setNotes] = useState<WeatherNotes>(EMPTY);
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    void proxyHealth(ctrl.signal).then((h) => setEnabled(h.nugen));
    return () => ctrl.abort();
  }, []);

  const input = enabled ? weatherNoteInput(weather) : null;
  const key = input ? JSON.stringify(input) : "";
  useEffect(() => {
    if (!key) return setNotes(EMPTY);
    const hit = cache.get(key);
    if (hit) return setNotes(hit);
    let alive = true;
    void fetch("/api/ai/weather-notes", { method: "POST", headers: { "content-type": "application/json" }, body: key })
      .then((r) => (r.ok ? (r.json() as Promise<WeatherNotes>) : EMPTY))
      .catch(() => EMPTY)
      .then((n) => {
        const safe = { notes: n?.notes ?? {}, order: n?.order ?? {} };
        cache.set(key, safe);
        if (alive) setNotes(safe);
      });
    return () => {
      alive = false;
    };
  }, [key]);
  return notes;
}
