"use client";

import dynamic from "next/dynamic";

import { Icon, Notice } from "@/components/app/kit";
import { formatDate } from "@/lib/dates";
import { placeLabel } from "@/lib/forecast/places";
import type { DayWeather, ItemRisk } from "@/lib/forecast/rules";

import type { MapStop } from "./TripMap";
import type { TripWeatherState } from "./useTripWeather";

// Leaflet touches `window`, so the map is loaded only in the browser, after the rest of the page.
const TripMap = dynamic(() => import("./TripMap"), {
  ssr: false,
  loading: () => <div className="flex h-60 w-full items-center justify-center rounded-xl bg-surface-container font-label-md text-label-md text-on-surface-variant">Loading map…</div>,
});

function weatherIcon(code?: number) {
  if (code === undefined) return "cloud";
  if (code === 0) return "sunny";
  if (code <= 2) return "partly_cloudy_day";
  if (code === 3) return "cloud";
  if (code === 45 || code === 48) return "foggy";
  if (code >= 95) return "thunderstorm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "weather_snowy";
  return "rainy";
}

const SOURCE = "Weather: Open-Meteo · Map © OpenStreetMap contributors";

/** The trip-level card: where the weather is for, the map, and what to pack. */
export function PlanWeather({ w, itemTitle }: { w: TripWeatherState; itemTitle: (id: string) => string }) {
  const weather = w.weather;
  const riskIds = weather?.status === "ok" ? weather.itemRisk : {};
  // Joined in day order (a stable sort keeps the plan's order within a day).
  const stops: MapStop[] = [...w.stops].sort((a, b) => a.date.localeCompare(b.date)).map((s) => ({ id: s.id, label: `${itemTitle(s.id)} · ${formatDate(s.date)}`, lat: s.place.lat, lon: s.place.lon, atRisk: !!riskIds[s.id] }));

  return (
    <section className="px-margin pt-space-md" aria-label="Map and weather">
      <div className="flex flex-col gap-space-sm rounded-xl bg-surface-container-lowest p-space-md shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 font-title-md text-title-md text-on-surface">
            <Icon name="map" className="text-[20px] text-primary" /> Map &amp; weather
          </span>
          {weather?.status === "ok" && weather.alertDays > 0 ? (
            <span className="flex items-center gap-1 rounded-full bg-error-container px-2 py-0.5 font-label-sm text-label-sm text-on-error-container">
              <Icon name="warning" className="text-[14px]" /> {weather.alertDays} day{weather.alertDays === 1 ? "" : "s"} with alerts
            </span>
          ) : null}
        </div>

        {w.destination ? (
          <div className="flex flex-wrap items-center gap-1 font-body-md text-body-md text-on-surface-variant">
            <span>For {placeLabel(w.destination)}</span>
            {w.destinations.length > 1 ? (
              <label className="flex items-center gap-1">
                <span className="sr-only">Choose the right place</span>
                <select
                  className="max-w-[12rem] truncate rounded-lg bg-surface-container px-2 py-0.5 font-label-md text-label-md text-primary"
                  value={placeLabel(w.destination)}
                  onChange={(e) => w.chooseDestination(e.target.value)}
                >
                  {w.destinations.map((p) => (
                    <option key={placeLabel(p)} value={placeLabel(p)}>
                      {placeLabel(p)}
                    </option>
                  ))}
                </select>
                <span className="font-label-sm text-label-sm">· not right? pick another</span>
              </label>
            ) : null}
          </div>
        ) : null}

        {w.destination ? <TripMap destination={{ label: placeLabel(w.destination), lat: w.destination.lat, lon: w.destination.lon }} stops={stops} /> : null}

        {w.unlocated.length ? (
          <div className="flex flex-col gap-0.5">
            <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Not on the map</span>
            <ul className="flex flex-col gap-0.5 font-body-md text-body-md text-on-surface-variant">
              {w.unlocated.map((u) => (
                <li key={u.id} className="truncate">
                  {formatDate(u.date)} · {u.title}
                </li>
              ))}
            </ul>
            <span className="font-label-sm text-label-sm text-on-surface-variant">Add a place in the item&apos;s Location to put it on the map.</span>
          </div>
        ) : null}

        {w.loading && !weather ? <span className="font-body-md text-body-md text-on-surface-variant">Checking the forecast…</span> : null}
        {!w.loading && w.unavailable && !weather ? <span className="font-body-md text-body-md text-on-surface-variant">Weather isn&apos;t available right now. Try again later.</span> : null}
        {weather?.status === "too-far" ? (
          <span className="font-body-md text-body-md text-on-surface-variant">
            {weather.message} — forecasts reach about 16 days ahead (from {formatDate(weather.forecastFrom)}).
          </span>
        ) : null}
        {weather?.status === "past" ? <span className="font-body-md text-body-md text-on-surface-variant">{weather.message}</span> : null}
        {weather?.status === "ok" && weather.packing.length ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Pack</span>
            {weather.packing.map((p) => (
              <span key={p} className="rounded-full bg-surface-container px-2 py-0.5 font-label-sm text-label-sm text-on-surface">
                {p}
              </span>
            ))}
          </div>
        ) : null}
        <span className="font-label-sm text-label-sm text-on-surface-variant">{SOURCE}</span>
      </div>
    </section>
  );
}

