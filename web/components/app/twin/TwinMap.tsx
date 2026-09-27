"use client";

import "leaflet/dist/leaflet.css";

import type { LayerGroup, Map as LMap } from "leaflet";
import { useEffect, useRef } from "react";

import type { Twin, TwinWorld } from "@/lib/twin/twin";

/**
 * The trip on a map (Leaflet + OpenStreetMap tiles): itinerary places coloured
 * by weather impact, the rain footprint, alternative places, and — for a day —
 * the real route (solid) against the Digital Twin's route (dashed). Loaded
 * client-only (next/dynamic, ssr:false) by its callers.
 */

const LEVEL_COLOR = { High: "#ba1a1a", Medium: "#b86e00", Low: "#006a6a" } as const;

export default function TwinMap({ world, twin, date, focusItemId, height = 320 }: { world: TwinWorld; twin: Twin; date?: string; focusItemId?: string; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<LMap | null>(null);
  const layer = useRef<LayerGroup | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled || !el.current) return;
      if (!map.current) {
        map.current = L.map(el.current, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · weather: Open-Meteo' }).addTo(map.current);
        layer.current = L.layerGroup().addTo(map.current);
      }
      const g = layer.current!;
      g.clearLayers();
      const pts: [number, number][] = [];
      const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

      // Rain footprint: a circle per forecast point, sized/tinted by the worst trip-day rain (real or simulated).
      for (const f of world.forecasts) {
        const days = twin.items.filter((t) => t.conditions.forecastKey === f.key && t.conditions.day && (!date || t.date === date));
        const mm = Math.max(0, ...days.map((t) => t.conditions.day!.precipitationMm));
        if (mm < 2.5) continue;
        const sim = days.some((t) => t.conditions.source === "simulated");
        L.circle([f.point.lat, f.point.lon], { radius: 4000 + Math.min(mm, 200) * 60, color: sim ? "#6750a4" : "#3b6fb6", weight: 1, fillOpacity: Math.min(0.35, 0.08 + mm / 400), dashArray: sim ? "6 4" : undefined })
          .bindTooltip(`${sim ? "SIMULATED" : "Forecast"} rain ${mm.toFixed(0)} mm`)
          .addTo(g);
      }

      for (const t of twin.items) {
        if (date && t.date !== date && t.category !== "Stay") continue;
        const a = t.assessment;
        const color = a.availability === "unknown" ? "#74777f" : a.availability === "open" ? LEVEL_COLOR.Low : LEVEL_COLOR[a.level];
        const focus = t.id === focusItemId;
        L.circleMarker([t.place.lat, t.place.lon], { radius: focus ? 11 : 8, color: "#fff", weight: 2, fillColor: color, fillOpacity: 0.95 })
          .bindPopup(`<b>${esc(t.title)}</b><br/>${t.date}${t.time ? ` · ${t.time}` : ""}<br/>${a.availability.toUpperCase()} · impact ${a.impactScore}/100<br/><small>${esc(a.drivers[0])}</small>${t.place.precision === "destination" ? "<br/><small>(pinned at destination — exact place not found)</small>" : ""}`)
          .addTo(g);
        pts.push([t.place.lat, t.place.lon]);
      }

      for (const r of twin.recommendations) {
        if (!r.alternative) continue;
        const from = twin.items.find((t) => t.id === r.forItemId);
        if (date && from && from.date !== date) continue;
        const c = r.alternative.candidate;
        L.circleMarker([c.lat, c.lon], { radius: 8, color: "#fff", weight: 2, fillColor: "#6750a4", fillOpacity: 0.95 })
          .bindPopup(`<b>Alternative: ${esc(c.name)}</b><br/>for ${esc(r.forTitle)} · score ${r.score}/100<br/><a href="${c.url}" target="_blank" rel="noreferrer">OpenStreetMap</a>`)
          .addTo(g);
        if (from) L.polyline([[from.place.lat, from.place.lon], [c.lat, c.lon]], { color: "#6750a4", weight: 2, dashArray: "2 6" }).addTo(g);
        pts.push([c.lat, c.lon]);
      }

      const day = date ? twin.paths.find((p) => p.date === date) : undefined;
      if (day) {
        if (day.real.length > 1) L.polyline(day.real.map((p) => [p.lat, p.lon] as [number, number]), { color: "#006a6a", weight: 4, opacity: 0.8 }).bindTooltip("Real plan route").addTo(g);
        if (twin.mode === "simulated" && day.twin.length > 1) L.polyline(day.twin.map((p) => [p.lat, p.lon] as [number, number]), { color: "#6750a4", weight: 4, opacity: 0.9, dashArray: "10 8" }).bindTooltip("Digital Twin route (simulated)").addTo(g);
      }
      if (!pts.length) pts.push([world.destination.lat, world.destination.lon]);
      const m = map.current!;
      m.fitBounds(pts, { padding: [28, 28], maxZoom: 13 });
      // Sheets animate in: re-measure once laid out so tiles fill the box.
      setTimeout(() => {
        if (map.current !== m) return;
        m.invalidateSize();
        m.fitBounds(pts, { padding: [28, 28], maxZoom: 13 });
      }, 250);
    });
    return () => {
      cancelled = true;
    };
  }, [world, twin, date, focusItemId]);

  useEffect(
    () => () => {
      map.current?.remove();
      map.current = null;
    },
    [],
  );

  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-outline-variant/50">
      <div ref={el} style={{ height }} className="z-0 w-full" />
      <div className="flex flex-wrap gap-x-space-md gap-y-1 bg-surface-container-low px-space-sm py-1.5 font-label-sm text-[11px] text-on-surface-variant">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: LEVEL_COLOR.Low }} />OK</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: LEVEL_COLOR.Medium }} />At risk</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: LEVEL_COLOR.High }} />High impact</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: "#6750a4" }} />Alternative</span>
        {date ? <span>— real route · - - twin route</span> : null}
      </div>
    </div>
  );
}
