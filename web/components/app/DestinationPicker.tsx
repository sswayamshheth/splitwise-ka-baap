"use client";

import { useEffect, useId, useRef, useState } from "react";

import { cx, Icon } from "@/components/app/kit";
import { api } from "@/lib/client/api";
import { placeLabel } from "@/lib/ledger/commands";
import type { TripPlace } from "@/lib/ledger/types";
import type { PlaceSuggestion } from "@/lib/weather/openmeteo";

/**
 * Destination field that only accepts a real place: suggestions come from
 * Open-Meteo's geocoding as you type, and the trip keeps the picked place's
 * coordinates (exact weather, maps and planning — "Manali" alone is also a
 * town in Tamil Nadu). Typing again clears the pick until a new one is made.
 */
export function DestinationPicker({
  value,
  place,
  onChange,
  className,
  autoSearch,
}: {
  value: string;
  place?: TripPlace;
  onChange: (destination: string, place: TripPlace | undefined) => void;
  className?: string;
  /** Show suggestions for the initial text straight away (e.g. a prefilled listing). */
  autoSearch?: boolean;
}) {
  const [results, setResults] = useState<PlaceSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const typed = useRef(!!autoSearch);
  const seq = useRef(0);
  const listId = useId();

  useEffect(() => {
    if (!typed.current || place) return;
    const q = value.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      api<{ results: PlaceSuggestion[] }>(`/api/places?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (mine !== seq.current) return; // a newer search is on its way
          setResults(r.results);
          setError(null);
          setActive(0);
          setOpen(true);
        })
        .catch(() => mine === seq.current && setError("Place search is unavailable right now — try again in a moment"))
        .finally(() => mine === seq.current && setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [value, place]);

  function pick(s: PlaceSuggestion) {
    const p: TripPlace = { lat: s.lat, lon: s.lon, name: s.name, admin: s.admin, country: s.country, source: "open-meteo-geocoding" };
    onChange(placeLabel(p), p);
    setOpen(false);
  }

  return (
    <div className="relative">
      <div className="relative">
        <input
          className={cx(className, "pr-10")}
          value={value}
          placeholder="Search a city or town, e.g. Manali"
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          onChange={(e) => {
            typed.current = true;
            onChange(e.target.value, undefined);
          }}
          onFocus={() => results.length && !place && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (!open || !results.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(results[active]);
            } else if (e.key === "Escape") setOpen(false);
          }}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
          {place ? <Icon name="check_circle" className="text-[20px] text-primary" /> : loading ? <Icon name="progress_activity" className="animate-spin text-[20px] text-on-surface-variant" /> : <Icon name="search" className="text-[20px] text-on-surface-variant" />}
        </span>
      </div>
      {open && !place ? (
        <ul id={listId} role="listbox" className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-xl bg-surface-container-lowest py-1 shadow-lg ring-1 ring-outline-variant/40">
          {results.length === 0 && !loading ? <li className="px-3.5 py-2.5 font-body-md text-body-md text-on-surface-variant">No place called “{value.trim()}” — check the spelling</li> : null}
          {results.map((s, i) => (
            <li key={`${s.lat},${s.lon}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
                onMouseEnter={() => setActive(i)}
                className={cx("flex w-full items-center gap-2.5 px-3.5 py-2 text-left", i === active ? "bg-surface-container" : "")}
              >
                <Icon name="location_on" className="text-[18px] text-primary" />
                <span className="min-w-0">
                  <span className="block truncate font-title-md text-[15px] text-on-surface">{s.name}</span>
                  <span className="block truncate font-label-sm text-label-sm text-on-surface-variant">{[s.district, s.admin, s.country].filter(Boolean).join(", ") || "—"}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="mt-1 font-label-sm text-label-sm text-error">{error}</p> : null}
      {place ? (
        <p className="mt-1 font-label-sm text-label-sm text-on-surface-variant">
          {place.lat.toFixed(3)}°, {place.lon.toFixed(3)}° · used for live weather, the map and AI planning
        </p>
      ) : value.trim() && !open ? (
        <p className="mt-1 font-label-sm text-label-sm text-on-surface-variant">Pick your destination from the list</p>
      ) : null}
    </div>
  );
}