/** A one-line strip under a day's heading. */
export function DayWeatherStrip({ day }: { day?: DayWeather }) {
  if (!day) return null;
  if (!day.forecast) return <p className="-mt-2 mb-space-sm font-label-sm text-label-sm text-on-surface-variant">Forecast not available for this day yet</p>;
  const f = day.forecast;
  return (
    <div className="-mt-2 mb-space-sm flex flex-wrap items-center gap-x-2 gap-y-1 font-label-md text-label-md text-on-surface-variant">
      <span className="flex items-center gap-1 text-on-surface">
        <Icon name={weatherIcon(f.code)} className="text-[18px]" /> {day.summary}
      </span>
      <span>
        {Math.round(f.tMaxC)}° / {Math.round(f.tMinC)}°
      </span>
      {f.rainProbability !== null ? <span>· {Math.round(f.rainProbability)}% rain</span> : null}
      <span>· wind {Math.round(f.windKmh)} km/h</span>
      {day.alerts.map((a) => (
        <span key={a.kind} className="flex items-center gap-0.5 rounded-full bg-error-container px-2 py-0.5 font-label-sm text-label-sm text-on-error-container">
          <Icon name="warning" className="text-[13px]" /> {a.label}
        </span>
      ))}
    </div>
  );
}

/** Badge on a plan item that the weather puts at risk. */
export function ItemWeatherBadge({ risk }: { risk?: ItemRisk }) {
  if (!risk) return null;
  return (
    <span className="flex w-fit items-start gap-1 rounded-lg bg-error-container px-2 py-1 font-label-sm text-label-sm text-on-error-container">
      <Icon name="warning" className="mt-px text-[14px]" />
      <span>At risk · {risk.reasons.join(" · ")}</span>
    </span>
  );
}

/**
 * The "Alternatives" panel for a day with alerts: what's at risk and why,
 * clearer days to move to, indoor ideas and what to pack. Nothing is applied
 * unless the user presses a button.
 */
export function DayAlternatives({
  day,
  canMove,
  onMove,
  explanations,
  order,
}: {
  day?: DayWeather;
  canMove: (itemId: string) => boolean;
  onMove: (itemId: string, date: string) => void;
  /** Optional NuGen wording per at-risk item (already checked on the server). */
  explanations?: Record<string, string>;
  /** Optional NuGen ordering of this day's indoor ideas (only the code's own ideas). */
  order?: string[];
}) {
  if (!day || !day.alerts.length) return null;
  const ideas = order ? [...day.alternatives].sort((a, b) => order.indexOf(a.title) - order.indexOf(b.title)) : day.alternatives;
  const worded = !!order || day.atRisk.some((r) => explanations?.[r.itemId]);
  return (
    <div className="mt-space-md flex flex-col gap-space-sm rounded-xl bg-secondary-fixed/40 p-space-md">
      <span className="flex items-center gap-1.5 font-title-md text-title-md text-on-secondary-fixed">
        <Icon name="alt_route" className="text-[20px]" /> Alternatives
      </span>
      {day.atRisk.map((r) => {
        const better = day.betterDays.find((b) => b.itemId === r.itemId);
        const note = explanations?.[r.itemId];
        return (
          <div key={r.itemId} className="flex flex-col gap-1">
            <span className="font-body-md text-body-md text-on-surface">
              <span className="font-semibold">{r.title}</span> is at risk: {r.reasons.join("; ")}.
            </span>
            {note ? <span className="font-body-md text-body-md italic text-on-surface-variant">{note}</span> : null}
            {better ? (
              better.date === day.date ? (
                <span className="font-body-md text-body-md text-on-surface-variant">Better time: {better.why}.</span>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-body-md text-body-md text-on-surface-variant">
                    Clearer on {formatDate(better.date)}: {better.why}.
                  </span>
                  {canMove(r.itemId) ? (
                    <button onClick={() => onMove(r.itemId, better.date)} className="rounded-full bg-surface-container-lowest px-3 py-1 font-label-md text-label-md text-primary shadow-sm hover:bg-surface-container-low">
                      Move to {formatDate(better.date)}
                    </button>
                  ) : (
                    <span className="font-label-sm text-label-sm text-on-surface-variant">(It&apos;s booked — check with the vendor before moving it.)</span>
                  )}
                </div>
              )
            ) : null}
          </div>
        );
      })}
      {ideas.length ? (
        <div className="flex flex-col gap-1">
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Indoor ideas</span>
          <ul className="flex flex-col gap-0.5 font-body-md text-body-md text-on-surface">
            {ideas.map((a) => (
              <li key={a.title} className="flex items-start gap-1.5">
                <Icon name="home" className="mt-0.5 text-[16px] text-on-surface-variant" />
                <span>
                  {a.title}
                  {a.fromPlan ? <span className="font-label-sm text-label-sm text-on-surface-variant"> · already in your plan</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {day.packing.length ? <span className="font-body-md text-body-md text-on-surface-variant">Pack: {day.packing.join(", ")}.</span> : null}
      <Notice tone="teal" icon="info">
        Suggestions only — nothing in the plan changes unless you choose it.{worded ? " Some wording by NuGen; the alerts themselves are decided by the forecast rules." : ""}
      </Notice>
    </div>
  );
}
