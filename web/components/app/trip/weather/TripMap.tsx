"use client";

import "leaflet/dist/leaflet.css";

import type { LatLngBoundsExpression, LatLngExpression } from "leaflet";
import { useEffect } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";

/**
 * The trip on a map: the destination plus every located plan item, joined in
 * day order. Loaded only in the browser (see PlanWeather's dynamic import).
 */

export type MapStop = { id: string; label: string; lat: number; lon: number; atRisk: boolean };

function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 1) map.setView(points[0], 11);
    else if (points.length > 1) map.fitBounds(points as LatLngBoundsExpression, { padding: [28, 28], maxZoom: 12 });
  }, [map, points]);
  return null;
}

export default function TripMap({ destination, stops }: { destination: { label: string; lat: number; lon: number }; stops: MapStop[] }) {
  const route: [number, number][] = stops.map((s) => [s.lat, s.lon]);
  const points: [number, number][] = [[destination.lat, destination.lon], ...route];
  return (
    <MapContainer center={[destination.lat, destination.lon] as LatLngExpression} zoom={10} scrollWheelZoom={false} fadeAnimation={false} className="h-60 w-full rounded-xl" style={{ zIndex: 0 }}>
      <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' />
      <FitBounds points={points} />
      {route.length > 1 ? <Polyline positions={route} pathOptions={{ color: "#1e6f64", weight: 3, opacity: 0.7, dashArray: "6 6" }} /> : null}
      <CircleMarker center={[destination.lat, destination.lon]} radius={7} pathOptions={{ color: "#0e1e1b", fillColor: "#ffffff", fillOpacity: 1, weight: 3 }}>
        <Tooltip direction="top">{destination.label}</Tooltip>
      </CircleMarker>
      {stops.map((s, i) => (
        <CircleMarker key={s.id} center={[s.lat, s.lon]} radius={8} pathOptions={{ color: "#ffffff", fillColor: s.atRisk ? "#ba1a1a" : "#1e6f64", fillOpacity: 1, weight: 2 }}>
          <Tooltip direction="top">{`${i + 1}. ${s.label}${s.atRisk ? " · weather alert" : ""}`}</Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
